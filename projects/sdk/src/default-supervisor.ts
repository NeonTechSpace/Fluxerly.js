import { causeReasons, defectReason, inputDefect, readCaller, readInput, suspendMarked } from "#sdk/internal/defects"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { err, ok, ResultAsync, type Result } from "neverthrow"
import type { ClientOptions } from "#sdk/client"
import type { SessionStore } from "#sdk/sharding"
import {
    ApplicationError,
    CancelledError,
    ConfigurationError,
    SdkDefect,
    type ConnectError,
    type DefectReason,
} from "#sdk/errors"
import { attachAccountLimits, attachIdentifyGate } from "#sdk/internal/client"
import { throwIfErr } from "#sdk/internal/failures"
import { operationSignalError } from "#sdk/internal/operation-signal"
import {
    ChildBridge,
    childFailureReason,
    createSupervisor,
    supervisorOptionError,
    type SupervisorOwner,
} from "#sdk/internal/supervisor"
import { childClientOptionsError } from "#sdk/internal/configuration"
import {
    SupervisorChildError,
    type SupervisorAssignment,
    type SupervisorChildOptions,
    SupervisorError,
    type SupervisorOptions,
    type SupervisorStatus,
    type SupervisorWaitOptions,
} from "#sdk/supervisor"
import type { Client } from "./index.js"

/**
 * Client and fixed shard assignment available to configure before the helper starts the gateway connection
 *
 * @category Sharding and supervision
 */
export interface DefaultSupervisorChildContext {
    /** Client created and owned by child.run. Register application behavior here rather than starting or stopping this client */
    readonly client: Client
    /** Fixed assignment for this child process. It cannot be changed during this run */
    readonly assignment: SupervisorAssignment
    /** Signal aborted when the parent requests shutdown or its message channel disconnects.
     * Setup work should check this signal and stop when it is aborted. The helper cannot forcibly cancel a JavaScript promise
     */
    readonly signal: AbortSignal
}

/**
 * Bot credentials, client settings and setup callback for a JavaScript module launched by a supervisor.
 * Unknown option keys fail with ConfigurationError before waiting for the parent, with a suggested name when one is close
 *
 * @category Sharding and supervision
 */
export interface DefaultSupervisorChildOptions extends SupervisorChildOptions {
    /** Register subscriptions and local application behavior before the helper calls client.run.
     * Return when setup is finished, not when the bot stops. Do not call client.run, connect or shutdown here.
     * A thrown error, rejected promise or returned Err rejects child.run with SdkDefect code application.defect, whose
     * cause is an ApplicationError with source "supervisor child configure" and the original value as its cause.
     * A parent stop can finish child.run without waiting for this promise. Setup must check context.signal to avoid continuing afterward
     */
    readonly configure: (context: DefaultSupervisorChildContext) => unknown
}

/**
 * Parent that starts and stops child processes for one fixed set of local shards.
 * Methods start their asynchronous work when called and return ResultAsync for expected failures.
 * Unexpected defects reject with SdkDefect instead of returning Err, and a throwing waitForReady option or signal getter
 * uses code application.defect with the thrown value as its cause.
 * Creating this parent starts no child. Call shutdown to release its owned processes
 *
 * @category Sharding and supervision
 */
