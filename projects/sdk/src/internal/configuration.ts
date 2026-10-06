/**
 * Client configuration validation: One immutable snapshot of every client option.
 * Invariant: Validation reads caller options once and opens no socket or background work.
 * Implements [SDK contracts: Connection and recovery](/docs/SDK-CONTRACTS.md#connection-and-recovery)
 */
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schedule from "effect/Schedule"
import { ConfigurationError } from "#sdk/errors"
import type { MessageCacheSettings, ResourceCacheSettings } from "#sdk/cache"
import type { Message, MessageCore, MessageFields, SelectedMessage } from "#sdk/messages"
import { createMessageDecoder, snapshotMessageFields, type MessageDecoder } from "./message-fields.js"
import { record } from "./decode/primitives.js"
import { readCaller, suspendMarked } from "./defects.js"
import { loggingConfiguration, type ClientLogger } from "./logging.js"
import { setObserver } from "./observer.js"
import type { Observer } from "#sdk/observer"
import type { ResourceConfiguration } from "./guild-cache.js"
import { parseSharding, type ShardPlan } from "./sharding.js"
import type { IdentifyCoordinator, SessionStore } from "#sdk/sharding"
import { defaultRecovery, type RecoveryConfiguration } from "./client/backoff.js"
import { settingError } from "./client/configuration-fields.js"
import { unsupportedKeyHint } from "./suggest.js"
import { gatewayConfiguration, type GatewayConfiguration } from "./gateway/options.js"
import type { FilterCacheKind } from "./gateway/event-dispatches.js"
import { instanceConfiguration, type InstanceConfiguration } from "./instance.js"
import {
    restConfiguration,
    transportConfiguration,
    type RestConfiguration,
    type TransportConfiguration,
} from "./rest/options.js"

export interface CacheConfiguration<M extends MessageCore = Message> {
    readonly maxEntries: number
    readonly maxBytes: number
    readonly maxAgeMs: MessageCacheSettings<M>["maxAgeMs"]
}

export function validAge(value: unknown): value is number | null {
    return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
}

/** Keys of the cache option, one per cache */
const cacheKinds = [
    "messages",
    "guilds",
    "members",
    "roles",
    "channels",
    "users",
    "directMessages",
    "emojis",
    "stickers",
] as const

/** Settings of one cache */
const budgetKeys: readonly string[] = ["maxEntries", "maxBytes", "maxAgeMs"]

function cacheConfiguration<M extends MessageCore = Message>(
    value: unknown,
): CacheConfiguration<M> | ConfigurationError | undefined {
    if (value === undefined) return undefined
    if (!record(value)) return new ConfigurationError("cache", "Cache settings must be an object")
    const unsupportedKind = Object.keys(value).find((key) => !(cacheKinds as readonly string[]).includes(key))
    if (unsupportedKind !== undefined)
        return new ConfigurationError("cache", `Unsupported cache setting ${JSON.stringify(unsupportedKind)}`, {
            hint: unsupportedKeyHint(unsupportedKind, cacheKinds, "settings"),
        })
    const messages = value.messages
    if (messages === undefined || messages === false) return undefined
    if (messages !== true && !record(messages))
        return new ConfigurationError(
            "messages",
            'The option "cache.messages" must be true, false or a settings object',
        )
    const settings = messages === true ? {} : messages
    const unsupported = Object.keys(settings).find((key) => !budgetKeys.includes(key))
    if (unsupported !== undefined)
        return new ConfigurationError("messages", `Unsupported cache.messages setting ${JSON.stringify(unsupported)}`, {
            hint:
                unsupported === "onError"
                    ? "Cache duration failures go to the client-level onError option"
                    : unsupportedKeyHint(unsupported, budgetKeys, "settings"),
        })
    const maxEntries = settings.maxEntries
    const maxBytes = settings.maxBytes
    for (const [key, number] of [
        ["maxEntries", maxEntries],
        ["maxBytes", maxBytes],
    ] as const) {
        if (number !== undefined && (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0))
            return new ConfigurationError(key, `The option "cache.messages.${key}" must be a positive safe integer`)
    }
    const maxAgeMs = settings.maxAgeMs
    if (maxAgeMs !== undefined && typeof maxAgeMs !== "function" && !validAge(maxAgeMs))
        return new ConfigurationError(
            "maxAgeMs",
            'The option "cache.messages.maxAgeMs" must be null, a nonnegative safe integer of milliseconds or a function',
        )
    return {
        maxEntries: (maxEntries ?? 1_000) as number,
        maxBytes: (maxBytes ?? 8_388_608) as number,
        maxAgeMs: maxAgeMs as MessageCacheSettings<M>["maxAgeMs"],
    }
}

