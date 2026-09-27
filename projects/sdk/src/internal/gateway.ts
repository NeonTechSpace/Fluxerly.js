/**
 * Gateway module entry: The per-shard protocol-v1 session the client's recovery loop runs, split into
 * [session](/projects/sdk/src/internal/gateway/session.ts), [frames](/projects/sdk/src/internal/gateway/frames.ts),
 * [dispatch table](/projects/sdk/src/internal/gateway/dispatch-table.ts) and
 * [commands](/projects/sdk/src/internal/gateway/commands.ts).
 * Invariant: Code outside the gateway reaches it only through this entry. Implements
 * [SDK contracts: Connection and recovery](/docs/SDK-CONTRACTS.md#connection-and-recovery)
 */
import type { Message } from "#sdk/messages"
import { decodeMessage } from "./message.js"
import { runGatewaySession, type GatewaySessionOptions } from "./gateway/session.js"

export {
    AttemptFailure,
    classifyClose,
    runGatewaySession,
    type Session,
} from "./gateway/session.js"

/**
 * Full-message gateway entry for independent internal protocol checks.
 * The supervisor test worker imports it from the built SDK, which lint cannot see before the build
 *
 * @public
 */
export const runGateway = (options: Omit<GatewaySessionOptions<Message>, "messageDecoder">) =>
    runGatewaySession({ ...options, messageDecoder: decodeMessage })
