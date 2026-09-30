import type { ClientClosedError } from "./errors.js"
import { FluxerlyError, operationDetails } from "./errors.js"
import { freezeInputValidationDetail, type InputValidationDetail } from "./input-validation.js"

/**
 * Why gateway.send did not hand a command to the shard's connection.
 * The reason input means the shard ID, opcode or data is malformed, cannot be encoded as JSON, or encodes to more than
 * Fluxer's 4,096-byte message limit. The reason reserved means the opcode belongs to the SDK-managed session
 * (heartbeat, Identify or Resume) or is a server-only opcode that Fluxer answers by closing the connection.
 * The reason notOwned means this client does not own the shard, and notReady means the shard is not currently
 * Connected or lost its connection before the command reached the socket.
 * The reason busy means 500 earlier gateway.send commands on that shard are still waiting for the pacing budget.
 * Cancelling an unsent command immediately releases its queue capacity, even while the pacing window is full.
 * None of these failures sent anything
 *
 * @category Errors
 */
export class GatewaySendError extends FluxerlyError {
    /** Stable expected-failure discriminator */
    readonly _tag = "GatewaySendError"
    /** Local shard the command was for, or null when the supplied shard ID was not a non-negative integer */
    readonly shardId: number | null
    /** Requested opcode, or null when the supplied opcode was not a non-negative integer */
    readonly opcode: number | null
    /** Why the command was not sent */
    readonly reason: "input" | "reserved" | "notOwned" | "notReady" | "busy"
    /** Safe explanation of the invalid argument for reason input, otherwise null. It never contains the rejected value */
    readonly inputValidation: InputValidationDetail | null

    /** Describe a command that was not sent. Construction has no side effects */
    constructor(options: {
        /** Why the command was not sent */
        readonly reason: GatewaySendError["reason"]
        /** Local shard ID, or null when the supplied value was not a valid shard ID. Defaults to null */
        readonly shardId?: number | null | undefined
        /** Requested opcode, or null when the supplied value was not a valid opcode. Defaults to null */
        readonly opcode?: number | null | undefined
        /** Safe input detail for reason input. Defaults to null */
        readonly inputValidation?: InputValidationDetail | null | undefined
        /** Underlying failure retained as the error's cause, such as a JSON encoding error */
        readonly cause?: unknown
    }) {
        const { reason, shardId = null, opcode = null, inputValidation = null } = options
        const target = shardId === null ? "the requested shard" : `shard ${shardId}`
        super(
            `Gateway command${opcode === null ? "" : ` with opcode ${opcode}`} was not sent on ${target}: ${
                // The input detail names the invalid argument, such as an unsupported option
                reason === "input" && inputValidation !== null ? inputValidation.explanation : explanations[reason]
            }`,
            {
                code: `gateway.send.${reason}`,
                hint: hints[reason],
                cause: options.cause,
                details: operationDetails({ reason, shardId, opcode }),
            },
        )
        this.name = this._tag
        this.shardId = shardId
        this.opcode = opcode
        this.reason = reason
        this.inputValidation = freezeInputValidationDetail(inputValidation)
    }
}

const explanations: Record<GatewaySendError["reason"], string> = {
    input: "The shard ID, opcode or command data is invalid",
    reserved: "The SDK manages this opcode itself, or only Fluxer sends it",
    notOwned: "This client does not run the shard",
    notReady: "The shard is not connected",
    busy: "Too many earlier commands are waiting, because the SDK sends at most 500 commands per minute on each connection",
}

const hints: Record<GatewaySendError["reason"], string> = {
    input: "Pass a non-negative integer shard ID and opcode, and JSON data that encodes to at most 4,096 bytes with its opcode",
    reserved: "Use the SDK's own methods, such as presence.set, instead of sending session opcodes",
    notOwned: "Send on a shard listed in client.shards",
    notReady: "Retry after the shard is Connected again, for example after observing client state",
    busy: "Wait for earlier gateway.send operations to complete before sending more",
}

/**
 * Expected gateway.send failures in both APIs
 *
 * @category Errors
 */
export type GatewaySendFailure = GatewaySendError | ClientClosedError