type ResourceSettings = ResourceConfiguration & {
    channels?: Required<ResourceCacheSettings>
    users?: Required<ResourceCacheSettings>
    directMessages?: Required<ResourceCacheSettings>
}

function resourceConfiguration(value: unknown): ResourceSettings | ConfigurationError {
    const result: ResourceSettings = {}
    if (!record(value)) return result
    for (const kind of [
        "guilds",
        "members",
        "roles",
        "channels",
        "users",
        "directMessages",
        "emojis",
        "stickers",
    ] as const) {
        const input = value[kind]
        if (input === undefined || input === false) continue
        if (input !== true && !record(input))
            return new ConfigurationError(kind, `The option "cache.${kind}" must be true, false or a settings object`)
        const options = input === true ? {} : input
        const unsupported = Object.keys(options).find((key) => !budgetKeys.includes(key))
        if (unsupported !== undefined)
            return new ConfigurationError(kind, `Unsupported cache.${kind} setting ${JSON.stringify(unsupported)}`, {
                hint: unsupportedKeyHint(unsupported, budgetKeys, "settings"),
            })
        // Read each budget once, so the validated budget is the one applied
        const entriesInput = options.maxEntries
        const bytesInput = options.maxBytes
        const ageInput = options.maxAgeMs
        const maxEntries = entriesInput === undefined ? 1_000 : entriesInput
        const maxBytes = bytesInput === undefined ? 4_194_304 : bytesInput
        const maxAgeMs = ageInput === undefined ? null : ageInput
        if (typeof maxEntries !== "number" || !Number.isSafeInteger(maxEntries) || maxEntries <= 0)
            return new ConfigurationError(
                "maxEntries",
                `The option "cache.${kind}.maxEntries" must be a positive safe integer`,
            )
        if (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes <= 0)
            return new ConfigurationError(
                "maxBytes",
                `The option "cache.${kind}.maxBytes" must be a positive safe integer`,
            )
        if (typeof maxAgeMs !== "function" && !validAge(maxAgeMs))
            return new ConfigurationError(
                "maxAgeMs",
                `The option "cache.${kind}.maxAgeMs" must be null, a nonnegative safe integer of milliseconds or a function`,
            )
        // A callback is typed per category in ClientOptions, and each cache passes it only that category's snapshots
        result[kind] = { maxEntries, maxBytes, maxAgeMs: maxAgeMs as Required<ResourceCacheSettings>["maxAgeMs"] }
    }
    return result
}

