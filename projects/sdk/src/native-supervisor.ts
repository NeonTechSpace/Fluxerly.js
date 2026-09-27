import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Stream from "effect/Stream"
import type * as Scope from "effect/Scope"
import { ConfigurationError, type ConnectError } from "#sdk/errors"
import { attachIdentifyGate } from "#sdk/internal/client"
import { ChildBridge, childFailureReason, createSupervisor } from "#sdk/internal/supervisor"
import { childClientOptionsError } from "#sdk/internal/configuration"
import { readInput } from "#sdk/internal/defects"
import type { SessionStore } from "#sdk/sharding"
import {
    SupervisorChildError,
    type SupervisorAssignment,
    type SupervisorChildSharding,
    SupervisorError,
    type SupervisorOptions,
    type SupervisorStatus,
} from "#sdk/supervisor"
import type { Client, ClientOptions } from "./effect.js"

/**
 * Client and fixed shard assignment available to configure before the helper starts the gateway connection
 *
 * @category Sharding and supervision
 */
export interface NativeSupervisorChildContext {
    /** Native client created and owned by child.run. Register application behavior rather than starting or stopping this client */
    readonly client: Client
    /** Fixed assignment for this child process. It cannot be changed during this run */
    readonly assignment: SupervisorAssignment
}

/**
 * Bot credentials, native client settings and setup Effect for a module launched by a supervisor.
 * E represents application failures and R represents required services.
 * The helper provides Scope, which closes resources when this child run ends. Other services remain caller-provided
 *
 * @category Sharding and supervision
 */
export interface NativeSupervisorChildOptions<E = never, R = never> {
    /** Bot token for the client created by child.run, such as `process.env.FLUXER_BOT_TOKEN`. The parent assignment does
     * not supply this credential. A missing or blank value fails child.run with ConfigurationError once the assignment arrives,
     * as createClient does, and the parent sees the child fail during configuration
     */
    readonly token: string | undefined
    /** Every native client setting except token is read by property name and copied before configure, including inherited and
     * non-enumerable properties. The supervisor assigns the shards, so sharding accepts only sessions.
     * Runtime validation rejects a token, a shard plan or identify coordinator in sharding, and any other own key that
     * is not a client option, with ConfigurationError
     */
    readonly clientOptions?: Omit<ClientOptions<E, R>, "token" | "sharding"> & {
        /** Session storage for the assigned shards. The parent assigns the shards and paces Identify, so only sessions is accepted */
        readonly sharding?: SupervisorChildSharding
    }
    /** Register subscriptions and local application behavior before the helper executes client.run.
     * Complete this Effect after setup, rather than keeping it running until the bot stops. Do not execute client.run, connect or shutdown here.
     * Scope-bound tasks and resources belong to the helper's nested Scope, which closes before child.run settles.
     * Parent stop interrupts unfinished configuration and awaits its cleanup without starting the client afterward.
     * Application failures remain typed as E. Defects and cleanup failures remain in the Effect cause
     */
    readonly configure: (context: NativeSupervisorChildContext) => Effect.Effect<void, E, R | Scope.Scope>
}

/**
 * Parent that starts and stops the child processes in one fixed local shard plan.
 * Asynchronous methods return lazy Effects. Calling a method does not execute it, while status reads immediately.
 * Creating the parent does not start children or arrange automatic cleanup when a Scope closes. Execute shutdown to release its processes.
 * Expected failures use SupervisorError. Unexpected defects remain in the Effect cause
 *
 * @category Sharding and supervision
 */
