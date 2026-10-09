import { makeDefaultSupervisor } from "#sdk/default-supervisor"
import { createClient } from "./client.js"

/**
 * Run a fixed group of local Node.js child processes, each with its own client and assigned shards.
 * Use create to validate the assignments, then start to launch the children.
 * Each child entry module must call supervisor.child.run to create and run its client
 *
 * @remarks
 * The start method waits for assignment and configuration acknowledgements, not gateway READY.
 * Use waitForReady for all-child READY, and waitForClose to wait until this supervisor's children have exited.
 * The status method returns a frozen local report with the latest gateway state received from each current child.
 * Those states are separate observations, not an atomic health check across processes
 *
 * Fresh gateway Identify sends require a parent permit and are spaced by at least one second, unless identify.coordinator paces them.
 * Identify authenticates a new session, while Resume reuses an earlier gateway session.
 * Session Resume sends do not need a permit.
 * A permit stays outstanding until the child confirms the send or cancels before sending.
 * A stalled child is stopped and must exit before another permit is issued, after a full spacing interval.
 * The child helper receives a stop signal.
 * A parent stop does not wait for an uncooperative configure promise or start its client afterward
 *
 * The parent can forcibly terminate only children it started after the graceful deadline, and still waits for their exit.
 * No process signal handlers are installed.
 * Child output follows childOutput: Lines are forwarded with a child label by default, and inherit or ignore can be chosen instead.
 * A crashed child restarts by default, up to three times in a row with exponentially increasing delays. Set restart to false to turn this off.
 * The childEnvironment, args and execArgv options affect child launch but are omitted from status and failures.
 * With totalShards "auto" and processes or shardsPerProcess, the plan is sized at start. Each child sends its client diagnostics, which status includes.
 * Children keep resumable sessions through clientOptions.sharding.sessions.
 * The children share Fluxer's limits per bot account through the parent. When one child is rate-limited globally, the parent
 * holds the other children's REST requests until the same time. Member requests from all children share one count of 12 in
 * any 11 seconds, and a members.iterateChunks request past it fails at once with reason rateLimit and retryAfterMs.
 * A child that gets no answer from the parent within one second counts only its own member requests and logs
 * supervisor.memberRequestsLocal once. Per-route REST rate limits stay per child, and other processes using the same
 * token are not counted
 *
 * @example
 * ```ts
 * import { supervisor } from "@neontechspace/fluxerly"
 *
 * export const workers = supervisor.create({
 *     entry: "/srv/bot-worker.js",
 *     totalShards: 2,
 *     assignments: [
 *         { id: "one", shardIds: [0] },
 *         { id: "two", shardIds: [1] },
 *     ],
 * })
 * ```
 *
 * @category Sharding and supervision
 */
export const supervisor: import("#sdk/default-supervisor").DefaultSupervisorTools = makeDefaultSupervisor(createClient)
