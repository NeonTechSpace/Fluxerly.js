import type { ResultAsync } from "neverthrow"
import type { OperationOptions } from "#sdk/client"
import type { CancelledError, ConfigurationError } from "#sdk/errors"
import type { GatewaySendFailure } from "#sdk/gateway"

/**
 * Send gateway commands that have no SDK method, on this client's ready shards.
 * This is an advanced escape hatch: The SDK validates the frame locally but does not know the command's meaning,
 * and Fluxer closes the connection, ending the client, for commands it rejects.
 * Observe replies to these commands through the raw event, subscribing before sending
 *
 * @category Client and lifecycle
 */
export interface GatewayCommands {
    /**
     * Send one command frame { op, d } on a Connected local shard.
     * The data is copied through JSON encoding when the operation starts, so later changes to it have no effect, and the
     * encoded frame must be at most 4,096 UTF-8 bytes, Fluxer's message limit. Undefined data is invalid. Pass null instead.
     * Data JSON cannot encode, such as a cycle or a BigInt, fails with reason input.
     * Heartbeat, Identify, Resume and server-only opcodes fail with reason reserved.
     * Commands share the shard's outbound pacing with presence and request commands: At most 500 paced commands per
     * rolling 60 seconds per session, retained across Resume and reset for a fresh Identify, sent in call order.
     * Heartbeats, Identify and Resume are never delayed. At most 500 gateway.send commands may wait per shard, and
     * further submissions fail with reason busy until transmission or cancellation releases queue capacity.
     * Completion means the frame was handed to the connection, not that Fluxer received or accepted it.
     * A sent Request Guild Members command, opcode 8, counts toward the 12 member requests that members.iterateChunks
     * allows this client in any 11 seconds, or the children of one supervisor together, but this method never refuses one
     * for that limit.
     * Fluxer answers an opcode it does not define, missing data or invalid command fields with close code 4001 or 4002.
     * The SDK treats both as permanent, so the client ends. Data must match Fluxer's command schema exactly.
     * Observe any reply through the raw event, which receives every dispatch the session accepts.
     * A shard that loses its connection before sending fails a waiting command with reason notReady, and the SDK never
     * replays it after reconnecting. Each sent command is logged at Debug with code gateway.commandSent
     *
     * @remarks
     * Cancellation through options.signal withdraws a command that is still waiting for the pacing budget and returns
     * CancelledError. Withdrawal immediately releases its local queue capacity.
     * A command already handed to the connection cannot be withdrawn.
     * A malformed signal returns ConfigurationError before anything is queued. A throw from the data's own getters or
     * toJSON rejects with SdkDefect code application.defect and the thrown value as its cause.
     * Other unexpected failures reject with SdkDefect
     *
     * @example
     * ```ts
     * import type { Client, RawDispatch } from "@neontechspace/fluxerly"
     * // Commands with an SDK method, such as community counts through client.guilds.fetchCounts, use that method instead
     * export function sendCustomCommand(
     *     client: Client,
     *     command: { op: number; data: unknown; replyType: string },
     *     onReply: (reply: RawDispatch) => void,
     * ) {
     *     // Subscribe before sending so the raw reply cannot be missed
     *     const replies = client.on("raw", (dispatch) => {
     *         if (dispatch.t === command.replyType) onReply(dispatch)
     *     })
     *     // Close the returned subscription once the reply has arrived
     *     return client.gateway.send(0, command.op, command.data).map(() => replies)
     * }
     * ```
     */
    send(
        shardId: number,
        op: number,
        d: unknown,
        options?: OperationOptions,
    ): ResultAsync<void, GatewaySendFailure | CancelledError | ConfigurationError>
}
