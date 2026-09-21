import {
    createClient,
    fromStructuredLogger,
    type SdkLifecycleLogRecord,
    type SdkLogRecord,
    type SdkMeasurementLogRecord,
    type StructuredLogger,
} from "@neontechspace/fluxerly"

const records: SdkLogRecord[] = []
const logger: StructuredLogger = (record) => records.push(record)

export const structuredLoggingClient = createClient({
    token: "fixture-only-not-a-credential",
    logging: {
        development: true,
        measurements: true,
        logger: fromStructuredLogger(logger),
    },
})

export function classifyRecord(record: SdkLogRecord) {
    if (record.category === "lifecycle") {
        const lifecycle: SdkLifecycleLogRecord = record
        return lifecycle.event
    }
    if (record.category === "measurement") {
        const measurement: SdkMeasurementLogRecord = record
        return `${measurement.operation}:${measurement.stage}`
    }
    return record.event
}
