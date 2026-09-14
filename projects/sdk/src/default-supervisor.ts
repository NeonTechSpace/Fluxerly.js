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

/** Client and fixed shard assignment available to configure before the helper starts the gateway connection */
export interface DefaultSupervisorChildContext {
    /** Client created and owned by child.run. Register application behavior here rather than starting or stopping this client */
    readonly client: Client
    /** Fixed assignment for this child process. It cannot be changed during this run */
    readonly assignment: SupervisorAssignment
    /** Stop signal aborted when the parent requests shutdown or its message channel disconnects.
     * Make asynchronous configure work cooperate with this signal. The helper cannot forcibly cancel a JavaScript promise
     */
    readonly signal: import("#sdk/client").OperationSignal
}

/** Bot credentials, client settings and setup callback for a JavaScript module launched by a supervisor */
export interface DefaultSupervisorChildOptions extends SupervisorChildOptions {
    /** Register subscriptions and local application behavior before the helper calls client.run.
     * Return when setup is finished, not when the bot stops. Do not call client.run, connect or shutdown here.
     * A thrown error or rejected promise is a defect and rejects child.run with SdkDefect.
     * Parent stop can finish child.run without awaiting this promise, so setup must observe context.signal to avoid later work
     */
    readonly configure: (context: DefaultSupervisorChildContext) => void | Promise<void>
}

/**
 * Parent that starts and stops the child processes in one fixed local shard plan.
 * Methods start their asynchronous work when called and return ResultAsync for expected failures.
 * Unexpected defects reject with SdkDefect instead of returning Err.
 * Creating this parent starts no child. Call shutdown to release its owned processes
 */
export interface DefaultSupervisor {
    /** Start the configured children and return Ok when each child acknowledges its assignment and finishes configure.
     * This is setup completion, not gateway readiness. Use waitForReady to observe connected gateway sessions.
     * Concurrent calls share startup. Calling again does not create extra children or await replacement startup.
     * Failure returns SupervisorError only after owned processes exit. Start during or after shutdown returns reason closed.
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

/** Create a local parent supervisor or run its child module using the default API */
export interface DefaultSupervisorTools {
    /** Validate and copy options now, returning Ok with an idle supervisor or Err with ConfigurationError.
     * Does not start a process or check whether the entry module can execute. Launch failures are reported by start
     */
    create(options: SupervisorOptions): Result<DefaultSupervisor, ConfigurationError>
    /** Child-module helper. Call run inside the module selected by the parent's entry option */
    readonly child: {
        /** Receive the parent's assignment, create a client, finish configure, then run the client until stop or failure.
         * Owns client shutdown and removal of parent-message listeners before returning its result.
         * A normal parent stop returns Ok. Running outside a connected supervisor child returns SupervisorChildError with reason disconnected.
         * Invalid client settings return ConfigurationError. Client execution can return ConnectError or CancelledError.
         * Message-channel loss or invalid coordination data returns SupervisorChildError.
         * A stop during configure never starts the client afterward.
         * The helper cannot forcibly stop a configure promise that ignores cancellation and does not wait for it.
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

/** Build default-API supervisor tools around this entry point's client creator */
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
