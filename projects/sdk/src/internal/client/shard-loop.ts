/**
 * One shard's connection loop: Discovery, gateway attempts, readiness and retries until a permanent failure.
 * Invariant: Each assigned shard has exactly one loop with its own session, sequence, heartbeat timing and backoff.
 * Startup and recovery use separate retry policies, server-required waits are respected, the loop attempts Resume
 * before a new session when the protocol permits it, and it stops on permanent failures, cancellation or SDK defects.
 * A successful Resume replays every retained dispatch after the session's sequence. Fluxer refuses the Resume with
 * INVALID_SESSION instead when it dropped a needed dispatch (the replay floor in fluxer_gateway session_lifecycle.erl at
 * fluxerapp/fluxer commit 858a2d9e2b987330edd81711bb53e4f7edc0bbcc), so guild caches survive a successful Resume and are
 * released only when the next handshake is a new session. Cached threads are the exception: Fluxer never replays
 * THREAD_LIST_SYNC, so the client drops a resumed shard's threads.
 * Implements [SDK contracts: Connection and recovery](/docs/SDK-CONTRACTS.md#connection-and-recovery)
 */
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Pull from "effect/Pull"
import * as Random from "effect/Random"
import * as Schedule from "effect/Schedule"
import type { ConnectionState } from "#sdk/client"
import {
    ClientClosedError,
    ConnectionError,
    ConnectionTimeoutError,
    RateLimitError,
    type ConnectError,
    type ConnectionFailure,
} from "#sdk/errors"
import type { MessageCore } from "#sdk/messages"
import type { SessionStore } from "#sdk/sharding"
import { nowMs } from "../clock.js"
import type { Configuration } from "../configuration.js"
import type { CountOwner } from "../counts.js"
import { failures, mapCause, mapFailureCause, withDeadline } from "../effect-failures.js"
import type { EventBus } from "../events.js"
import { primaryFault } from "../failures.js"
import { AttemptFailure, runGatewaySession, type Session } from "../gateway.js"
import { gatewayUrl, type InstanceResolver } from "../instance.js"
import type { ClientLogger, LogInput } from "../logging.js"
import type { MemberChunkOwner } from "../member-chunks.js"
import type { PresenceOwner } from "../presence.js"
import { closeActionText, closeCodeInfo, CloseCode } from "../protocol/gateway.js"
import type { SocketFactory } from "../transport/index.js"
import type { IdentifyFields, SubmitFailure } from "../gateway/commands.js"
import { checkSnapshot, usedSnapshot, type ShardPlan } from "../sharding.js"
import { backoffCeiling, retryDelay, stayedHealthy } from "./backoff.js"
import { invalidateDispatch, shardIntake, type ClientCaches } from "./intake.js"
import { formatDuration } from "./lifetime.js"
import { emitObservation } from "../observer.js"
import { retryableConnection } from "../retryable-connection.js"

/** Observable per-shard state, owned by the client and updated by this loop */
export interface ShardRuntime {
    readonly shardId: number
    state: ConnectionState
    latency: number | null
    recovery: { phase: "startup" | "recovery"; attempt: number; retryDelayMs: number | null } | null
    session: Session
    /** Paced gateway.send path of the current ready session, or undefined while the shard is not ready */
    submit: ((op: number, d: unknown, sent?: () => void) => Effect.Effect<void, SubmitFailure>) | undefined
    /** Gateway URL this shard's sessions use, known after discovery and recorded in saved session snapshots */
    gatewayUrl: string | undefined
    /** The client-wide number of this shard's current session, assigned at each READY that starts a new session */
    sessionEpoch: number
}

