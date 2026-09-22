import { Cause, Effect, Fiber, Logger, LogLevel, References } from "effect"
import type {
    DefaultLogger,
    DefaultLoggingOptions,
    SdkLifecycleEvent,
    SdkLifecycleLogRecord,
    SdkLogLevel,
    SdkLogRecord,
    SdkLogRecordBase,
    SdkMeasurementLogRecord,
    SdkOperationalLogRecord,
    StructuredLogger,
} from "#sdk/logging"
import { ConfigurationError } from "#sdk/errors"
import { discardInvalidCallbackReturn } from "./invalid-callback-return.js"
import { record } from "./message.js"

const integrations = new WeakMap<DefaultLogger, Logger.Logger<unknown, unknown>>()
const sdkRecords = new WeakSet<object>()

function sdkRecord<T extends SdkLogRecord>(value: T): T {
    const result = Object.freeze(value)
    sdkRecords.add(result)
    return result
}

function loggedText(message: unknown): string | undefined {
    if (typeof message === "string") return message
    if (Array.isArray(message) && message.length === 1 && typeof message[0] === "string") return message[0]
    return undefined
}

function eventSubscriptionRecord(date: Date, level: SdkLogLevel, text: string): SdkOperationalLogRecord | undefined {
    const match =
        /^Fluxerly event subscription ([A-Za-z][A-Za-z0-9]*) (handler|overflow) failure( \(error reporter also failed\))?$/.exec(
            text,
        )
    if (!match) return undefined
    return sdkRecord({
        source: "fluxerly",
        timestamp: date.toISOString(),
        level,
        category: "operation",
        event: "eventSubscriptionFailed",
        subscriptionEvent: match[1]!,
        failureKind: match[2] as "handler" | "overflow",
        ...(match[3] === undefined ? {} : { reporterFailed: true }),
    })
}

function structuredRecord(entry: Logger.Options<unknown>): SdkLogRecord {
    if (
        Array.isArray(entry.message) &&
        entry.message.length === 2 &&
        entry.message[0] === "Fluxerly" &&
        record(entry.message[1]) &&
        sdkRecords.has(entry.message[1])
    )
        return entry.message[1] as unknown as SdkLogRecord

    const text = loggedText(entry.message)
    if (text === "Fluxerly state observer failed")
        return sdkRecord({
            source: "fluxerly",
            timestamp: entry.date.toISOString(),
            level: entry.logLevel,
            category: "operation",
            event: "stateObserverFailed",
        })
    if (text !== undefined) {
        const subscription = eventSubscriptionRecord(entry.date, entry.logLevel, text)
        if (subscription) return subscription
    }
    return sdkRecord({
        source: "fluxerly",
        timestamp: entry.date.toISOString(),
        level: entry.logLevel,
        category: "operation",
        event: "operationFailed",
    })
}

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

export function adaptStructuredLogger(logger: StructuredLogger): DefaultLogger {
    if (typeof logger !== "function") throw new ConfigurationError("logger", "Expected a structured logger function")
    const integration = Object.freeze({}) as DefaultLogger
    integrations.set(
        integration,
        Logger.make((entry) => {
            const safe = structuredRecord(entry)
            try {
                discardInvalidCallbackReturn(logger(safe))
            } catch {
                /* Logging failure must not change SDK outcomes or recurse */
            }
        }),
    )
    return integration
}

export interface Diagnostic {
    readonly event: SdkLifecycleEvent
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
        readonly measurements: boolean,
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
        if (!this.development) return
        const date = new Date()
        const logged = sdkRecord({
            source: "fluxerly",
            timestamp: date.toISOString(),
            level: "Info",
            category: "lifecycle",
            ...diagnostic,
        } satisfies SdkLifecycleLogRecord)
        this.#emit(fiber, date, logged)
    }

    emitMeasurement(
        fiber: Fiber.Fiber<unknown, unknown>,
        measurement: Omit<SdkMeasurementLogRecord, keyof SdkLogRecordBase | "category" | "event">,
    ) {
        if (!this.measurements) return
        const date = new Date()
        const logged = sdkRecord({
            source: "fluxerly",
            timestamp: date.toISOString(),
            level: "Info",
            category: "measurement",
            event: "measurement",
            ...measurement,
        } satisfies SdkMeasurementLogRecord)
        this.#emit(fiber, date, logged)
    }

    #emit(fiber: Fiber.Fiber<unknown, unknown>, date: Date, logged: SdkLogRecord) {
        if (LogLevel.isLessThan(logged.level, fiber.cache.minimumLogLevel)) return
        for (const logger of fiber.getRef(Logger.CurrentLoggers)) {
            try {
                logger.log({
                    message: ["Fluxerly", logged],
                    logLevel: logged.level,
                    cause: Cause.empty,
                    fiber,
                    date,
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
    const keys = native ? ["development", "measurements"] : ["development", "measurements", "minimumLevel", "logger"]
    if (Object.keys(settings).some((key) => !keys.includes(key)))
        return new ConfigurationError("logging", "Unsupported logging setting")
    if (settings.development !== undefined && typeof settings.development !== "boolean")
        return new ConfigurationError("development", "Development logging must be a boolean")
    if (settings.measurements !== undefined && typeof settings.measurements !== "boolean")
        return new ConfigurationError("measurements", "Logging measurements must be a boolean")
    const minimum = settings.minimumLevel === undefined ? "Info" : settings.minimumLevel
    if (!["All", "Trace", "Debug", "Info", "Warn", "Error", "Fatal", "None"].includes(minimum as string))
        return new ConfigurationError("minimumLevel", "Unsupported minimum log level")
    const logger =
        settings.logger === undefined ? Logger.defaultLogger : integrations.get(settings.logger as DefaultLogger)
    if (!logger)
        return new ConfigurationError("logger", "Use fromStructuredLogger or fromEffectLogger for a default logger")
    return new ClientLogging(
        settings.development === true,
        settings.measurements === true,
        native,
        logger,
        minimum as NonNullable<DefaultLoggingOptions["minimumLevel"]>,
    )
}
