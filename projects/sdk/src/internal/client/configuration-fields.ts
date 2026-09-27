/**
 * ConfigurationError construction for the connection, gateway and sharding settings added in stage 5b.
 * Invariant: Every field name used here is a documented option name, so ConfigurationError.field names the setting the
 * caller passed. Implements [SDK contracts: Connection and recovery](/docs/SDK-CONTRACTS.md#connection-and-recovery)
 */
import { ConfigurationError } from "#sdk/errors"

/** Option names these settings report */
export type ConnectionSettingField = ConfigurationError["field"]

/** Build a ConfigurationError for one of these settings */
export function settingError(
    field: ConnectionSettingField,
    message: string,
    options?: { readonly hint?: string | undefined; readonly cause?: unknown },
): ConfigurationError {
    return new ConfigurationError(field, message, options)
}
