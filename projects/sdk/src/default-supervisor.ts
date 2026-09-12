import { Cause, Effect, Exit } from "effect"
import { err, ok, ResultAsync, type Result } from "neverthrow"
import type { ClientOptions } from "#sdk/client"
import { CancelledError, ConfigurationError, SdkDefect, type ConnectError, type DefectReason } from "#sdk/errors"
import { attachIdentifyGate } from "#sdk/internal/client"
import { operationSignalError } from "#sdk/internal/operation-signal"
import { ChildBridge, createSupervisor, type SupervisorOwner } from "#sdk/internal/supervisor"
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

/** Context passed to the default helper-owned child client before its managed run begins */
export interface DefaultSupervisorChildContext {
    /** The child client with the parent-provided immutable local shard assignment */
    readonly client: Client
    /** Fixed assignment for this child process. It cannot be changed during this run */
    readonly assignment: SupervisorAssignment
    /** Aborted when the parent requests stop or IPC disconnects. Configure work must cooperate; ignored promises cannot be forcibly preempted */
    readonly signal: import("#sdk/client").OperationSignal
}

/** Default child settings. The callback registers application work but never starts or stops the client */
export interface DefaultSupervisorChildOptions extends SupervisorChildOptions {
    /** Register subscriptions and local application behavior before child.run owns client.run. Parent stop does not preempt an already-running promise */
    readonly configure: (context: DefaultSupervisorChildContext) => void | Promise<void>
}

/** One optional local process supervisor */
export interface DefaultSupervisor {
    /** Start the configured children and await each assignment/configuration acknowledgement, not gateway READY.
     * Concurrent calls share startup. Expected failure waits for owned process exit; start after shutdown fails with closed.
     * Terminal child IPC loss fails any still-pending startup with closed only after all owned children exit
     */
    start(): ResultAsync<void, SupervisorError>
    /** Await the retained terminal local supervisor outcome after every owned child exits, including closed after a current child outlives its IPC-loss observation window */
    waitForClose(): ResultAsync<void, SupervisorError>
    /** Observe all children becoming gateway-ready without starting or owning the supervisor. A current child IPC loss clears readiness immediately.
     * A signal cancels only this observer; a never-started, closed or failed supervisor settles with its terminal error.
     * A malformed signal returns ConfigurationError with field signal without starting observation
     */
    waitForReady(
        options?: SupervisorWaitOptions,
    ): ResultAsync<void, SupervisorError | CancelledError | ConfigurationError>
    /** Return one immutable safe local status snapshot without child output, environment, arguments or paths */
    status(): SupervisorStatus
    /** Ask every owned child to stop, force-terminate only an unresponsive owned child after the configured grace period, then await verified exit.
     * Explicit shutdown remains successful when a child has already lost IPC
     */
    shutdown(): ResultAsync<void, never>
}

/** Default optional local-supervisor tools */
export interface DefaultSupervisorTools {
    /** Validate and snapshot a local process plan without starting child processes */
    create(options: SupervisorOptions): Result<DefaultSupervisor, ConfigurationError>
    /** Run one child configured by a parent supervisor. It owns client creation, managed execution and cleanup.
     * Parent stop/disconnection closes the client and releases IPC listeners before settlement. Caller-owned configure promises cannot be preempted.
     * Expected failures return Err. Defects reject with SdkDefect, retaining accompanying typed failures without private error text
     */
    readonly child: {
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
        const reasons: DefectReason[] = exit.cause.reasons.map((reason) =>
            reason._tag === "Fail"
                ? {
                      kind: "Failure",
                      failure: reason.error as Extract<DefectReason, { readonly kind: "Failure" }>["failure"],
                  }
                : { kind: reason._tag === "Die" ? "Defect" : "Interruption" },
        )
        throw new SdkDefect(operation, reasons)
    }
    const reason = exit.cause.reasons.find((reason) => reason._tag === "Fail")
    if (reason?._tag === "Fail") return err(reason.error)
    throw new SdkDefect(operation)
}

function defectReasons(error: unknown): DefectReason[] {
    if (error instanceof SdkDefect && error.reasons.length > 0) return [...error.reasons]
    return [{ kind: "Defect" }]
}

