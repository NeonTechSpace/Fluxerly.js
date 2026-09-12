import { ConfigurationError } from "#sdk/errors"
import type { OperationSignal } from "#sdk/client"

// Validate before listener ownership or the already-aborted fast path. Accessor failures remain defects
export function operationSignalError(signal: OperationSignal | undefined): ConfigurationError | undefined {
    if (
        signal !== undefined &&
        (typeof signal !== "object" ||
            signal === null ||
            Array.isArray(signal) ||
            typeof signal.aborted !== "boolean" ||
            typeof signal.addEventListener !== "function" ||
            typeof signal.removeEventListener !== "function")
    )
        return new ConfigurationError("signal", "Operation signal must be AbortSignal-compatible")
    return undefined
}