/** What the shard loop needs from its client */
export interface ShardLoopHost<M extends MessageCore> {
    readonly logging: ClientLogger
    readonly instance: InstanceResolver
    readonly caches: ClientCaches<M>
    readonly events: EventBus<M>
    readonly presence: PresenceOwner
    readonly counts: CountOwner
    readonly memberChunks: MemberChunkOwner
    readonly sockets: SocketFactory
    /** The client's aggregate state */
    readonly state: () => ConnectionState
    /** Record a shard transition and recompute the client state */
    readonly setShardState: (shard: ShardRuntime, state: ConnectionState) => void
    /** Release a shard's guild-scoped cache entries once an established or restored session needs a new session, and
     * again when each new session's READY is accepted, including the first, because partial replay and reads stored
     * before it, during an outage or before connecting, may be stale and pending reads must not store them. It runs
     * before the frames after READY, which carry the communities that refill the caches
     */
    readonly newSession?: (shardId: number) => void
    /** The next client-wide session number, which never repeats within the client */
    readonly nextSessionEpoch: () => number
    /** Pace a fresh Identify for this shard, or undefined when Identify needs no coordination */
    readonly identify: ((shardId: number, send: () => void) => Effect.Effect<void, AttemptFailure>) | undefined
    /** Optional Identify fields, computed when this shard sends Identify */
    readonly identifyFields: (shardId: number) => IdentifyFields
    /** Configured session persistence, loaded once at the first attempt */
    readonly sessions: SessionStore | undefined
    /** Whether shutdown will save this shard's session after its socket closes */
    readonly saveSessionOnClose: (shardId: number) => boolean
    /** Observe each accepted READY body, which carries the bot's own user and the shard's communities */
    readonly readyUser?: (body: unknown, shardId: number) => void
    /**
     * Offer a 4011 (sharding required) closure to automatic sharding. True means the client moves every shard to a
     * larger plan, so this loop ends without logging a permanent failure. A string explains why it does not
     */
    readonly reshard?: (shardId: number) => true | string
    /** Note that this shard resumed a session loaded from the session store, so its guild caches start empty */
    readonly restored?: (shardId: number) => void
    /** Note that this shard resumed a session, after Fluxer replayed the missed dispatches it retained */
    readonly resumed?: (shardId: number) => void
}

/** One loop's inputs */
export interface ShardLoopOptions<M extends MessageCore> {
    readonly host: ShardLoopHost<M>
    readonly configuration: Configuration<M>
    /** Completed once every assigned shard is ready */
    readonly startup: Deferred.Deferred<void, ConnectError>
    readonly shard: ShardRuntime
    /** The client's known shard plan */
    readonly plan: ShardPlan
    /** Logical group startup deadline, including Identify waits */
    readonly deadline: number
    /** The group's startup budget that the deadline was derived from, reported when startup times out */
    readonly startupTimeoutMs: number
    /** Whether the group was ready before this loop started, as after a move to a larger plan, so failures recover */
    readonly established?: boolean
    /** Whether to offer the session store's snapshot, default true. A move to a larger plan starts new sessions */
    readonly loadSessions?: boolean
}

/** Time allowed for one session store call at startup */
const sessionStoreTimeoutMs = 5_000

/** Server protocol anomalies in a row, without a healthy connection between them, after which a shard stops retrying */
const protocolFailureLimit = 3

/** What went wrong in a failed connection stage, before its facts */
const connectionTexts = {
    gateway: {
        network: "The gateway connection failed",
        protocol: "The gateway sent data that the SDK cannot accept",
        closed: "The gateway connection closed",
    },
    discovery: {
        network: "The request for Fluxer's instance information failed",
        protocol: "Fluxer's instance information was invalid",
        closed: "The client closed while it read Fluxer's instance information",
    },
} as const

/** The gateway close code that ended an attempt, from the closure or from a gateway connection error */
function attemptCloseCode(failure: AttemptFailure): number | undefined {
    const error = failure.failure
    return (
        failure.closeCode ??
        (error instanceof ConnectionError && error.phase === "gateway" ? (error.status ?? undefined) : undefined)
    )
}