export interface Configuration<M extends MessageCore = Message> {
    readonly decodeMessage: MessageDecoder<M>
    readonly uploadMaxBytes: number
    readonly logging: ClientLogger
    readonly token: Redacted.Redacted<string>
    readonly startupTimeoutMs: number
    readonly maxStartupAttempts: number
    readonly cache: CacheConfiguration<M> | undefined
    readonly resourceCache: ResourceConfiguration
    readonly channelCache: Required<ResourceCacheSettings> | undefined
    readonly userCache: Pick<ResourceSettings, "users" | "directMessages">
    /** Fixed plan, or auto until the first connect computes it */
    readonly sharding: ShardPlan | "auto"
    /** Public Identify coordinator, when configured */
    readonly identifyCoordinator: IdentifyCoordinator | undefined
    /** Public session persistence, when configured */
    readonly sessions: SessionStore | undefined
    /** Whether shards that resume a stored session refill the guild, role and channel caches */
    readonly refillCaches: boolean
    /** Established-session recovery timing */
    readonly recovery: RecoveryConfiguration
    /** Identify fields and malformed-dispatch policy */
    readonly gateway: GatewayConfiguration
    readonly instance: InstanceConfiguration
    /** Raw client-wide failure hook, adapted by the owning entry point */
    readonly onError: ((report: never) => unknown) | undefined
    /** Whether a malformed known dispatch is skipped or ends the shard's session */
    readonly onMalformedDispatch: "skip" | "terminate"
    /** REST scheduling limits and default deadline */
    readonly rest: RestConfiguration
    /** Network implementations and User-Agent */
    readonly transport: TransportConfiguration
}

/** Top-level client option keys, the same in both entry points */
export const clientOptionKeys = [
    "token",
    "onError",
    "connection",
    "messageFields",
    "cache",
    "uploads",
    "logging",
    "sharding",
    "gateway",
    "instance",
    "rest",
    "transport",
    "observe",
] as const

/** Client option keys that supervisor.child.run accepts in clientOptions. The supervisor assigns token and the shards */
const childClientOptionKeys: readonly string[] = clientOptionKeys.filter((key) => key !== "token")

/**
 * Check the keys of supervisor.child.run clientOptions before they are copied, so a misspelled or unsupported key is
 * reported instead of dropped. Sharding may carry only sessions, because the parent assigns the shards and paces
 * Identify. Reading the keys is application input, so the caller runs this under a defect boundary
 */
export function childClientOptionsError(clientOptions: unknown): ConfigurationError | undefined {
    if (clientOptions === undefined) return undefined
    if (!record(clientOptions))
        return new ConfigurationError("configuration", 'The supervisor child option "clientOptions" must be an object')
    // Inherited values would be read too, so they count as overrides like own keys
    const sharding = "sharding" in clientOptions ? clientOptions.sharding : undefined
    if (sharding !== undefined) {
        const plan = !record(sharding)
            ? "sharding"
            : (["totalShards", "shardIds", "identify"].find((key) => key in sharding) ??
              Object.keys(sharding).find((key) => key !== "sessions"))
        if (plan !== undefined)
            return new ConfigurationError(
                "sharding",
                plan === "sharding"
                    ? 'The supervisor child option "clientOptions.sharding" must be an object with only sessions'
                    : `Unsupported option ${JSON.stringify(`sharding.${plan}`)} in the supervisor child option "clientOptions"`,
                {
                    hint:
                        plan === "identify"
                            ? "Set the coordinator in the supervisor's identify.coordinator option, where the parent paces every child's Identify"
                            : "The supervisor assigns each child its shards. Only sharding.sessions is available in a child",
                },
            )
    }
    const unsupported =
        "token" in clientOptions
            ? "token"
            : Object.keys(clientOptions).find((key) => !childClientOptionKeys.includes(key))
    if (unsupported === undefined) return undefined
    return new ConfigurationError(
        "configuration",
        `Unsupported option ${JSON.stringify(unsupported)} in the supervisor child option "clientOptions"`,
        {
            hint:
                unsupported === "token"
                    ? "Pass the bot token in the token option of supervisor.child.run"
                    : unsupportedKeyHint(unsupported, childClientOptionKeys),
        },
    )
}

/** The message of the error that normalizeToken returns for a missing or empty token */
export const missingTokenMessage = "The bot token is missing or empty"

/** Normalize a configured token: Trim whitespace and one layer of matching quotes, which .env files often add.
 * Returns a ConfigurationError that never includes the value when the token is missing or carries an auth scheme
 */
