import { makeNativeSupervisor } from "#sdk/native-supervisor"
import { openClient } from "./client.js"

/**
 * Run bot workers in separate Node processes on this machine.
 * The create method validates the process plan when executed but starts no children.
 * The start method launches those children once and waits for their assignment and configuration acknowledgements, not gateway READY.
 * The waitForReady method waits for a later all-child READY state without starting or stopping the supervisor.
 * The waitForClose method waits until every owned child exits. Cancelling that wait does not stop the children.
 * The status method returns a frozen snapshot of each child's latest reported gateway state for its current process generation.
 * The snapshot is local, not a simultaneous health check across processes
 *
 * Each child module must execute supervisor.child.run, which owns a nested client and an inter-process communication (IPC) cleanup scope.
 * The helper preserves the caller's Effect services and Cause. It asks the parent for a permit immediately before each fresh gateway Identify.
 * Identify authenticates a new gateway session. Resuming an existing session needs no permit.
 * Only one parent permit can be outstanding. The child confirms its synchronous Identify send or cancels before sending.
 * The parent spaces fresh sends by at least one second, unless identify.coordinator paces them.
 * A stalled child must stop and exit before another permit is issued, followed by a full spacing interval
 *
 * The supervisor can size the plan at start with totalShards "auto", share the Identify budget through identify.coordinator and
 * include each child's client diagnostics in status. Children keep resumable sessions through clientOptions.sharding.sessions.
 * The children share Fluxer's limits per bot account through the parent. When one child is rate-limited globally, the parent
 * holds the other children's REST requests until the same time. Member requests from all children share one count of 12 in
 * any 11 seconds, and a members.iterateChunks request past it fails at once with reason rateLimit and retryAfterMs.
 * A child that gets no answer from the parent within one second counts only its own member requests and logs
 * supervisor.memberRequestsLocal once. Per-route REST rate limits stay per child, and other processes using the same
 * token are not counted.
 * It installs no signal handlers and does not terminate the process.
 * After the configured graceful deadline, the parent can terminate only its own unresponsive child and still waits for its exit.
 * A crashed child restarts by default with bounded exponential delays. Set restart to false to turn this off.
 * The childEnvironment, args and execArgv options configure children but never appear in status or failures.
 * Child output follows childOutput: Lines are forwarded with a child label by default, and inherit or ignore can be chosen instead
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { supervisor } from "@neontechspace/fluxerly/effect"
 *
 * export const workers = Effect.gen(function* () {
 *     const managed = yield* supervisor.create({
 *         entry: "/srv/bot-worker.js",
 *         totalShards: 2,
 *         assignments: [
 *             { id: "one", shardIds: [0] },
 *             { id: "two", shardIds: [1] },
 *         ],
 *     })
 *     yield* managed.start().pipe(
 *         Effect.andThen(managed.waitForClose()),
 *         Effect.ensuring(managed.shutdown()),
 *     )
 *     return managed.status()
 * })
 * ```
 *
 * @category Sharding and supervision
 */
export const supervisor: import("#sdk/native-supervisor").NativeSupervisorTools = makeNativeSupervisor(openClient)
