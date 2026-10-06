import type { LogLevelSettings } from "#sdk/logging"

/**
 * Change what this client logs while it runs.
 * Creation settings other than level and categories, such as debug, sink and format, stay fixed for the client's lifetime
 *
 * @category Logging and diagnostics
 */
export interface ClientLogging {
    /**
     * Replace the client's log level and per-category levels, effective for the next record.
     * The settings are validated like level and categories in the logging option of createClient, and omitted settings
     * return to their defaults, level info without category levels, as at creation.
     * The debug creation setting and FLUXERLY_DEBUG still lower their categories to Debug.
     * It works before, during and after a connection, and changes nothing else about the client
     *
     * @remarks
     * Returns synchronously. Invalid settings, including keys other than level and categories, throw ConfigurationError
     * and leave the previous levels in place. A throwing settings getter throws SdkDefect with code application.defect
     *
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     * export function traceRequests(client: Client) {
     *     client.logging.configure({ categories: { rest: "debug" } })
     * }
     * ```
     */
    configure(settings: LogLevelSettings): void
}