export interface DefaultSupervisor {
    /** Start the configured children and return Ok when each child accepts its shard assignment and finishes configure.
     * This is setup completion, not gateway readiness. Use waitForReady to observe connected gateway sessions.
     * Concurrent calls share startup. Calling again does not create extra children or await replacement startup.
     * Failure returns SupervisorError only after owned processes exit. Start during or after shutdown returns reason closed.
     * With totalShards "auto" it first counts the bot's communities, and a failed count returns reason shardCount.
     * If a child remains alive after losing its message channel for shutdownTimeoutMs, pending startup fails with closed after cleanup
     */
    start(): ResultAsync<void, SupervisorError>
    /** Wait until the supervisor's lifetime ends and its owned child processes have exited.
     * Returns Ok after normal shutdown or Err with the retained SupervisorError after failure, even on a later call.
     * Does not start or stop the supervisor. Calling before start waits until a later shutdown or failure
     */
    waitForClose(): ResultAsync<void, SupervisorError>
    /** Return Ok when every current child has reported its aggregate gateway state as Connected.
     * Start the supervisor first. This observes reports, not simultaneous cross-process health or lasting readiness.
     * Losing a child's message channel clears its readiness immediately. A later call waits for current readiness again.
     * A signal returns CancelledError only for this wait and never stops or restarts a child.
     * An already-aborted signal takes precedence even when the children are ready.
     * A malformed signal returns ConfigurationError with field signal without starting observation.
     * Unknown option keys return ConfigurationError before observation, with a suggested name when one is close.
     * An idle, stopping or closed supervisor returns SupervisorError with reason closed. A failed supervisor returns its retained failure
     */
    waitForReady(
        options?: SupervisorWaitOptions,
    ): ResultAsync<void, SupervisorError | CancelledError | ConfigurationError>
    /** Return one immutable safe local status snapshot without child output, environment, arguments or paths */
    status(): SupervisorStatus
    /** Ask owned children to stop and return Ok only after their processes exit.
     * After shutdownTimeoutMs, force-terminate an owned child that has not exited, then keep waiting for its exit.
     * Concurrent and repeated calls share cleanup. Shutdown before start closes the parent without launching children.
     * Returns Ok even after a supervisor failure or a child's message-channel loss. It does not erase waitForClose's retained failure
     */
    shutdown(): ResultAsync<void, never>
}

/**
 * Create a local parent supervisor or run its child module using the default API
 *
 * @category Sharding and supervision
 */
export interface DefaultSupervisorTools {
    /** Validate and copy options now and return an idle supervisor. Invalid options throw ConfigurationError.
     * Unknown keys in parent, assignment, restart and Identify options include a suggested name when one is close.
     * Each option is read once. A throwing option getter throws SdkDefect with code application.defect and the thrown
     * value as its cause, while another unexpected fault uses sdk.defect.
     * Does not start a process or check whether the entry module can execute. Launch failures are reported by start
     */
    create(options: SupervisorOptions): DefaultSupervisor
    /** Child-module helper. Call run inside the module selected by the parent's entry option */
    readonly child: {
        /** Receive the parent's assignment, create a client, finish configure, then run the client until stop or failure.
         * Owns client shutdown and removal of parent-message listeners before returning its result.
         * A normal parent stop drains running handlers, queued handler events and REST requests for the parent's drain allowance before returning Ok.
         * Failure stops the client without draining. Running outside a connected supervisor child returns SupervisorChildError with reason disconnected.
         * Unknown child option keys return ConfigurationError before waiting for IPC, with a suggested name when one is close.
         * Invalid client settings return ConfigurationError. Client execution can return ConnectError or CancelledError.
         * Message-channel loss or invalid coordination data returns SupervisorChildError.
         * A stop during configure never starts the client afterward.
         * The helper cannot forcibly stop a configure promise that ignores cancellation and does not wait for it.
         * The options are read once before waiting for the assignment, and a throwing option getter rejects with
         * SdkDefect code application.defect and the thrown value as its cause.
         * Defects reject with SdkDefect, retaining accompanying typed failures without private error text
         */
        run(
            options: DefaultSupervisorChildOptions,
        ): ResultAsync<void, ConfigurationError | ConnectError | CancelledError | SupervisorChildError>
    }
}

function resultFromExit<A, E>(
    exit: Exit.Exit<A, E>,
    operation:
        | "supervisor.create"
        | "supervisor.start"
        | "supervisor.waitForClose"
        | "supervisor.waitForReady"
        | "supervisor.shutdown"
        | "supervisor.child.run",
): Result<A, E> {
    if (Exit.isSuccess(exit)) return ok(exit.value)
    if (Cause.hasDies(exit.cause) || Cause.hasInterrupts(exit.cause)) {
        throw new SdkDefect(operation, causeReasons(exit.cause))
    }
    const reason = exit.cause.reasons.find((reason) => reason._tag === "Fail")
    if (reason?._tag === "Fail") return err(reason.error)
    throw new SdkDefect(operation, causeReasons(exit.cause))
}

