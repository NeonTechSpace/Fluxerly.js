import { Effect, Redacted } from "effect"
import { ConfigurationError } from "#sdk/errors"
import type { MessageCacheSettings, CachePolicyErrorReport } from "#sdk/cache"
import { record } from "./message.js"

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
    if (!record(value) || Object.keys(value).some((key) => key !== "messages"))
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

export interface Configuration {
    readonly token: Redacted.Redacted<string>
    readonly startupTimeoutMs: number
    readonly maxStartupAttempts: number
    readonly cache: CacheConfiguration | undefined
}

export function validateConfiguration(options: unknown): Effect.Effect<Configuration, ConfigurationError> {
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
        if (cache instanceof ConfigurationError) return Effect.fail(cache)
        return Effect.succeed({
            cache,
            token: Redacted.make(token),
            startupTimeoutMs: timeout ?? 30_000,
            maxStartupAttempts: attempts ?? 3,
        })
    })
}
