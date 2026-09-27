/**
 * Validation of default-API abort signals.
 * Invariant: A signal is validated before listener ownership, and accessor failures stay defects.
 * Implements [SDK contracts: Public API model](/docs/SDK-CONTRACTS.md#public-api-model)
 */
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
        return new ConfigurationError(
            "signal",
            "The signal option must be an AbortSignal, or an object with aborted, addEventListener and removeEventListener",
            { hint: "Pass controller.signal from an AbortController, or AbortSignal.timeout(ms)" },
        )
    return undefined
}