function bridgeResult<A>(effect: Effect.Effect<A, SupervisorChildError>): Promise<Result<A, SupervisorChildError>> {
    return Effect.runPromiseExit(effect).then((exit) => resultFromExit(exit, "supervisor.child.run"))
}

function readyResult(owner: SupervisorOwner, options?: SupervisorWaitOptions) {
    const readiness = Effect.suspend((): Effect.Effect<void, SupervisorError | CancelledError | ConfigurationError> => {
        const signal = options?.signal
        const invalidSignal = operationSignalError(signal)
        if (invalidSignal) return Effect.fail(invalidSignal)
        if (signal?.aborted) return Effect.fail(new CancelledError())
        if (!signal) return owner.waitForReady()
        const cancelled = Effect.callback<never, CancelledError>((resume) => {
            const abort = () => resume(Effect.fail(new CancelledError()))
            signal.addEventListener("abort", abort, { once: true })
            return Effect.sync(() => signal.removeEventListener("abort", abort))
        })
        return Effect.raceFirst(owner.waitForReady(), cancelled)
    })
    return new ResultAsync<void, SupervisorError | CancelledError | ConfigurationError>(
        Effect.runPromiseExit(readiness).then((exit) => resultFromExit(exit, "supervisor.waitForReady")),
    )
}

function rejectChildOverrides(options: DefaultSupervisorChildOptions): ConfigurationError | undefined {
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

function childClientOptions(
    options: DefaultSupervisorChildOptions,
    assignment: SupervisorAssignment,
    bridge: ChildBridge,
): ClientOptions {
    return attachIdentifyGate(
        { ...options.clientOptions, token: options.token, sharding: assignment },
        bridge.identifyGate,
    )
}

/** Build default supervisor tools around this entry point's client creator */
export function makeDefaultSupervisor(
    createClient: (options: ClientOptions) => Result<Client, ConfigurationError>,
): DefaultSupervisorTools {
    const child = Object.freeze({
        run: (options: DefaultSupervisorChildOptions) =>
            new ResultAsync<void, ConfigurationError | ConnectError | CancelledError | SupervisorChildError>(
                (async () => {
                    let bridge: ChildBridge | undefined
                    let client: Client | undefined
                    let unsubscribeState: (() => void) | undefined
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
                    const shutdownClient = async () => {
                        if (!client || shutdownAttempted) return
                        shutdownAttempted = true
                        await client.shutdown()
                    }
                    try {
                        main: {
                            const rejected = rejectChildOverrides(options)
                            if (rejected) {
                                outcome = err(rejected)
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
                            const created = createClient(childClientOptions(options, assigned, bridge))
                            if (created.isErr()) {
                                bridge.failed("configure")
                                outcome = err(created.error)
                                break main
                            }
                            const createdClient = created.value
                            client = createdClient
                            unsubscribeState = createdClient.observeState((state) => bridge!.state(state))
                            const configured = Promise.resolve()
                                .then(() =>
                                    options.configure(
                                        Object.freeze({
                                            client: createdClient,
                                            assignment: assigned,
                                            signal: bridge!.signal,
                                        }),
                                    ),
                                )
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
                                throw configuration.error
                            }
                            if (configuration.kind === "stop") {
                                if (configuration.result.isErr()) outcome = err(configuration.result.error)
                                break main
                            }
                            bridge.ready()
                            bridge.state(createdClient.state)
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
                                if (settled.result.isErr()) bridge.failed("client")
                                outcome = settled.result
                                break main
                            }
                            if (settled.result.isErr()) outcome = err(settled.result.error)
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
                                    unsubscribeState?.()
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
            if (result.isErr()) return err(result.error)
            const owner = result.value
            return ok(
                Object.freeze({
                    start: () =>
                        new ResultAsync<void, SupervisorError>(
                            Effect.runPromiseExit(owner.start()).then((exit) =>
                                resultFromExit(exit, "supervisor.start"),
                            ),
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
                                if (result.isErr()) throw new SdkDefect("supervisor.shutdown")
                                return ok(undefined)
                            }),
                        ),
                }),
            )
        },
        child,
    })
}