export function normalizeToken(token: unknown): string | ConfigurationError {
    const missing = () =>
        new ConfigurationError("token", missingTokenMessage, {
            hint: "Pass the bot token in the token option. In a project created by fluxerly init, copy .env.example to .env and set FLUXER_BOT_TOKEN. Otherwise set the token's environment variable for the process that starts the bot, or start it with node --env-file=.env bot.js. Check that .env is in the current folder and is not saved as .env.txt",
        })
    if (token === undefined) return missing()
    if (typeof token !== "string")
        return new ConfigurationError(
            "token",
            `The bot token must be a string, not ${token === null ? "null" : Array.isArray(token) ? "an array" : `a value of type ${typeof token}`}`,
            { hint: "Pass the bot token as a string" },
        )
    let value = token.trim()
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0])
        value = value.slice(1, -1).trim()
    if (value.length === 0) return missing()
    if (/^(?:Bot|Bearer)\s/i.test(value))
        return new ConfigurationError("token", 'The bot token must not start with "Bot " or "Bearer "', {
            hint: "Pass only the token itself. The SDK adds the Bot prefix to each request",
        })
    return value
}

/**
 * Validate the client options. Keys in extraKeys are accepted and ignored here, and they join the supported list in
 * the unknown-key hint, so a caller such as runBot can validate its own keys separately
 */
