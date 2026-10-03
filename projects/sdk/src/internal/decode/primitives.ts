/**
 * Shared primitive decoders for provider data and local input: Records, decimal identifiers and integer ranges.
 * Invariant: Each predicate reads only the value it is given, never coerces, and accepts exactly one documented range,
 * so a failing field path traced through a decoder names the field these predicates rejected.
 * Implements [SDK contracts: Validation requirements](/docs/SDK-CONTRACTS.md#validation-requirements)
 */

const int32Minimum = -2_147_483_648
const int32Maximum = 2_147_483_647

/** A plain object, excluding null and arrays */
export const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)

/** A decimal snowflake string without leading zeros. "0" is accepted */
export const identifier = (value: unknown): value is string =>
    typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)

/** A canonical positive snowflake accepted by gateway commands, no greater than the signed int64 maximum */
export const gatewayIdentifier = (value: unknown): value is string =>
    typeof value === "string" &&
    value.length <= 19 &&
    identifier(value) &&
    value !== "0" &&
    (value.length < 19 || value <= "9223372036854775807")

/** A safe integer from minimum through maximum inclusive */
export const integerInRange = (value: unknown, minimum: number, maximum: number): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum

/** Any safe integer, including negative values */
export const safeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value)

/** A safe integer from zero through maximum, which defaults to the largest safe integer */
export const nonNegativeInteger = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number =>
    integerInRange(value, 0, maximum)

/** A signed 32-bit integer */
export const int32 = (value: unknown): value is number => integerInRange(value, int32Minimum, int32Maximum)

/** A non-negative signed 32-bit integer, the provider's count and limit range */
export const count = (value: unknown): value is number => integerInRange(value, 0, int32Maximum)

/**
 * Read named fields of a caller record at most once each, in first-use order, and return the kept value on later reads.
 * Validation and encoding then use the same value even when a getter or proxy would return another
 */
export function fieldsOnce(value: Record<string, unknown>): (key: string) => unknown {
    const values = new Map<string, unknown>()
    return (key) => {
        if (values.has(key)) return values.get(key)
        const item = value[key]
        values.set(key, item)
        return item
    }
}

/** A frozen copy of an array with at most maximum items, read once by index so later mutation cannot change it */
export function snapshotArray(value: unknown, maximum: number): readonly unknown[] | undefined {
    if (!Array.isArray(value)) return undefined
    const length = value.length
    if (length > maximum) return undefined
    // oxlint-disable-next-line unicorn/no-new-array -- preallocates the counted length once, and the loop below assigns every index
    const items = new Array<unknown>(length)
    for (let index = 0; index < length; index++) items[index] = value[index]
    return Object.freeze(items)
}
