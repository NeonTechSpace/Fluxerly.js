/**
 * Gateway module entry: The per-shard protocol-v1 session the client's recovery loop runs, split into
 * [session](/projects/sdk/src/internal/gateway/session.ts), [frames](/projects/sdk/src/internal/gateway/frames.ts),
 * [dispatch table](/projects/sdk/src/internal/gateway/dispatch-table.ts) and
 * [commands](/projects/sdk/src/internal/gateway/commands.ts).
 * Invariant: Code outside the gateway runs sessions only through this entry, while the command types, gateway options
 * and Identify event filter in gateway/commands, gateway/options and gateway/event-dispatches are imported directly.
 * Implements [SDK contracts: Connection and recovery](/docs/SDK-CONTRACTS.md#connection-and-recovery)
 */
export { AttemptFailure, runGatewaySession, type Session } from "./gateway/session.js"
