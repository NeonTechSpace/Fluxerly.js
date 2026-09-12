import { Cause, Effect, Fiber, Logger, LogLevel, References } from "effect"
import type { DefaultLogger, DefaultLoggingOptions } from "#sdk/logging"
import { ConfigurationError } from "#sdk/errors"
import { record } from "./message.js"

const integrations = new WeakMap<DefaultLogger, Logger.Logger<unknown, unknown>>()

export function adaptLogger(logger: Logger.Logger<unknown, unknown>): DefaultLogger {
    if (!Logger.isLogger(logger) || typeof logger.log !== "function")
        throw new ConfigurationError("logger", "Expected an Effect logger")
    const integration = Object.freeze({}) as DefaultLogger
    const log = logger.log.bind(logger)
    integrations.set(
        integration,
        Logger.make((entry) => {
            try {
                return log(entry)
            } catch {
                /* Logging failure must not change SDK outcomes or recurse */
            }
        }),
    )
    return integration
}

export interface Diagnostic {
    readonly event:
        | "connecting"
        | "attempt"
        | "connected"
        | "connectionLost"
        | "retry"
        | "sessionReset"
        | "connectionEnded"
        | "closing"
        | "closed"
    readonly phase?: "startup" | "recovery"
    readonly attempt?: number
    readonly delayMs?: number
    readonly mode?: "identify" | "resume"
    readonly failure?: string
    readonly shardId?: number
}

export class ClientLogging {
    constructor(
        readonly development: boolean,
        private readonly native: boolean,
        private readonly logger: Logger.Logger<unknown, unknown>,
        private readonly minimumLevel: LogLevel.LogLevel,
    ) {}

    provide<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
        return this.native
            ? effect
            : effect.pipe(
                  Effect.provideService(Logger.CurrentLoggers, new Set([this.logger])),
                  Effect.provideService(References.MinimumLogLevel, this.minimumLevel),
              )
    }

    emit(fiber: Fiber.Fiber<unknown, unknown>, diagnostic: Diagnostic) {
        if (!this.development || LogLevel.isLessThan("Info", fiber.cache.minimumLogLevel)) return
        for (const logger of fiber.getRef(Logger.CurrentLoggers)) {
            try {
                logger.log({
                    message: ["Fluxerly", Object.freeze(diagnostic)],
                    logLevel: "Info",
                    cause: Cause.empty,
                    fiber,
                    date: new Date(),
                })
            } catch {
                /* No recursive logging or effect failure on sink errors */
            }
        }
    }
}

export function loggingConfiguration(value: unknown, native: boolean): ClientLogging | ConfigurationError {
    if (value !== undefined && !record(value))
        return new ConfigurationError("logging", "Logging settings must be an object")
    const settings = (value ?? {}) as Record<string, unknown>
    const keys = native ? ["development"] : ["development", "minimumLevel", "logger"]
    if (Object.keys(settings).some((key) => !keys.includes(key)))
        return new ConfigurationError("logging", "Unsupported logging setting")
    if (settings.development !== undefined && typeof settings.development !== "boolean")
        return new ConfigurationError("development", "Development logging must be a boolean")
    const minimum = settings.minimumLevel === undefined ? "Info" : settings.minimumLevel
    if (!["All", "Trace", "Debug", "Info", "Warn", "Error", "Fatal", "None"].includes(minimum as string))
        return new ConfigurationError("minimumLevel", "Unsupported minimum log level")
    const logger =
        settings.logger === undefined ? Logger.defaultLogger : integrations.get(settings.logger as DefaultLogger)
    if (!logger) return new ConfigurationError("logger", "Use fromEffectLogger for a default logger")
    return new ClientLogging(
        settings.development === true,
        native,
        logger,
        minimum as NonNullable<DefaultLoggingOptions["minimumLevel"]>,
    )
}
