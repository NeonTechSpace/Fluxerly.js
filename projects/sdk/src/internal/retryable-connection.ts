import type { ConnectionError } from "#sdk/errors"

/** Whether a connection failure is a transport problem or a server error worth another attempt, not an HTTP rejection such as a discovery 404 */
export function retryableConnection(error: ConnectionError): boolean {
    return error.reason === "network" && (error.status === null || error.status >= 500)
}