export function validateConfiguration<F extends MessageFields | undefined = undefined>(
    options: unknown,
    native = false,
    extraKeys: readonly string[] = [],
): Effect.Effect<Configuration<SelectedMessage<F>>, ConfigurationError> {
    // Only the reads of the caller options, including the validators that read nested settings, are marked as
    // application input. Creating the logger, transport, decoder and credential reference stays SDK work
    return suspendMarked(() => {
        if (typeof options !== "object" || options === null || Array.isArray(options)) {
            return Effect.fail(new ConfigurationError("configuration", "Client configuration must be an object"))
        }
        const option = (key: string): unknown =>
            readCaller(() => (key in options ? (options as Record<string, unknown>)[key] : undefined))

        const supported: readonly string[] = [...clientOptionKeys, ...extraKeys]
        const unsupported = readCaller(() => Object.keys(options)).find((key) => !supported.includes(key))
        if (unsupported !== undefined)
            return Effect.fail(
                new ConfigurationError("configuration", `Unsupported option ${JSON.stringify(unsupported)}`, {
                    hint: unsupportedKeyHint(unsupported, supported),
                }),
            )
        const token = normalizeToken(option("token"))
        if (token instanceof ConfigurationError) return Effect.fail(token)
        const onError = option("onError")
        if (onError !== undefined && typeof onError !== "function")
            return Effect.fail(new ConfigurationError("onError", 'The option "onError" must be a function'))
        const connection = option("connection")
        if (
            connection !== undefined &&
            (typeof connection !== "object" || connection === null || Array.isArray(connection))
        ) {
            return Effect.fail(new ConfigurationError("connection", "Connection settings must be an object"))
        }
        const connectionField = (key: string): unknown =>
            readCaller(() =>
                connection && key in connection ? (connection as Record<string, unknown>)[key] : undefined,
            )
        const timeout = connectionField("startupTimeoutMs")
        const attempts = connectionField("maxStartupAttempts")
        const connectionKeys = ["startupTimeoutMs", "maxStartupAttempts", "recovery"]
        const unsupportedConnection =
            connection === undefined
                ? undefined
                : readCaller(() => Object.keys(connection)).find((key) => !connectionKeys.includes(key))
        if (unsupportedConnection !== undefined)
            return Effect.fail(
                new ConfigurationError(
                    "connection",
                    `Unsupported connection setting ${JSON.stringify(unsupportedConnection)}`,
                    { hint: unsupportedKeyHint(unsupportedConnection, connectionKeys, "settings") },
                ),
            )
        const recoveryInput = connectionField("recovery")
        const recovery = readCaller(() => recoveryConfiguration(recoveryInput, native))
        if (recovery instanceof ConfigurationError) return Effect.fail(recovery)
        if (
            timeout !== undefined &&
            (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647)
        ) {
            return Effect.fail(
                new ConfigurationError(
                    "startupTimeoutMs",
                    'The option "connection.startupTimeoutMs" must be an integer from 1 through 2,147,483,647 milliseconds',
                ),
            )
        }
        if (
            attempts !== undefined &&
            (typeof attempts !== "number" || !Number.isSafeInteger(attempts) || attempts <= 0)
        ) {
            return Effect.fail(
                new ConfigurationError(
                    "maxStartupAttempts",
                    'The option "connection.maxStartupAttempts" must be a positive safe integer',
                ),
            )
        }
        let selectedFields: ReturnType<typeof snapshotMessageFields>
        const messageFields = option("messageFields")
        try {
            selectedFields = readCaller(() => snapshotMessageFields(messageFields))
        } catch (error) {
            if (error instanceof ConfigurationError) return Effect.fail(error)
            throw error
        }
        // Read the cache settings once for both the message and the resource caches
        const cacheInput = option("cache")
        const cache = readCaller(() => cacheConfiguration<SelectedMessage<F>>(cacheInput))
        const uploads = option("uploads")
        if (uploads !== undefined && !record(uploads))
            return Effect.fail(new ConfigurationError("uploads", "Upload settings must be an object"))
        const unsupportedUpload =
            uploads === undefined ? undefined : readCaller(() => Object.keys(uploads)).find((key) => key !== "maxBytes")
        if (unsupportedUpload !== undefined)
            return Effect.fail(
                new ConfigurationError("uploads", `Unsupported uploads setting ${JSON.stringify(unsupportedUpload)}`, {
                    hint: unsupportedKeyHint(unsupportedUpload, ["maxBytes"], "settings"),
                }),
            )
        const maxBytesInput = readCaller(() => uploads?.maxBytes)
        const uploadMaxBytes = maxBytesInput ?? 104_857_600
        if (
            typeof uploadMaxBytes !== "number" ||
            !Number.isSafeInteger(uploadMaxBytes) ||
            uploadMaxBytes <= 0 ||
            maxBytesInput === null
        )
            return Effect.fail(
                new ConfigurationError(
                    "maxBytes",
                    'The option "uploads.maxBytes" must be a positive safe integer of bytes',
                ),
            )
        if (cache instanceof ConfigurationError) return Effect.fail(cache)
        const resourceCache = readCaller(() => resourceConfiguration(cacheInput))
        if (resourceCache instanceof ConfigurationError) return Effect.fail(resourceCache)
        const { channels: channelCache, users, directMessages, ...guildResourceCache } = resourceCache
        // The logger marks its own reads of the caller settings
        const logging = loggingConfiguration(option("logging"), native)
        if (logging instanceof ConfigurationError) return Effect.fail(logging)
        logging.addSecret(token)
        const observer = option("observe")
        if (observer !== undefined && typeof observer !== "function")
            return Effect.fail(new ConfigurationError("observe", 'The option "observe" must be a function'))
        if (observer !== undefined) setObserver(logging, observer as Observer)
        const shardingInput = option("sharding")
        const sharding = readCaller(() => parseSharding(shardingInput))
        if (sharding instanceof ConfigurationError) return Effect.fail(sharding)
        const cacheKinds: FilterCacheKind[] = [
            ...(cache ? (["messages"] as const) : []),
            ...(Object.keys(guildResourceCache) as FilterCacheKind[]),
            ...(channelCache ? (["channels"] as const) : []),
            ...(users ? (["users"] as const) : []),
            ...(directMessages ? (["directMessages"] as const) : []),
        ]
        const gatewayInput = option("gateway")
        const gateway = readCaller(() => gatewayConfiguration(gatewayInput, cacheKinds))
        if (gateway instanceof ConfigurationError) return Effect.fail(gateway)
        const instanceInput = option("instance")
        const instance = readCaller(() => instanceConfiguration(instanceInput))
        if (instance instanceof ConfigurationError) return Effect.fail(instance)
        const restInput = option("rest")
        const rest = readCaller(() => restConfiguration(restInput))
        if (rest instanceof ConfigurationError) return Effect.fail(rest)
        // The transport marks its own reads of the caller settings
        const transport = transportConfiguration(option("transport"))
        if (transport instanceof ConfigurationError) return Effect.fail(transport)
        return Effect.succeed({
            decodeMessage: createMessageDecoder<F>(selectedFields),
            uploadMaxBytes,
            logging,
            cache,
            resourceCache: guildResourceCache,
            channelCache,
            userCache: { ...(users ? { users } : {}), ...(directMessages ? { directMessages } : {}) },
            token: Redacted.make(token),
            startupTimeoutMs: timeout ?? 30_000,
            maxStartupAttempts: attempts ?? 3,
            sharding: sharding.plan,
            identifyCoordinator: sharding.identify,
            sessions: sharding.sessions,
            refillCaches: sharding.refillCaches,
            recovery,
            gateway,
            instance,
            onError: onError as Configuration["onError"],
            onMalformedDispatch: gateway.onMalformedDispatch,
            rest,
            transport,
        })
    })
}