export interface NativeSupervisor {
    /** Start the configured children and succeed when each child acknowledges its assignment and finishes configure.
     * This means setup finished. It does not mean any gateway connection is ready. Execute waitForReady to observe connected gateway sessions.
     * Concurrent executions share startup. Executing again does not launch extra children or await replacement startup.
     * Interruption stops the whole supervisor, including when another caller is waiting for the same startup, and awaits owned process exits.
     * Expected failure also awaits those exits. Start during or after shutdown fails with reason closed.
     * With totalShards "auto" it first counts the bot's communities, and a failed count fails with reason shardCount.
     * If a child remains alive after losing its message channel for shutdownTimeoutMs, pending startup fails with closed after cleanup
     */
    start(): Effect.Effect<void, SupervisorError>
    /** Wait until the supervisor's lifetime ends and its owned child processes have exited.
     * Succeeds after normal shutdown or fails with the retained SupervisorError after failure, even on a later execution.
     * Does not start or stop the parent. Before startup, waits until a later shutdown or failure.
     * Interrupting this wait detaches only the observer without stopping the supervisor
     */
    waitForClose(): Effect.Effect<void, SupervisorError>
    /** Succeed when every current child has reported its aggregate gateway state as Connected.
     * Execute start first. This checks the latest child reports. It does not prove that every process is healthy at the same instant or will stay ready.
     * Losing a child's message channel clears its readiness immediately. A later execution waits for current readiness again.
     * Interrupting this wait cancels only this observer without stopping or restarting a child.
     * An idle, stopping or closed supervisor fails with reason closed. A failed supervisor returns its retained failure
     */
    waitForReady(): Effect.Effect<void, SupervisorError>
    /** Return one immutable safe local status snapshot without child output, environment, arguments or paths */
    status(): SupervisorStatus
    /** Ask owned children to stop and succeed only after their processes exit.
     * After shutdownTimeoutMs, force-terminate an owned child that has not exited, then keep waiting for its exit.
     * Calls made together or repeated later share the same cleanup. Once cleanup starts, interrupting a caller does not stop it.
     * Shutdown before startup closes the parent without launching children.
     * Succeeds even after a supervisor failure or a child's message-channel loss. It does not erase waitForClose's retained failure
     */
    shutdown(): Effect.Effect<void>
}

/**
 * Create a local parent supervisor or run its child module using the Effect public API
 *
 * @category Sharding and supervision
 */
export interface NativeSupervisorTools {
    /** Return a lazy Effect that validates and copies options, then succeeds with an idle supervisor.
     * Invalid options are misuse and die with ConfigurationError.
     * Does not start a process or check whether the entry module can execute. Launch failures are reported by start.
     * The parent has no automatic Scope finalizer. Arrange to execute its shutdown Effect when the application stops
     */
    create(options: SupervisorOptions): Effect.Effect<NativeSupervisor>
    /** Child-module helper. Execute run inside the module selected by the parent's entry option */
    readonly child: {
        /** Receive the parent's assignment, create a client, finish configure, then run the client until stop or failure
         *
         * A nested Scope owns the client, configuration resources and parent-message listeners until this Effect settles.
         * The helper supplies Scope and requires any remaining R services from the caller
         *
         * Normal parent stop succeeds. Stop or interruption awaits cleanup, including interrupted configuration branches
         *
         * Running outside a connected supervisor child fails with SupervisorChildError with reason disconnected.
         * Invalid client settings fail with ConfigurationError. Client execution can fail with ConnectError and application setup with E.
         * Message-channel loss or invalid coordination data fails with SupervisorChildError
         *
         * Parent stop during configure is not an application configuration failure, but cleanup failures remain in the cause.
         * Defects remain in the cause alongside typed failures, including failures during cleanup
         */
        run<E = never, R = never>(
            options: NativeSupervisorChildOptions<E, R>,
        ): Effect.Effect<void, ConfigurationError | ConnectError | SupervisorChildError | E, Exclude<R, Scope.Scope>>
    }
}

/** Child options read once before the helper waits for an assignment */
interface ChildSettings<E, R> {
    readonly clientOptions: Omit<ClientOptions<E, R>, "token" | "sharding">
    /** The child's session store, added to the shards the parent assigns */
    readonly sessions: SessionStore | undefined
    readonly token: string | undefined
    readonly configure: NativeSupervisorChildOptions<E, R>["configure"]
}

