import { Effect, Exit, type Scope } from "effect"
import { ConfigurationError, type ConnectError } from "#sdk/errors"
import { attachIdentifyGate } from "#sdk/internal/client"
import { ChildBridge, createSupervisor } from "#sdk/internal/supervisor"
import {
    SupervisorChildError,
    type SupervisorAssignment,
    SupervisorError,
    type SupervisorOptions,
    type SupervisorStatus,
} from "#sdk/supervisor"
import type { Client, ClientOptions } from "./effect.js"

/** Context passed to the Effect-native helper-owned child client before its managed run begins */
export interface NativeSupervisorChildContext {
    /** The child client with the parent-provided immutable local shard assignment */
    readonly client: Client
    /** Fixed assignment for this child process. It cannot be changed during this run */
    readonly assignment: SupervisorAssignment
}

/** Native child settings. The callback preserves its Effect environment and registers work before child.run owns client.run */
export interface NativeSupervisorChildOptions<E = never, R = never> {
    /** Credential passed by child.run to its helper-owned client */
    readonly token: string
    /** Native client settings copied into the child client. Runtime validation rejects token and sharding overrides */
    readonly clientOptions?: Omit<ClientOptions<E, R>, "token" | "sharding">
    /** Register subscriptions and local application behavior before child.run owns client.run.
     * Scoped tasks use the helper's nested scope, which closes before child.run settles; other required services remain caller-provided
     */
    readonly configure: (context: NativeSupervisorChildContext) => Effect.Effect<void, E, R | Scope.Scope>
}

/** One optional local process supervisor with lazy native operations */
export interface NativeSupervisor {
    /** Start the configured children and await each assignment/configuration acknowledgement, not gateway READY.
     * Concurrent calls share startup. Interruption stops this supervisor and awaits its owned process exits.
     * Expected failure also waits for those exits; start after shutdown fails with closed
     */
    start(): Effect.Effect<void, SupervisorError>
    /** Await the terminal local supervisor outcome after every owned child exits. Interrupting this observer does not stop the supervisor */
    waitForClose(): Effect.Effect<void, SupervisorError>
    /** Return one immutable safe local status snapshot without child output, environment, arguments or paths */
    status(): SupervisorStatus
    /** Ask every owned child to stop, force-terminate only an unresponsive owned child after the configured grace period, then await verified exit.
     * Shutdown is coalesced and uninterruptible once executed
     */
    shutdown(): Effect.Effect<void>
}

/** Effect-native optional local-supervisor tools */
export interface NativeSupervisorTools {
    /** Lazily validate and snapshot a local process plan without starting child processes */
    create(options: SupervisorOptions): Effect.Effect<NativeSupervisor, ConfigurationError>
    /** Run one child configured by a parent supervisor. A nested helper scope owns the client and IPC cleanup until this effect settles */
    readonly child: {
        run<E = never, R = never>(
            options: NativeSupervisorChildOptions<E, R>,
        ): Effect.Effect<void, ConfigurationError | ConnectError | SupervisorChildError | E, Exclude<R, Scope.Scope>>
    }
}

function rejectChildOverrides<E, R>(options: NativeSupervisorChildOptions<E, R>): ConfigurationError | undefined {
    const clientOptions = options.clientOptions
    if (
        clientOptions !== undefined &&
        (typeof clientOptions !== "object" ||
            clientOptions === null ||
            Object.hasOwn(clientOptions, "token") ||
            Object.hasOwn(clientOptions, "sharding"))
    )
        return new ConfigurationError(
            "configuration",
            "supervisor child clientOptions cannot override token or sharding",
        )
    return undefined
}

function childClientOptions<E, R>(
    options: NativeSupervisorChildOptions<E, R>,
    assignment: SupervisorAssignment,
    bridge: ChildBridge,
): ClientOptions<E, R> {
    return attachIdentifyGate(
        { ...options.clientOptions, token: options.token, sharding: assignment },
        bridge.identifyGate,
    )
}

/** Build native supervisor tools around this entry point's scoped client creator */
export function makeNativeSupervisor(
    createClient: <E, R>(options: ClientOptions<E, R>) => Effect.Effect<Client, ConfigurationError, Scope.Scope | R>,
): NativeSupervisorTools {
    const child = Object.freeze({
        run: <E, R>(
            options: NativeSupervisorChildOptions<E, R>,
        ): Effect.Effect<void, ConfigurationError | ConnectError | SupervisorChildError | E, Exclude<R, Scope.Scope>> =>
            Effect.suspend(() => {
                const rejected = rejectChildOverrides(options)
                if (rejected) return Effect.fail(rejected)
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
                        const client = yield* createClient(childClientOptions(options, assigned, bridge))
                        const configured = yield* Effect.exit(
                            Effect.raceFirst(
                                options
                                    .configure(Object.freeze({ client, assignment: assigned }))
                                    .pipe(Effect.as("configured" as const)),
                                bridge.waitForStop().pipe(Effect.as("stop" as const)),
                            ),
                        )
                        if (Exit.isFailure(configured)) {
                            bridge.failed("configure")
                            return yield* Effect.failCause(configured.cause)
                        }
                        if (configured.value === "stop") return
                        bridge.ready()
                        const outcome = yield* Effect.exit(
                            Effect.raceFirst(
                                client.run().pipe(Effect.as("client" as const)),
                                bridge.waitForStop().pipe(Effect.as("stop" as const)),
                            ),
                        )
                        if (Exit.isSuccess(outcome) && outcome.value === "stop") return yield* client.shutdown()
                        if (Exit.isFailure(outcome)) {
                            const failure = outcome.cause.reasons.find((reason) => reason._tag === "Fail")
                            if (failure?._tag !== "Fail" || !(failure.error instanceof SupervisorChildError))
                                bridge.failed("client")
                            return yield* Effect.failCause(outcome.cause)
                        }
                    }),
                )
            }) as Effect.Effect<
                void,
                ConfigurationError | ConnectError | SupervisorChildError | E,
                Exclude<R, Scope.Scope>
            >,
    })
    return Object.freeze({
        create: (options: SupervisorOptions) =>
            createSupervisor(options).pipe(
                Effect.map((owner) =>
                    Object.freeze({
                        start: () => owner.start(),
                        waitForClose: () => owner.waitForClose(),
                        status: () => owner.status(),
                        shutdown: () => owner.shutdown(),
                    }),
                ),
            ),
        child,
    })
}