/** Readable reason for an ended connection attempt as one sentence, including a close code's reviewed meaning */
function attemptExplanation(failure: AttemptFailure): string {
    const error = failure.failure
    if (failure.end === "heartbeatTimeout") return "The gateway did not acknowledge a heartbeat in time"
    if (failure.end === "reconnectRequested") return "The gateway asked the SDK to reconnect"
    if (failure.end === "invalidSession") return "The gateway invalidated the session"
    const closeCode = attemptCloseCode(failure)
    if (closeCode !== undefined) {
        const info = closeCodeInfo(closeCode)
        return `Close code ${closeCode} (${info.name}): ${info.meaning}`
    }
    if (error instanceof ConnectionError) {
        const detail = error.details.detail
        const code = error.details.transportCode
        const facts = [
            typeof detail === "string" ? detail : undefined,
            typeof code === "string" ? code : undefined,
            error.phase === "discovery" && error.status !== null ? `HTTP ${error.status}` : undefined,
        ].filter((fact) => fact !== undefined)
        return `${connectionTexts[error.phase][error.reason]}${facts.length ? ` (${facts.join(", ")})` : ""}`
    }
    if (error instanceof ConnectionTimeoutError)
        return `The connection attempt did not finish within ${formatDuration(error.timeoutMs)}`
    if (error instanceof RateLimitError)
        return error.source === "gateway"
            ? "Fluxer's gateway rate-limited the connection"
            : "Fluxer rate-limited the request for its instance information"
    return error.message.replace(/\.$/, "")
}

function closeFields(failure: AttemptFailure): { closeCode?: number } {
    const closeCode = attemptCloseCode(failure)
    return closeCode === undefined ? {} : { closeCode }
}

/** The handshake of the next attempt after a retryable failure: Resume with a retained session and sequence, otherwise
 * Identify for a new session. Call it after any session reset, so it follows the attempt the loop will actually make
 */
function nextHandshake(failure: AttemptFailure, session: Session): "resume" | "identify" {
    return !failure.resetSession && session.id !== undefined && session.sequence !== null ? "resume" : "identify"
}

/** Readable next step after a retryable failure as one sentence, following the handshake that nextHandshake reports */
function nextAction(failure: AttemptFailure, session: Session, delayMs: number, established: boolean): string {
    const resume = nextHandshake(failure, session) === "resume"
    // A rate-limit close and a rate-limited discovery request both arrive as RateLimitError, and the delay covers the wait.
    // This path always retries, so only the rate-limit wait changes the wording besides Resume or a new session
    const rateLimited = failure.failure instanceof RateLimitError
    return closeActionText(rateLimited, resume, formatDuration(delayMs), established)
}

/** Whether a discovery failure is worth another attempt */
function retryableDiscovery(error: unknown): boolean {
    return error instanceof RateLimitError || (error instanceof ConnectionError && retryableConnection(error))
}

