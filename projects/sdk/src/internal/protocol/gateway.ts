/**
 * Gateway protocol-v1 constants: Opcodes, close codes and the reviewed close-code classification.
 * Invariant: Gateway code names every opcode and close code through these tables, and an unlisted close code enters
 * recovery because an unknown closure is not proof of a permanent fault.
 * Implements [SDK contracts: Connection and recovery](/docs/SDK-CONTRACTS.md#connection-and-recovery)
 */

/** Gateway opcodes used by the SDK's protocol-v1 session */
export const Opcode = Object.freeze({
    dispatch: 0,
    heartbeat: 1,
    identify: 2,
    presenceUpdate: 3,
    resume: 6,
    reconnect: 7,
    requestGuildMembers: 8,
    invalidSession: 9,
    hello: 10,
    heartbeatAck: 11,
    memberSubscriptions: 14,
    requestGuildCounts: 15,
    requestChannelMemberCounts: 16,
} as const)

const opcodeNames = new Map<number, string>([
    [Opcode.dispatch, "DISPATCH"],
    [Opcode.heartbeat, "HEARTBEAT"],
    [Opcode.identify, "IDENTIFY"],
    [Opcode.presenceUpdate, "PRESENCE_UPDATE"],
    [Opcode.resume, "RESUME"],
    [Opcode.reconnect, "RECONNECT"],
    [Opcode.requestGuildMembers, "REQUEST_GUILD_MEMBERS"],
    [Opcode.invalidSession, "INVALID_SESSION"],
    [Opcode.hello, "HELLO"],
    [Opcode.heartbeatAck, "HEARTBEAT_ACK"],
    [Opcode.memberSubscriptions, "MEMBER_SUBSCRIPTIONS"],
    [Opcode.requestGuildCounts, "REQUEST_GUILD_COUNTS"],
    [Opcode.requestChannelMemberCounts, "REQUEST_CHANNEL_MEMBER_COUNTS"],
])

/** Readable opcode name for logs, or null for an opcode this SDK does not know */
export function opcodeName(op: number): string | null {
    return opcodeNames.get(op) ?? null
}

/**
 * Opcodes an application may not send through gateway.send.
 * Heartbeat, Identify and Resume belong to the session the SDK manages, and a second Identify or an out-of-band
 * Resume would replace or end it. Server-only opcodes close the connection with 4001 or 4003, which the SDK treats as
 * permanent, so they are rejected locally instead
 */
export const reservedClientOpcodes: ReadonlySet<number> = new Set([
    Opcode.heartbeat,
    Opcode.identify,
    Opcode.resume,
    Opcode.dispatch,
    Opcode.reconnect,
    Opcode.invalidSession,
    Opcode.hello,
    Opcode.heartbeatAck,
])

/** Largest client payload Fluxer accepts, in UTF-8 bytes on the wire. Larger messages close with 4002 */
export const maxClientPayloadBytes = 4_096

/**
 * Identify session flags, pinned against fluxer_docs gateway/commands.md "Session flags" at fluxerapp/fluxer commit
 * 841fb7af4174fc8fc025307776e87e7dba51a669. Bit 0 and every bit above 1 are undefined and ignored by Fluxer
 */
export const IdentifyFlag = Object.freeze({
    /** DEBOUNCE_MESSAGE_REACTIONS: Merge runs of direct-message reaction additions into MESSAGE_REACTION_ADD_MANY */
    debounceMessageReactions: 1 << 1,
} as const)

/** Most ignored_events entries Fluxer accepts in one Identify. A longer array closes with 4002 */
export const maxIgnoredEvents = 256

/**
 * How long Fluxer retains a disconnected session for Resume, in milliseconds.
 * A client close with 1000 or 1001 does not end the retained session (fluxer_docs gateway/opcodes-and-close-codes.md
 * at the pinned commit), so the SDK keeps its normal closure code when session persistence is configured
 */
export const sessionRetentionMs = 60_000

/**
 * Most guilds one bot shard may serve, MAX_GUILDS_PER_SHARD in fluxer_gateway/src/gateway/gateway_sharding.erl at
 * fluxerapp/fluxer commit 841fb7af4174fc8fc025307776e87e7dba51a669. Identify for a shard resolving to more guilds
 * closes with 4011
 */
export const maxGuildsPerShard = 2_500

/** WebSocket and Fluxer gateway close codes the SDK recognizes */
export const CloseCode = Object.freeze({
    normal: 1000,
    goingAway: 1001,
    abnormal: 1006,
    invalidPayload: 1007,
    messageTooBig: 1009,
    serverError: 1011,
    unknownError: 4000,
    unknownOpcode: 4001,
    decodeError: 4002,
    notAuthenticated: 4003,
    authenticationFailed: 4004,
    alreadyAuthenticated: 4005,
    invalidSequence: 4007,
    rateLimited: 4008,
    sessionTimeout: 4009,
    invalidShard: 4010,
    shardingRequired: 4011,
    invalidApiVersion: 4012,
} as const)

/** How the SDK reacts to a gateway close code.
 * The resume action retries and resumes the session when possible, identify retries with a new session,
 * wait retries after the server-required rate-limit wait, and fatal stops without retrying
 */
export type CloseAction = "resume" | "identify" | "wait" | "fatal"

export interface CloseCodeInfo {
    /** Stable constant-style name, or UNKNOWN for an unlisted code */
    readonly name: string
    readonly action: CloseAction
    /** Reviewed explanation of what the close code means, used in errors and log records */
    readonly meaning: string
}

