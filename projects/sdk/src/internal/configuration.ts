import { Effect, Redacted } from "effect"
import { ConfigurationError } from "#sdk/errors"

export interface Configuration {
    readonly token: Redacted.Redacted<string>
    readonly startupTimeoutMs: number
    readonly maxStartupAttempts: number
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
        return Effect.succeed({
            token: Redacted.make(token),
            startupTimeoutMs: timeout ?? 30_000,
            maxStartupAttempts: attempts ?? 3,
        })
    })
}
