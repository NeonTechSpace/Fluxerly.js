/**
 * REST scheduling and transport option validation for one client.
 * Invariant: Validation reads caller options once, copies them and starts no network work. Every limit is an integer
 * within its documented bounds, replacement transports are functions, and every returned transport sends exactly one
 * User-Agent: The caller's value or the SDK default.
 * Implements [SDK contracts: Connection and recovery](/docs/SDK-CONTRACTS.md#connection-and-recovery)
 */
import { ConfigurationError } from "#sdk/errors"
import type { WebSocketLike, WebSocketOptions } from "#sdk/rest"
import { record } from "../decode/primitives.js"
import { readCaller } from "../defects.js"
import {
    defaultTransport,
    defaultUserAgent,
    platformHttpTransport,
    platformSocketFactory,
    userAgentMaxLength,
    validUserAgent,
    withSocketUserAgent,
    withUserAgent,
    type GatewaySocket,
    type HttpTransport,
    type Transport,
} from "../transport/index.js"

/** Validated REST scheduling limits and the default operation deadline */
export interface RestConfiguration {
    /** Concurrent Fluxer API requests, including signed upload parts, before scaling by the local shard count */
    readonly concurrency: number
    /** Whether the caller omitted concurrency, so it scales with the local shard count */
    readonly concurrencyScales: boolean
    /** Concurrent attachment downloads, in slots separate from API requests */
    readonly mediaConcurrency: number
    /** Requests that may wait for a slot or a rate-limit window */
    readonly maxQueued: number
    /** JSON request-body bytes waiting requests may hold together */
    readonly queuedJsonMaxBytes: number
    /** Deadline for an operation that omits timeoutMs */
    readonly defaultTimeoutMs: number
}

/** Default concurrent API requests for each local shard */
export const concurrencyPerShard = 4
/** Largest concurrency, and the ceiling of the scaled default */
export const maximumConcurrency = 64

export const defaultRestConfiguration: RestConfiguration = Object.freeze({
    concurrency: concurrencyPerShard,
    concurrencyScales: true,
    mediaConcurrency: 4,
    maxQueued: 256,
    queuedJsonMaxBytes: 4_194_304,
    defaultTimeoutMs: 30_000,
})

/** Inclusive bounds and the ConfigurationError text for each REST limit */
const restBounds = {
    concurrency: [1, maximumConcurrency, "The option rest.concurrency must be an integer from 1 through 64"],
    mediaConcurrency: [1, 64, "The option rest.mediaConcurrency must be an integer from 1 through 64"],
    maxQueued: [1, 65_536, "The option rest.maxQueued must be an integer from 1 through 65,536"],
    queuedJsonMaxBytes: [
        65_536,
        268_435_456,
        "The option rest.queuedJsonMaxBytes must be an integer from 65,536 through 268,435,456 bytes",
    ],
    defaultTimeoutMs: [
        1,
        2_147_483_647,
        "The option rest.defaultTimeoutMs must be an integer from 1 through 2,147,483,647 ms",
    ],
} as const satisfies Record<Exclude<keyof RestConfiguration, "concurrencyScales">, readonly [number, number, string]>

/** Configuration fields this module reports. The public field union lists each of them */
type OptionField = "rest" | "transport" | keyof typeof restBounds | "fetch" | "webSocket" | "userAgent"

const configurationError = (field: OptionField, message: string) => new ConfigurationError(field, message)

/** Validate the rest client option */
export function restConfiguration(value: unknown): RestConfiguration | ConfigurationError {
    if (value === undefined) return defaultRestConfiguration
    if (!record(value)) return configurationError("rest", "The option rest must be an object")
    const keys = Object.keys(restBounds)
    if (Object.keys(value).some((key) => !keys.includes(key)))
        return configurationError(
            "rest",
            "The option rest may contain only concurrency, mediaConcurrency, maxQueued, queuedJsonMaxBytes, and defaultTimeoutMs",
        )
    const result: Record<string, number | boolean> = { ...defaultRestConfiguration }
    for (const [field, [minimum, maximum, message]] of Object.entries(restBounds) as [
        keyof typeof restBounds,
        (typeof restBounds)[keyof typeof restBounds],
    ][]) {
        const setting = value[field]
        if (setting === undefined) continue
        if (typeof setting !== "number" || !Number.isSafeInteger(setting) || setting < minimum || setting > maximum)
            return configurationError(field, message)
        result[field] = setting
    }
    // An explicit concurrency is used as given, whatever the shard count
    if (value.concurrency !== undefined) result.concurrencyScales = false
    return Object.freeze(result as unknown as RestConfiguration)
}

/** Validated network implementations and the User-Agent sent with HTTP requests and gateway handshakes */
export interface TransportConfiguration {
    readonly transport: Transport
    readonly userAgent: string
}

/**
 * Validate the transport client option, then wrap the implementations. Only reading the caller settings is marked as
 * application input, so the caller must run this under a defect boundary
 */
export function transportConfiguration(value: unknown): TransportConfiguration | ConfigurationError {
    if (value === undefined) return { transport: defaultTransport, userAgent: defaultUserAgent() }
    if (!record(value)) return configurationError("transport", "The option transport must be an object")
    const read = readCaller(() => {
        if (Object.keys(value).some((key) => !["fetch", "webSocket", "userAgent"].includes(key))) return undefined
        const { fetch, webSocket, userAgent } = value
        return { fetch, webSocket, userAgent }
    })
    if (read === undefined)
        return configurationError("transport", "The option transport may contain only fetch, webSocket, and userAgent")
    const { fetch, webSocket, userAgent } = read
    if (fetch !== undefined && typeof fetch !== "function")
        return configurationError("fetch", "The option transport.fetch must be a function")
    if (webSocket !== undefined && typeof webSocket !== "function")
        return configurationError("webSocket", "The option transport.webSocket must be a function")
    if (userAgent !== undefined && !validUserAgent(userAgent))
        return configurationError(
            "userAgent",
            `The option transport.userAgent must contain 1 through ${userAgentMaxLength} printable ASCII characters without leading or trailing spaces`,
        )
    const agent = userAgent === undefined ? defaultUserAgent : () => userAgent
    const http = fetch === undefined ? platformHttpTransport : (fetch as HttpTransport)
    // WebSocketLike and GatewaySocket describe the same ws subset
    const sockets =
        webSocket === undefined
            ? platformSocketFactory
            : (webSocket as (url: string, options: WebSocketOptions) => WebSocketLike & GatewaySocket)
    return {
        transport: Object.freeze({ http: withUserAgent(http, agent), sockets: withSocketUserAgent(sockets, agent) }),
        userAgent: agent(),
    }
}