// Server-sent 1007 and 1009 closures retry, while the local receive-limit and UTF-8 rejections are terminal in the gateway
// Each action and meaning is reviewed against Fluxer's GatewayConstants and the gateway handler call sites that send it
const closeCodes: ReadonlyMap<number, CloseCodeInfo> = new Map<number, CloseCodeInfo>([
    [CloseCode.normal, { name: "NORMAL", action: "resume", meaning: "The gateway closed the connection normally" }],
    [CloseCode.goingAway, { name: "GOING_AWAY", action: "resume", meaning: "The gateway is restarting or going away" }],
    [
        CloseCode.abnormal,
        { name: "ABNORMAL", action: "resume", meaning: "The connection dropped without a close frame" },
    ],
    [
        CloseCode.invalidPayload,
        {
            name: "INVALID_PAYLOAD",
            action: "resume",
            meaning: "The WebSocket connection rejected invalid payload encoding",
        },
    ],
    [
        CloseCode.messageTooBig,
        {
            name: "MESSAGE_TOO_BIG",
            action: "resume",
            meaning: "The WebSocket connection rejected a message exceeding its receive limit",
        },
    ],
    [
        CloseCode.serverError,
        { name: "SERVER_ERROR", action: "resume", meaning: "The gateway reported an internal error" },
    ],
    [
        CloseCode.unknownError,
        { name: "UNKNOWN_ERROR", action: "resume", meaning: "The gateway reported an unspecified error" },
    ],
    [
        CloseCode.unknownOpcode,
        {
            name: "UNKNOWN_OPCODE",
            action: "fatal",
            meaning: "The gateway rejected an unsupported command or missing command data",
        },
    ],
    [
        CloseCode.decodeError,
        {
            name: "DECODE_ERROR",
            action: "fatal",
            meaning: "The gateway rejected invalid payload encoding, size, compression or command fields",
        },
    ],
    [
        CloseCode.notAuthenticated,
        {
            name: "NOT_AUTHENTICATED",
            action: "fatal",
            meaning: "The gateway received a command before authentication established a session",
        },
    ],
    [
        CloseCode.authenticationFailed,
        { name: "AUTHENTICATION_FAILED", action: "fatal", meaning: "Fluxer rejected the bot token" },
    ],
    [
        CloseCode.alreadyAuthenticated,
        {
            name: "ALREADY_AUTHENTICATED",
            action: "fatal",
            meaning:
                "The gateway rejected Identify or Resume because a session was already attached or command data was missing",
        },
    ],
    [
        CloseCode.invalidSequence,
        {
            name: "INVALID_SEQUENCE",
            action: "identify",
            meaning: "The gateway rejected the heartbeat or resume sequence",
        },
    ],
    [
        CloseCode.rateLimited,
        {
            name: "RATE_LIMITED",
            action: "wait",
            meaning: "The gateway rejected work because a connection, payload or session budget was exceeded",
        },
    ],
    [
        CloseCode.sessionTimeout,
        {
            name: "SESSION_TIMEOUT",
            action: "resume",
            meaning: "The gateway closed after a heartbeat acknowledgement timeout",
        },
    ],
    [
        CloseCode.invalidShard,
        { name: "INVALID_SHARD", action: "fatal", meaning: "The gateway rejected the shard ID or total shard count" },
    ],
    [
        CloseCode.shardingRequired,
        { name: "SHARDING_REQUIRED", action: "fatal", meaning: "The gateway requires more shards for this bot" },
    ],
    [
        CloseCode.invalidApiVersion,
        {
            name: "INVALID_API_VERSION",
            action: "fatal",
            meaning: "The gateway rejected an absent or unsupported API version",
        },
    ],
])

/** Classification for any close code. Unlisted codes enter recovery, because an unknown closure is not proof of a permanent fault */
export function closeCodeInfo(code: number): CloseCodeInfo {
    return (
        closeCodes.get(code) ?? {
            name: "UNKNOWN",
            action: "resume",
            meaning: "The SDK does not recognize this Fluxer close code",
        }
    )
}

/** What one gateway closure means for the attempt that observed it */
export interface CloseOutcome {
    /** The failure kind: `authentication` for a rejected credential, `rateLimit` for a server-required wait,
     * `protocol` for a permanent closure and `closed` for a recoverable one
     */
    readonly failure: "authentication" | "rateLimit" | "protocol" | "closed"
    /** Whether the SDK's recovery loop may start another attempt */
    readonly retry: boolean
    /** Whether the retained session can no longer resume, so the next attempt sends Identify */
    readonly resetSession: boolean
}

/** Classify a gateway close through the reviewed close-code table.
 * The resuming flag says whether the closed attempt was still resuming, which is when an identify action discards the session
 */
export function classifyCloseCode(code: number, resuming: boolean): CloseOutcome {
    if (code === CloseCode.authenticationFailed) return { failure: "authentication", retry: false, resetSession: false }
    const info = closeCodeInfo(code)
    if (info.action === "wait") return { failure: "rateLimit", retry: true, resetSession: false }
    const permanent = info.action === "fatal"
    return {
        failure: permanent ? "protocol" : "closed",
        retry: !permanent,
        resetSession: info.action === "identify" && resuming,
    }
}

/** Readable next step for a close action as one sentence, used in log messages.
 * The resume flag says whether the next attempt will actually send Resume, which requires a retained session and sequence.
 * The delay is already formatted with its unit, and established says whether the shard was connected before, so the
 * next attempt reconnects rather than retries startup
 */
export function closeActionText(action: CloseAction, resume: boolean, delay: string, established = true): string {
    const next = `${established ? "reconnecting" : "retrying"} ${resume ? "and resuming the session" : "with a new session"}`
    switch (action) {
        case "fatal":
            return "The SDK does not retry this failure"
        case "wait":
            return `Waiting ${delay} for the rate limit, then ${next}`
        case "identify":
        case "resume":
            return `${next.charAt(0).toUpperCase()}${next.slice(1)} in ${delay}`
    }
}
