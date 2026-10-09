import type { LogLevelSettings } from "#sdk/logging"

/**
 * Change what this client logs while it runs.
 * Creation settings other than level, categories and debug, such as sink and format, stay fixed for the client's lifetime
 *
 * @category Logging and diagnostics
 */
export interface ClientLogging {
    /**
     * Replace the client's log level and per-category levels, and optionally its Debug categories, effective for the next record.
     * The settings are validated like level, categories and debug in the logging option of createClient.
     * Omitted level and categories return to their defaults, level info without category levels, as at creation.
     * An omitted debug keeps the current Debug categories, which start as the debug creation setting plus FLUXERLY_DEBUG.
     * A debug value replaces them, including those from FLUXERLY_DEBUG: true for every category, a list for those
     * categories, and false or an empty list for none. Debug categories lower their threshold to Debug, never raise it.
     * It works before, during and after a connection, and changes nothing else about the client
     *
     * @remarks
     * Returns synchronously. Invalid settings, including keys other than level, categories and debug, throw
     * ConfigurationError and leave the previous settings in place. A throwing settings getter throws SdkDefect with code
     * application.defect
     *
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly/effect"
     * export function traceRequests(client: Client) {
     *     client.logging.configure({ categories: { rest: "debug" } })
     * }
     * export function stopDebugOutput(client: Client) {
     *     client.logging.configure({ debug: false })
     * }
     * ```
     */
    configure(settings: LogLevelSettings): void
}
