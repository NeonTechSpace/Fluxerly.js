import type { ClientCounters, ClientDiagnostics, LogRecord } from "../../src/index.js"

/**
 * Collect a client's log records in memory through the public sink option.
 * Pass `logging` to createClient, then match records by their stable code rather than message text
 */
export function captureLogs() {
    const records: LogRecord[] = []
    return {
        records,
        logging: { sink: (record: LogRecord) => void records.push(record) },
        /** Codes of every record received so far, in order */
        codes: () => records.map((record) => record.code),
        /** Records with one code, in order */
        withCode: (code: string) => records.filter((record) => record.code === code),
    }
}

/** Read a client's running diagnostics counters in either API style */
export function counters(client: { diagnostics(): ClientDiagnostics }): ClientCounters {
    return client.diagnostics().counters
}