/** Run one shard until its connection fails permanently. The loop never succeeds */
export function runShardLoop<M extends MessageCore>(options: ShardLoopOptions<M>) {
    const { host, configuration, startup, shard, plan, deadline, startupTimeoutMs } = options
    const recovery = configuration.recovery
    return Effect.gen(function* () {
        const fiber = yield* Effect.withFiber((fiber) => Effect.succeed(fiber))
        const logger = host.logging
        const log = (input: Omit<LogInput, "shardId" | "category"> & { readonly category?: LogInput["category"] }) =>
            logger.log({ category: "lifecycle", ...input, shardId: shard.shardId }, fiber.context)
        const clock = yield* Clock.Clock
        const now = () => nowMs(clock)
        const intake = shardIntake(host.caches)
        let established = options.established ?? false
        /** Whether startup has used a saved session, until readiness, including a fallback after partial replay */
        let restoredSession = false
        let attempts = 0
        let recoveryStep = 0
        /** Consecutive attempts that ended with a server protocol anomaly */
        let protocolFailures = 0
        let connectedAt: number | undefined
        let disconnectedAt: number | undefined
        let url: string | undefined
        let inviteBase: string | undefined
        let sessionsLoaded = host.sessions === undefined || options.loadSessions === false
        /** Native recovery schedule step, restarted whenever the recovery sequence restarts */
        let scheduleStep:
            | ((now: number, input: ConnectionFailure) => Pull.Pull<[unknown, Duration.Duration], never, unknown>)
            | undefined
        /** The native schedule's next recovery delay for this failure, or undefined once the schedule has completed */
        const scheduledDelay = (schedule: NonNullable<typeof recovery.schedule>, failure: ConnectionFailure) =>
            Effect.gen(function* () {
                scheduleStep ??= yield* Schedule.toStep(schedule)
                return yield* scheduleStep(yield* Clock.currentTimeMillis, failure).pipe(
                    Effect.map(([, duration]): number | undefined => Duration.toMillis(duration)),
                    Pull.catchDone(() => Effect.succeed(undefined)),
                )
            })
        // A store failure is logged in full and never fails startup: The shard then starts a new session
        const storeCall = <A>(
            operation: "load" | "save",
            run: () => Promise<A>,
            code: "lifecycle.sessionLoadFailed" | "lifecycle.sessionSaveFailed",
            message: string,
        ) => {
            const budgetMs = Math.max(1, Math.min(sessionStoreTimeoutMs, deadline - now()))
            // @effect-diagnostics-next-line unknownInEffectCatch:off
            return Effect.tryPromise({ try: () => Promise.resolve(run()), catch: (error) => error }).pipe(
                Effect.timeoutOrElse({
                    duration: budgetMs,
                    orElse: () =>
                        Effect.fail(
                            // @effect-diagnostics-next-line globalErrorInEffectFailure:off
                            new Error(
                                `The session store's ${operation} did not finish within ${formatDuration(budgetMs)}`,
                            ),
                        ),
                }),
                Effect.map((value) => ({ value })),
                Effect.catch((error) =>
                    Effect.sync(() => {
                        log({ level: "error", code, message, error, origin: "application" })
                        return undefined
                    }),
                ),
            )
        }
        const loadSession = (gatewayUrl: string) =>
            Effect.gen(function* () {
                sessionsLoaded = true
                const loaded = yield* storeCall(
                    "load",
                    () => host.sessions!.load(shard.shardId),
                    "lifecycle.sessionLoadFailed",
                    `Shard ${shard.shardId} could not load its saved session, so it starts a new session`,
                )
                if (loaded === undefined || loaded.value === undefined) return
                const checked = checkSnapshot(loaded.value, gatewayUrl, plan.totalShards, Date.now())
                if ("problem" in checked) {
                    log({
                        level: "warn",
                        code: "lifecycle.sessionSnapshotIgnored",
                        message: `Shard ${shard.shardId} ignored its saved session because ${checked.problem}, so it starts a new session`,
                    })
                    return
                }
                // Fluxer replays every dispatch after the saved sequence, so a second Resume of this snapshot after a crash
                // would repeat the dispatches this process handles. Only the next shutdown saves a resumable session again
                const used = yield* storeCall(
                    "save",
                    () => host.sessions!.save(shard.shardId, usedSnapshot(checked.snapshot)),
                    "lifecycle.sessionSaveFailed",
                    `Shard ${shard.shardId} could not mark its saved session as used, so it starts a new session`,
                )
                if (used === undefined) return
                shard.session = { id: checked.snapshot.sessionId, sequence: checked.snapshot.sequence }
                restoredSession = true
                log({
                    level: "info",
                    code: "lifecycle.sessionRestored",
                    message: `Shard ${shard.shardId} is resuming the session saved ${formatDuration(Date.now() - checked.snapshot.savedAt)} ago`,
                })
            })
        while (true) {
            attempts += 1
            const phase = established ? "recovery" : "startup"
            const attemptStartedAt = now()
            shard.recovery = { phase, attempt: attempts, retryDelayMs: null }
            if (established) {
                logger.count("reconnects")
                emitObservation(logger, { type: "reconnect", shardId: shard.shardId })
            }
            const budget = established ? recovery.attemptTimeoutMs : Math.max(0, deadline - now())
            const attempt = Effect.gen(function* () {
                const attemptDeadline = now() + budget
                if (!url) {
                    const endpoint = yield* host.instance.resolve().pipe(
                        mapFailureCause(
                            failures(ConnectionError, RateLimitError, ClientClosedError),
                            (error) =>
                                new AttemptFailure(
                                    error instanceof ClientClosedError
                                        ? new ConnectionError("discovery", "closed")
                                        : error,
                                    retryableDiscovery(error),
                                ),
                        ),
                        withDeadline(budget, () => new AttemptFailure(new ConnectionTimeoutError(budget), true)),
                    )
                    url = gatewayUrl(endpoint.gateway)
                    inviteBase = endpoint.invite
                    shard.gatewayUrl = url
                }
                if (!sessionsLoaded) yield* loadSession(url)
                const mode = shard.session.id !== undefined && shard.session.sequence !== null ? "resume" : "identify"
                log({
                    level: "debug",
                    code: "lifecycle.attempt",
                    message: `Shard ${shard.shardId} is connecting (${mode === "resume" ? "resuming its session" : "new session"})`,
                    attempt: attempts,
                    fields: { phase, mode },
                })
                return yield* runGatewaySession({
                    messageDecoder: configuration.decodeGatewayMessage,
                    url,
                    token: configuration.token,
                    session: shard.session,
                    timeoutMs: Math.max(0, attemptDeadline - now()),
                    onReady: (readyMode) => {
                        const connectedAtMs = now()
                        const outage = disconnectedAt === undefined ? undefined : connectedAtMs - disconnectedAt
                        if (readyMode === "resume") {
                            logger.count("resumes")
                            emitObservation(logger, {
                                type: "resume",
                                shardId: shard.shardId,
                                ...(outage === undefined ? {} : { outageMs: Math.round(outage) }),
                            })
                        }
                        log({
                            level: "info",
                            code: "lifecycle.ready",
                            message:
                                readyMode === "resume"
                                    ? `Shard ${shard.shardId} resumed its session${outage === undefined ? "" : ` after ${formatDuration(outage)} offline`}`
                                    : `Shard ${shard.shardId} is ready${established ? " with a new session" : ""}`,
                            durationMs: Math.round(connectedAtMs - attemptStartedAt),
                            attempt: attempts,
                            fields: { mode: readyMode, shards: plan.totalShards },
                        })
                        if (readyMode === "resume") host.resumed?.(shard.shardId)
                        if (readyMode === "resume" && restoredSession) host.restored?.(shard.shardId)
                        restoredSession = false
                        established = true
                        connectedAt = connectedAtMs
                        disconnectedAt = undefined
                        shard.recovery = null
                        host.setShardState(shard, "Connected")
                        if (host.state() === "Connected") Deferred.doneUnsafe(startup, Effect.void)
                    },
                    // Runs on the socket's turn when READY is accepted, so the communities Fluxer sends right after it
                    // refill the caches this releases. REST reads stored or pending during an outage or before connecting
                    // may be stale, and a new session replays nothing
                    onSessionStart: () => {
                        shard.sessionEpoch = host.nextSessionEpoch()
                        host.newSession?.(shard.shardId)
                    },
                    onLatency: (latency) => {
                        shard.latency = latency
                    },
                    onRecovering: () => {
                        disconnectedAt ??= now()
                        host.setShardState(shard, "Recovering")
                    },
                    onDispatch: (event, message, bytes) => {
                        const previous = intake.event(event, message)
                        host.events.offer(event, message, bytes, shard.shardId, shard.sessionEpoch, previous)
                    },
                    onRaw: (t, s, d, bytes) => {
                        // READY is session control and never reaches the dispatch table, so its user is taken here
                        if (t === "READY") host.readyUser?.(d, shard.shardId)
                        // Build nothing unless a raw subscriber exists. Raw bodies are not part of the SDK contract
                        if (!host.events.hasSources("raw")) return
                        if (logger.enabled("trace", "events"))
                            logger.log({
                                level: "trace",
                                category: "events",
                                code: "events.raw",
                                message: `Delivering raw ${t} dispatch`,
                                shardId: shard.shardId,
                                fields: { dispatch: t, sequence: s, bytes },
                            })
                        host.events.offer(
                            "raw",
                            Object.freeze({ shardId: shard.shardId, t, s, d }),
                            bytes,
                            shard.shardId,
                            shard.sessionEpoch,
                        )
                    },
                    identifyFields: () => host.identifyFields(shard.shardId),
                    application: {
                        attach: (submit) => {
                            shard.submit = submit
                        },
                        detach: () => {
                            shard.submit = undefined
                        },
                    },
                    onGuild: intake.guild,
                    presence: {
                        attach: (send, members, mode) => host.presence.attach(send, members, mode, shard.shardId),
                        detach: () => host.presence.detach(shard.shardId),
                        guildCreate: (guildId) => host.presence.guildCreate(guildId),
                    },
                    counts: {
                        attach: (guilds, channels) => host.counts.attach(guilds, channels, shard.shardId),
                        detach: () => host.counts.detach(shard.shardId),
                        receiveGuildCounts: (value) => host.counts.receiveGuildCounts(value),
                        receiveChannelMemberCounts: (value) => host.counts.receiveChannelMemberCounts(value),
                    },
                    memberChunks: {
                        attach: (send) => host.memberChunks.attach(send, shard.shardId),
                        detach: () => host.memberChunks.detach(shard.shardId),
                        receive: (value, bytes) => host.memberChunks.receive(value, bytes),
                        rateLimited: (value) => host.memberChunks.rateLimited(value),
                    },
                    shard: plan.identifyShards ? [shard.shardId, plan.totalShards] : undefined,
                    identify: host.identify && ((send) => host.identify!(shard.shardId, send)),
                    inviteBase,
                    observer: {
                        logger,
                        shardId: shard.shardId,
                        onMalformedDispatch: configuration.onMalformedDispatch,
                        invalidate: (type, body) => invalidateDispatch(host.caches, type, body),
                    },
                    sockets: host.sockets,
                    preserveSessionOnInterrupt: () => host.saveSessionOnClose(shard.shardId),
                })
            })
            const result = yield* Effect.uninterruptibleMask((restore) =>
                Effect.exit(restore(attempt)).pipe(
                    Effect.flatMap((result) => {
                        // Translate even when caller interruption is pending, without exposing AttemptFailure
                        if (
                            Exit.isFailure(result) &&
                            (Cause.hasDies(result.cause) || Cause.hasInterrupts(result.cause))
                        ) {
                            const mapped = mapCause(
                                result.cause,
                                failures(AttemptFailure),
                                (failure) => failure.failure,
                            )
                            if (Cause.hasDies(result.cause))
                                log({
                                    level: "error",
                                    code: "lifecycle.connectionEnded",
                                    message: `Shard ${shard.shardId} stopped because of an unexpected SDK fault`,
                                    error: primaryFault(mapped),
                                    cause: mapped,
                                })
                            return Effect.failCause(mapped)
                        }
                        return Effect.succeed(result)
                    }),
                ),
            )
            if (Exit.isSuccess(result)) return yield* Effect.die(new Error("Gateway lifetime ended without an outcome"))
            const reason = result.cause.reasons.find((reason) => reason._tag === "Fail")
            if (reason?._tag !== "Fail") return yield* Effect.die(new Error("Gateway failure had no reason"))
            const failure = reason.error
            const lost = established && connectedAt !== undefined
            const outcome = `Shard ${shard.shardId} ${lost ? "lost its connection" : "could not connect"}. ${attemptExplanation(failure)}`
            if (failure.resetSession) {
                shard.session = { id: undefined, sequence: null }
                log({
                    level: "warn",
                    code: "lifecycle.sessionReset",
                    message: `Shard ${shard.shardId}'s session can no longer be resumed, so its next connection starts a new session`,
                    fields: { reason: failure.end },
                })
            }
            if ((established || restoredSession) && nextHandshake(failure, shard.session) === "identify")
                host.newSession?.(shard.shardId)
            // A connection that stayed healthy between anomalies starts the count again
            if (
                connectedAt !== undefined &&
                stayedHealthy(connectedAt, disconnectedAt ?? now(), recovery.healthyResetMs)
            )
                protocolFailures = 0
            if (failure.end === "protocol") protocolFailures += 1
            const protocolLimited = failure.retry && protocolFailures >= protocolFailureLimit
            const reported =
                !established && failure.failure instanceof ConnectionTimeoutError
                    ? new ConnectionTimeoutError(startupTimeoutMs)
                    : failure.failure
            const classification =
                failure.failure instanceof ConnectionError ? failure.failure.reason : failure.failure._tag
            if (!failure.retry || protocolLimited || (!established && attempts >= configuration.maxStartupAttempts)) {
                shard.recovery = null
                // Automatic sharding answers sharding required with a larger plan, which the client logs itself
                const reshard =
                    !failure.retry && closeFields(failure).closeCode === CloseCode.shardingRequired
                        ? host.reshard?.(shard.shardId)
                        : undefined
                if (reshard === true) return yield* Effect.fail(reported)
                log({
                    level: "error",
                    code: "lifecycle.connectionEnded",
                    message: `${outcome}. ${protocolLimited ? `The SDK stops retrying after ${protocolFailures} connections in a row ended with invalid gateway data` : failure.retry ? `The SDK stops retrying after ${attempts} attempts (connection.maxStartupAttempts)` : reshard === undefined ? "The SDK does not retry this failure" : `Automatic sharding does not move to a larger plan, because ${reshard}`}`,
                    attempt: attempts,
                    ...closeFields(failure),
                    fields: { reason: failure.end, classification },
                    error: reported,
                })
                return yield* Effect.fail(reported)
            }
            if (established) {
                host.setShardState(shard, "Recovering")
                if (
                    connectedAt !== undefined &&
                    stayedHealthy(connectedAt, disconnectedAt ?? now(), recovery.healthyResetMs)
                ) {
                    recoveryStep = 0
                    scheduleStep = undefined
                }
                connectedAt = undefined
            }
            const requiredWait = failure.failure instanceof RateLimitError ? (failure.failure.retryAfterMs ?? 0) : 0
            let delay: number
            if (established && recovery.schedule) {
                // The native schedule decides each recovery delay from the failure, and its completion ends recovery
                const decided = yield* scheduledDelay(recovery.schedule, failure.failure)
                if (decided === undefined) {
                    shard.recovery = null
                    log({
                        level: "error",
                        code: "lifecycle.connectionEnded",
                        message: `${outcome}. The recovery schedule (connection.recovery.schedule) ended, so the SDK stops retrying`,
                        attempt: attempts,
                        ...closeFields(failure),
                        fields: { reason: failure.end, classification },
                        error: reported,
                    })
                    return yield* Effect.fail(reported)
                }
                delay = Math.max(decided, requiredWait)
            } else {
                const ceiling = established ? backoffCeiling(recoveryStep++, recovery) : backoffCeiling(attempts - 1)
                delay = retryDelay(ceiling, yield* Random.next, requiredWait)
            }
            if (!established && delay >= deadline - now()) {
                const ended = requiredWait > 0 ? failure.failure : new ConnectionTimeoutError(startupTimeoutMs)
                log({
                    level: "error",
                    code: "lifecycle.connectionEnded",
                    message: `${outcome}. The startup deadline of ${formatDuration(startupTimeoutMs)} leaves no time for another attempt`,
                    attempt: attempts,
                    ...closeFields(failure),
                    fields: { reason: failure.end, classification },
                    error: ended,
                })
                return yield* Effect.fail(ended)
            }
            log({
                level: "warn",
                code: lost ? "lifecycle.connectionLost" : "lifecycle.retry",
                message: `${outcome}. ${nextAction(failure, shard.session, delay, established)}`,
                attempt: attempts,
                delayMs: Math.round(delay),
                ...closeFields(failure),
                fields: { reason: failure.end, classification, next: nextHandshake(failure, shard.session) },
            })
            shard.recovery = { phase: established ? "recovery" : "startup", attempt: attempts, retryDelayMs: delay }
            yield* Effect.sleep(delay)
        }
    })
}