/** Read the child options once, so later getter changes cannot alter the client or configure Effect */
function readChildOptions<E, R>(options: NativeSupervisorChildOptions<E, R>): ChildSettings<E, R> | ConfigurationError {
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

function childClientOptions<E, R>(
    settings: ChildSettings<E, R>,
    assignment: SupervisorAssignment,
    bridge: ChildBridge,
): ClientOptions<E, R> {
    const sharding = settings.sessions === undefined ? assignment : { ...assignment, sessions: settings.sessions }
    return attachIdentifyGate({ ...settings.clientOptions, token: settings.token, sharding }, bridge.identifyGate)
}

/** Build native supervisor tools around this entry point's scoped client creator */
export function makeNativeSupervisor(
    createClient: <E, R>(options: ClientOptions<E, R>) => Effect.Effect<Client, ConfigurationError, Scope.Scope | R>,
): NativeSupervisorTools {
    const child = Object.freeze({
        run: <E, R>(
            options: NativeSupervisorChildOptions<E, R>,
        ): Effect.Effect<void, ConfigurationError | ConnectError | SupervisorChildError | E, Exclude<R, Scope.Scope>> =>
            // Reading the caller options is marked as application input
            readInput(() => readChildOptions(options)).pipe(
                Effect.flatMap((settings) => {
                    if (settings instanceof ConfigurationError) return Effect.fail(settings)
                    return Effect.scoped(
                        Effect.gen(function* () {
                            const bridge = yield* ChildBridge.open()
                            yield* Effect.addFinalizer(() => Effect.sync(() => bridge.close()))
                            const initial = yield* Effect.raceFirst(
                                bridge
                                    .waitForAssignment()
                                    .pipe(Effect.map((assignment) => ({ kind: "assignment" as const, assignment }))),
                                bridge.waitForStop().pipe(Effect.map(() => ({ kind: "stop" as const }))),
                            )
                            if (initial.kind === "stop") return
                            const assigned = initial.assignment
                            const client = yield* createClient(childClientOptions(settings, assigned, bridge))
                            yield* Stream.runForEach(client.observeState(), (state) =>
                                Effect.sync(() => bridge.state(state)),
                            ).pipe(Effect.forkScoped)
                            const configureExits: Exit.Exit<unknown, E>[] = []
                            let stoppedDuringConfiguration = false
                            const configured = yield* Effect.exit(
                                Effect.raceFirst(
                                    settings.configure(Object.freeze({ client, assignment: assigned })).pipe(
                                        Effect.onExit((exit) =>
                                            Effect.sync(() => {
                                                configureExits.push(exit)
                                            }),
                                        ),
                                        Effect.as("configured" as const),
                                    ),
                                    bridge.waitForStop().pipe(
                                        Effect.tap(() =>
                                            Effect.sync(() => {
                                                stoppedDuringConfiguration = true
                                            }),
                                        ),
                                        Effect.as("stop" as const),
                                    ),
                                ).pipe(
                                    // raceFirst awaits the interrupted configure branch but discards its finalizer defects
                                    // A cooperative stop remains an IPC success, while the child retains local cleanup defects
                                    Effect.onExit((outcome) => {
                                        const missing = configureExits.flatMap((exit) =>
                                            Exit.isFailure(exit)
                                                ? exit.cause.reasons.filter(
                                                      (reason) =>
                                                          reason._tag !== "Interrupt" &&
                                                          (!Exit.isFailure(outcome) ||
                                                              !outcome.cause.reasons.includes(reason)),
                                                  )
                                                : [],
                                        )
                                        return missing.length
                                            ? Effect.failCause(Cause.fromReasons(missing))
                                            : Effect.void
                                    }),
                                ),
                            )
                            if (Exit.isFailure(configured)) {
                                if (!stoppedDuringConfiguration) bridge.failed("configure")
                                return yield* Effect.failCause(configured.cause)
                            }
                            if (configured.value === "stop") return
                            bridge.ready()
                            bridge.state(client.state)
                            bridge.reportDiagnostics(() => client.diagnostics())
                            const outcome = yield* Effect.exit(
                                Effect.raceFirst(
                                    client.run().pipe(Effect.as("client" as const)),
                                    bridge.waitForStop().pipe(Effect.as("stop" as const)),
                                ),
                            )
                            // A stop the parent requested lets running work finish
                            if (Exit.isSuccess(outcome) && outcome.value === "stop")
                                return yield* client.shutdown(
                                    bridge.drainMs > 0 ? { drainMs: bridge.drainMs } : undefined,
                                )
                            if (Exit.isFailure(outcome)) {
                                const failure = outcome.cause.reasons.find((reason) => reason._tag === "Fail")
                                if (failure?._tag !== "Fail") bridge.failed("client")
                                else if (!(failure.error instanceof SupervisorChildError))
                                    bridge.failed(childFailureReason(failure.error))
                                return yield* Effect.failCause(outcome.cause)
                            }
                        }),
                    )
                }),
            ) as Effect.Effect<
                void,
                ConfigurationError | ConnectError | SupervisorChildError | E,
                Exclude<R, Scope.Scope>
            >,
    })
    return Object.freeze({
        create: (options: SupervisorOptions) =>
            createSupervisor(options, true).pipe(
                Effect.orDie,
                Effect.map((owner) =>
                    Object.freeze({
                        start: () => owner.start(),
                        waitForClose: () => owner.waitForClose(),
                        waitForReady: () => owner.waitForReady(),
                        status: () => owner.status(),
                        shutdown: () => owner.shutdown(),
                    }),
                ),
            ),
        child,
    })
}