const timerMaximumMs = 2_147_483_647

/** Validate connection.recovery, including the native-only schedule */
function recoveryConfiguration(value: unknown, native: boolean): RecoveryConfiguration | ConfigurationError {
    if (value === undefined) return defaultRecovery
    const keys = ["minDelayMs", "maxDelayMs", "attemptTimeoutMs", "healthyResetMs", ...(native ? ["schedule"] : [])]
    if (!record(value)) return settingError("recovery", "Recovery settings must be an object")
    const unsupported = Object.keys(value).find((key) => !keys.includes(key))
    if (unsupported !== undefined)
        return settingError("recovery", `Unsupported connection.recovery setting ${JSON.stringify(unsupported)}`, {
            hint:
                unsupported === "schedule"
                    ? "Recovery schedules are available in the Effect entry point"
                    : unsupportedKeyHint(unsupported, keys, "settings"),
        })
    const integer = (
        field: "minDelayMs" | "maxDelayMs" | "attemptTimeoutMs" | "healthyResetMs",
        minimum: number,
        fallback: number,
    ): number | ConfigurationError => {
        const input = value[field]
        if (input === undefined) return fallback
        return typeof input === "number" && Number.isSafeInteger(input) && input >= minimum && input <= timerMaximumMs
            ? input
            : settingError(
                  field,
                  `The option "connection.recovery.${field}" must be an integer from ${minimum.toLocaleString("en-US")} through 2,147,483,647 milliseconds`,
              )
    }
    const minDelayMs = integer("minDelayMs", 100, defaultRecovery.minDelayMs)
    if (minDelayMs instanceof ConfigurationError) return minDelayMs
    const maxDelayMs = integer("maxDelayMs", minDelayMs, Math.max(defaultRecovery.maxDelayMs, minDelayMs))
    if (maxDelayMs instanceof ConfigurationError) return maxDelayMs
    const attemptTimeoutMs = integer("attemptTimeoutMs", 1_000, defaultRecovery.attemptTimeoutMs)
    if (attemptTimeoutMs instanceof ConfigurationError) return attemptTimeoutMs
    const healthyResetMs = integer("healthyResetMs", 1_000, defaultRecovery.healthyResetMs)
    if (healthyResetMs instanceof ConfigurationError) return healthyResetMs
    const schedule = value.schedule
    if (schedule !== undefined) {
        if (!Schedule.isSchedule(schedule))
            return settingError("schedule", 'The option "connection.recovery.schedule" must be an Effect Schedule')
        if (value.minDelayMs !== undefined || value.maxDelayMs !== undefined)
            return settingError("schedule", "A recovery schedule replaces minDelayMs and maxDelayMs, so set only one", {
                hint: "Remove minDelayMs and maxDelayMs, or remove schedule",
            })
    }
    return Object.freeze({
        minDelayMs,
        maxDelayMs,
        attemptTimeoutMs,
        healthyResetMs,
        schedule: schedule as RecoveryConfiguration["schedule"],
    })
}
