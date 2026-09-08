import { Effect, Redacted } from "effect"
import { ConfigurationError } from "#sdk/errors"
import type { MessageCacheSettings, CachePolicyErrorReport } from "#sdk/cache"
import { record } from "./message.js"
import { loggingConfiguration, type ClientLogging } from "./logging.js"
import type { ResourceConfiguration } from "./guild-cache.js"

export interface CacheConfiguration {
    readonly maxEntries: number
    readonly maxBytes: number
    readonly maxAgeMs: MessageCacheSettings["maxAgeMs"]
    readonly onError: ((report: CachePolicyErrorReport) => unknown) | undefined
}

export function validAge(value: unknown): value is number | null {
    return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
}

function cacheConfiguration(value: unknown): CacheConfiguration | ConfigurationError | undefined {
    if (value === undefined) return undefined
    if (!record(value) || Object.keys(value).some((key) => !["messages", "guilds", "members", "roles"].includes(key)))
        return new ConfigurationError("cache", "Cache settings must contain only supported resource settings")
    const messages = value.messages
    if (messages === undefined || messages === false) return undefined
    if (messages !== true && !record(messages))
        return new ConfigurationError("messages", "Message cache must be a boolean or options object")
    const settings = messages === true ? {} : messages
    if (Object.keys(settings).some((key) => !["maxEntries", "maxBytes", "maxAgeMs", "onError"].includes(key)))
        return new ConfigurationError("messages", "Unsupported message cache setting")
    const maxEntries = settings.maxEntries
    const maxBytes = settings.maxBytes
    for (const [key, number] of [
        ["maxEntries", maxEntries],
        ["maxBytes", maxBytes],
    ] as const) {
        if (number !== undefined && (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0))
            return new ConfigurationError(key, "Cache budgets must be positive safe integers")
    }
    const maxAgeMs = settings.maxAgeMs
    if (maxAgeMs !== undefined && typeof maxAgeMs !== "function" && !validAge(maxAgeMs))
        return new ConfigurationError("maxAgeMs", "Cache age must be null, a nonnegative safe integer or a function")
    const onError = settings.onError
    if (onError !== undefined && typeof onError !== "function")
        return new ConfigurationError("onError", "Cache error reporter must be a function")
    return {
        maxEntries: (maxEntries ?? 1_000) as number,
        maxBytes: (maxBytes ?? 8_388_608) as number,
        maxAgeMs: maxAgeMs as MessageCacheSettings["maxAgeMs"],
        onError: onError as CacheConfiguration["onError"],
    }
}

function resourceConfiguration(value: unknown): ResourceConfiguration | ConfigurationError {
    const result: ResourceConfiguration = {}
    if (!record(value)) return result
    for (const kind of ["guilds", "members", "roles"] as const) {
        const input = value[kind]
        if (input === undefined || input === false) continue
        if (input !== true && !record(input))
            return new ConfigurationError(kind, "Resource cache must be a boolean or options object")
        const options = input === true ? {} : input
        if (Object.keys(options).some((key) => !["maxEntries", "maxBytes", "maxAgeMs"].includes(key)))
            return new ConfigurationError(kind, "Unsupported resource cache setting")
        const maxEntries = options.maxEntries === undefined ? 1_000 : options.maxEntries
        const maxBytes = options.maxBytes === undefined ? 4_194_304 : options.maxBytes
        const maxAgeMs = options.maxAgeMs === undefined ? null : options.maxAgeMs
        if (typeof maxEntries !== "number" || !Number.isSafeInteger(maxEntries) || maxEntries <= 0)
            return new ConfigurationError("maxEntries", "Cache budgets must be positive safe integers")
        if (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes <= 0)
            return new ConfigurationError("maxBytes", "Cache budgets must be positive safe integers")
        if (!validAge(maxAgeMs))
            return new ConfigurationError("maxAgeMs", "Resource cache age must be null or a nonnegative safe integer")
        result[kind] = { maxEntries, maxBytes, maxAgeMs }
    }
    return result
}

export interface Configuration {
    readonly uploadMaxBytes: number
    readonly logging: ClientLogging
    readonly token: Redacted.Redacted<string>
    readonly startupTimeoutMs: number
    readonly maxStartupAttempts: number
    readonly cache: CacheConfiguration | undefined
    readonly resourceCache: ResourceConfiguration
}

export function validateConfiguration(
    options: unknown,
    native = false,
): Effect.Effect<Configuration, ConfigurationError> {
    return Effect.suspend(() => {
        if (typeof options !== "object" || options === null || Array.isArray(options)) {
            return Effect.fail(new ConfigurationError("configuration", "Client configuration must be an object"))
        }

        const token = "token" in options ? options.token : undefined
        if (typeof token !== "string" || token.trim().length === 0) {
            return Effect.fail(new ConfigurationError("token", "Token must be a non-empty string"))
        }

        const connection = "connection" in options ? options.connection : undefined
        if (
            connection !== undefined &&
            (typeof connection !== "object" || connection === null || Array.isArray(connection))
        ) {
            return Effect.fail(new ConfigurationError("connection", "Connection settings must be an object"))
        }
        const timeout = connection && "startupTimeoutMs" in connection ? connection.startupTimeoutMs : undefined
        const attempts = connection && "maxStartupAttempts" in connection ? connection.maxStartupAttempts : undefined
        if (
            timeout !== undefined &&
            (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647)
        ) {
            return Effect.fail(
                new ConfigurationError(
                    "startupTimeoutMs",
                    "Startup timeout must be a positive timer-safe integer in milliseconds",
                ),
            )
        }
        if (
            attempts !== undefined &&
            (typeof attempts !== "number" || !Number.isSafeInteger(attempts) || attempts <= 0)
        ) {
            return Effect.fail(
                new ConfigurationError("maxStartupAttempts", "Startup attempts must be a positive safe integer"),
            )
        }
        const cache = cacheConfiguration("cache" in options ? options.cache : undefined)
        const uploads = "uploads" in options ? options.uploads : undefined
        if (uploads !== undefined && (!record(uploads) || Object.keys(uploads).some((key) => key !== "maxBytes")))
            return Effect.fail(new ConfigurationError("uploads", "Upload settings must contain only maxBytes"))
        const uploadMaxBytes = uploads?.maxBytes ?? 104_857_600
        if (
            typeof uploadMaxBytes !== "number" ||
            !Number.isSafeInteger(uploadMaxBytes) ||
            uploadMaxBytes <= 0 ||
            uploads?.maxBytes === null
        )
            return Effect.fail(new ConfigurationError("maxBytes", "Upload budget must be a positive safe integer"))
        if (cache instanceof ConfigurationError) return Effect.fail(cache)
        const resourceCache = resourceConfiguration("cache" in options ? options.cache : undefined)
        if (resourceCache instanceof ConfigurationError) return Effect.fail(resourceCache)
        const logging = loggingConfiguration("logging" in options ? options.logging : undefined, native)
        if (logging instanceof ConfigurationError) return Effect.fail(logging)
        return Effect.succeed({
            uploadMaxBytes,
            logging,
            cache,
            resourceCache,
            token: Redacted.make(token),
            startupTimeoutMs: timeout ?? 30_000,
            maxStartupAttempts: attempts ?? 3,
        })
    })
}