function defectReasons(error: unknown): DefectReason[] {
    if (error instanceof SdkDefect && error.reasons.length > 0) return [...error.reasons]
    return [defectReason(error)]
}

function bridgeResult<A>(effect: Effect.Effect<A, SupervisorChildError>): Promise<Result<A, SupervisorChildError>> {
    return Effect.runPromiseExit(effect).then((exit) => resultFromExit(exit, "supervisor.child.run"))
}

function readyResult(owner: SupervisorOwner, options?: SupervisorWaitOptions) {
    // Reading the caller options and calling the caller signal are marked as application input
    const readiness = suspendMarked((): Effect.Effect<void, SupervisorError | CancelledError | ConfigurationError> => {
        const invalidOptions =
            options === undefined
                ? undefined
                : readCaller(() =>
                      supervisorOptionError(options, ["signal"], "configuration", "Supervisor readiness options"),
                  )
        if (invalidOptions) return Effect.fail(invalidOptions)
        const signal = readCaller(() => options?.signal)
        const invalidSignal = readCaller(() => operationSignalError(signal))
        if (invalidSignal) return Effect.fail(invalidSignal)
        if (readCaller(() => signal?.aborted)) return Effect.fail(new CancelledError("supervisor.waitForReady"))
        if (!signal) return owner.waitForReady()
        const cancelled = Effect.callback<never, CancelledError>((resume) => {
            const abort = () => resume(Effect.fail(new CancelledError("supervisor.waitForReady")))
            try {
                signal.addEventListener("abort", abort, { once: true })
            } catch (error) {
                resume(Effect.failCause(inputDefect(error)))
            }
            return readInput(() => signal.removeEventListener("abort", abort))
        })
        return Effect.raceFirst(owner.waitForReady(), cancelled)
    })
    return new ResultAsync<void, SupervisorError | CancelledError | ConfigurationError>(
        Effect.runPromiseExit(readiness).then((exit) => resultFromExit(exit, "supervisor.waitForReady")),
    )
}

/** Child options read once before the helper waits for an assignment */
interface ChildSettings {
    readonly clientOptions: Omit<ClientOptions, "token" | "sharding">
    /** The child's session store, added to the shards the parent assigns */
    readonly sessions: SessionStore | undefined
    readonly token: string | undefined
    readonly configure: DefaultSupervisorChildOptions["configure"]
}

/**
 * Read the child options once, so later getter changes cannot alter the client or configure callback. A throw here comes
 * from reading the caller options
 */
function readChildOptions(options: DefaultSupervisorChildOptions): ChildSettings | ConfigurationError {
    const invalidOptions = supervisorOptionError(
        options,
        ["token", "clientOptions", "configure"],
        "configuration",
        "Supervisor child options",
    )
    if (invalidOptions) return invalidOptions
    const clientOptions = options.clientOptions
    const invalid = childClientOptionsError(clientOptions)
    if (invalid) return invalid
    const {
        messageFields,
        instance,
        rest,
        transport,
        uploads,
        logging,
        onError,
        gateway,
        cache,
        connection,
        observe,
        sharding,
    } = clientOptions ?? {}
    const configure = options.configure
    return {
        sessions: sharding?.sessions,
        clientOptions: {
            ...(messageFields === undefined ? {} : { messageFields }),
            ...(instance === undefined ? {} : { instance }),
            ...(rest === undefined ? {} : { rest }),
            ...(transport === undefined ? {} : { transport }),
            ...(uploads === undefined ? {} : { uploads }),
            ...(logging === undefined ? {} : { logging }),
            ...(onError === undefined ? {} : { onError }),
            ...(gateway === undefined ? {} : { gateway }),
            ...(cache === undefined ? {} : { cache }),
            ...(connection === undefined ? {} : { connection }),
            ...(observe === undefined ? {} : { observe }),
        },
        token: options.token,
        // Keep the options object as the receiver, as a method call on it would
        configure: (context) => Reflect.apply(configure, options, [context]),
    }
}

