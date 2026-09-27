import {
    createClient,
    describeError,
    errors,
    type ClientCounters,
    type ErrorInfo,
    type FailureReport,
    type LogCategory,
    type LogLevel,
    type LogRecord,
    type LogSink,
} from "@neontechspace/fluxerly"

const records: LogRecord[] = []
const sink: LogSink = (record) => records.push(record)

export const loggingClient = createClient({
    token: "fixture-only-not-a-credential",
    logging: { level: "info", categories: { rest: "debug" }, debug: ["gateway"], sink, dedupe: false },
    onError: (report: FailureReport) => {
        console.error(report.describe())
    },
})

export function summarize(record: LogRecord): string {
    const level: LogLevel = record.level
    const category: LogCategory = record.category
    const error: ErrorInfo | undefined = record.error
    return `${level} ${category} ${record.code}${error ? ` ${error.origin}:${error.name}` : ""}`
}

export function explain(error: unknown): string {
    return errors.isRetryable(error) ? `retry: ${describeError(error, { stack: false })}` : describeError(error)
}

export function droppedEvents(counters: ClientCounters): number {
    return counters.eventsDropped.overflow + counters.eventsDropped.malformed + counters.eventsDropped.collector
}