function childClientOptions(
    settings: ChildSettings,
    assignment: SupervisorAssignment,
    bridge: ChildBridge,
): ClientOptions {
    const sharding = settings.sessions === undefined ? assignment : { ...assignment, sessions: settings.sessions }
    return attachAccountLimits(
        attachIdentifyGate({ ...settings.clientOptions, token: settings.token, sharding }, bridge.identifyGate),
        bridge.accountLimits,
    )
}

/** Build default-API supervisor tools around this entry point's client creator */
export function makeDefaultSupervisor(createClient: (options: ClientOptions) => Client): DefaultSupervisorTools {
    const child = Object.freeze({
        run: (options: DefaultSupervisorChildOptions) =>
            new ResultAsync<void, ConfigurationError | ConnectError | CancelledError | SupervisorChildError>(
                (async () => {
                    let bridge: ChildBridge | undefined
                    let client: Client | undefined
                    let stateObserver: { close(): void } | undefined
                    let shutdownAttempted = false
                    let outcome: Result<
                        void,
                        ConfigurationError | ConnectError | CancelledError | SupervisorChildError
                    > = ok(undefined)
                    let running:
                        | Promise<
                              | {
                                    readonly kind: "client"
                                    readonly result: Result<void, ConnectError | CancelledError | ConfigurationError>
                                }
                              | { readonly kind: "defect"; readonly reasons: readonly DefectReason[] }
                          >
                        | undefined
                    const defects: DefectReason[] = []
                    // A stop the parent requested lets running work finish, while any other end stops at once
                    let stopRequested = false
                    const shutdownClient = async () => {
                        if (!client || shutdownAttempted) return
                        shutdownAttempted = true
                        const drainMs = stopRequested ? bridge!.drainMs : 0
                        await client.shutdown(drainMs > 0 ? { drainMs } : undefined)
                    }
                    try {
                        main: {
                            let settings: ChildSettings
                            try {
                                const read = readChildOptions(options)
                                if (read instanceof ConfigurationError) {
                                    outcome = err(read)
                                    break main
                                }
                                settings = read
                            } catch (error) {
                                // Only the caller option reads run here, so a throw is an application fault
                                defects.push(defectReason(error, "application"))
                                break main
                            }
                            const opened = await bridgeResult(ChildBridge.open())
                            if (opened.isErr()) {
                                outcome = err(opened.error)
                                break main
                            }
                            bridge = opened.value
                            const initial = await bridgeResult(
                                Effect.raceFirst(
                                    bridge
                                        .waitForAssignment()
                                        .pipe(
                                            Effect.map((assignment) => ({ kind: "assignment" as const, assignment })),
                                        ),
                                    bridge.waitForStop().pipe(Effect.map(() => ({ kind: "stop" as const }))),
                                ),
                            )
                            if (initial.isErr()) {
                                outcome = err(initial.error)
                                break main
                            }
                            if (initial.value.kind === "stop") break main
                            const assigned = initial.value.assignment
                            let createdClient: Client
                            try {
                                createdClient = createClient(childClientOptions(settings, assigned, bridge))
                            } catch (error) {
                                if (!(error instanceof ConfigurationError)) throw error
                                bridge.failed("configure")
                                outcome = err(error)
                                break main
                            }
                            client = createdClient
                            stateObserver = createdClient.observeState((state) => bridge!.state(state))
                            const configured = Promise.resolve()
                                .then(() =>
                                    settings.configure(
                                        Object.freeze({
                                            client: createdClient,
                                            assignment: assigned,
                                            signal: bridge!.signal,
                                        }),
                                    ),
                                )
                                // An Err result from configure fails setup like a throw
                                .then(throwIfErr)
                                .then(
                                    () => ({ kind: "configured" as const }),
                                    (error: unknown) => ({ kind: "defect" as const, error }),
                                )
                            const stopped = bridgeResult(bridge.waitForStop()).then((result) => ({
                                kind: "stop" as const,
                                result,
                            }))
                            const configuration = await Promise.race([configured, stopped])
                            if (configuration.kind === "defect") {
                                bridge.failed("configure")
                                // Configure is application code. An SdkDefect it rethrows from an SDK call keeps its reasons
                                const failure = configuration.error
                                defects.push(
                                    ...(failure instanceof SdkDefect && failure.reasons.length > 0
                                        ? failure.reasons
                                        : [defectReason(new ApplicationError("supervisor child configure", failure))]),
                                )
                                break main
                            }
                            if (configuration.kind === "stop") {
                                if (configuration.result.isErr()) outcome = err(configuration.result.error)
                                break main
                            }
                            bridge.ready()
                            bridge.state(createdClient.state)
                            bridge.reportDiagnostics(() => createdClient.diagnostics())
                            running = Promise.resolve(client.run()).then(
                                (result) => ({ kind: "client" as const, result }),
                                (error: unknown) => ({ kind: "defect" as const, reasons: defectReasons(error) }),
                            )
                            const settled = await Promise.race([running, stopped])
                            if (settled.kind === "defect") {
                                bridge.failed("client")
                                break main
                            }
                            if (settled.kind === "client") {
                                if (settled.result.isErr()) bridge.failed(childFailureReason(settled.result.error))
                                outcome = settled.result
                                break main
                            }
                            if (settled.result.isErr()) outcome = err(settled.result.error)
                            else stopRequested = true
                        }
                    } catch (error) {
                        defects.push(...defectReasons(error))
                    } finally {
                        try {
                            await shutdownClient()
                        } catch (error) {
                            defects.push(...defectReasons(error))
                        } finally {
                            try {
                                if (running) {
                                    const completed = await running
                                    if (completed.kind === "defect") defects.push(...completed.reasons)
                                }
                            } finally {
                                try {
                                    stateObserver?.close()
                                } finally {
                                    try {
                                        bridge?.close()
                                    } catch (error) {
                                        defects.push(...defectReasons(error))
                                    }
                                }
                            }
                        }
                    }
                    if (defects.length > 0) {
                        if (outcome.isErr()) defects.unshift({ kind: "Failure", failure: outcome.error })
                        throw new SdkDefect("supervisor.child.run", defects)
                    }
                    return outcome
                })(),
            ),
    })
    return Object.freeze({
        create: (options: SupervisorOptions) => {
            const result = resultFromExit(Effect.runSyncExit(createSupervisor(options)), "supervisor.create")
            if (result.isErr()) throw result.error
            const owner = result.value
            return Object.freeze({
                start: () =>
                    new ResultAsync<void, SupervisorError>(
                        Effect.runPromiseExit(owner.start()).then((exit) => resultFromExit(exit, "supervisor.start")),
                    ),
                waitForClose: () =>
                    new ResultAsync<void, SupervisorError>(
                        Effect.runPromiseExit(owner.waitForClose()).then((exit) =>
                            resultFromExit(exit, "supervisor.waitForClose"),
                        ),
                    ),
                waitForReady: (options?: SupervisorWaitOptions) => readyResult(owner, options),
                status: () => owner.status(),
                shutdown: () =>
                    new ResultAsync<void, never>(
                        Effect.runPromiseExit(owner.shutdown()).then((exit) => {
                            const result = resultFromExit(exit, "supervisor.shutdown")
                            if (result.isErr())
                                throw new SdkDefect(
                                    "supervisor.shutdown",
                                    Exit.isFailure(exit) ? causeReasons(exit.cause) : [],
                                )
                            return ok(undefined)
                        }),
                    ),
            })
        },
        child,
    })
}
