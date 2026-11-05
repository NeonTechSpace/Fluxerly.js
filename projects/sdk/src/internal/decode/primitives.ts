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

/** A decimal snowflake string without leading zeros in provider data. "0" is accepted. Caller input uses inputId */
export const identifier = (value: unknown): value is string =>
    typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)

/** The largest ID Fluxer accepts, the signed int64 maximum */
const largestId = "9223372036854775807"

/** Whether a canonical decimal string is no greater than the signed int64 maximum */
const withinInt64 = (value: string) => value.length < 19 || (value.length === 19 && value <= largestId)

/**
 * The ID to send for a caller-supplied ID, or undefined when Fluxer refuses it. Fluxer's SnowflakeType trims the string
 * with JavaScript's trim, requires a decimal without leading zeros, "0" included, and refuses values above the signed
 * int64 maximum (packages/schema/src/primitives/SchemaPrimitives.ts:39-52, 110-116 at 0098958f). The trimmed ID is
 * returned so requests, results and cache lookups all use the form Fluxer stores. Every caller-supplied ID passes
 * through this function or inputGatewayId, never identifier, which stays strict for provider data.
 * Deliberate difference: SnowflakeType also accepts a JSON integer (SchemaPrimitives.ts:39-40), but the SDK refuses
 * number IDs. Real Fluxer IDs are larger than Number.MAX_SAFE_INTEGER, so a JavaScript number holding one has already
 * lost digits before it reaches the SDK, and sending it would act on a different ID. ID error messages say so
 */
export function inputId(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined
    const [id] = /^(?:0|[1-9][0-9]*)$/.exec(value.trim()) ?? []
    return id !== undefined && withinInt64(id) ? id : undefined
}

/**
 * The ID to send in a gateway command, or undefined when Fluxer refuses it. The gateway does not trim and refuses 0
 * (fluxer_gateway/src/utils/snowflake_id.erl:38-47, 121-160 at 0098958f). The SDK still trims, as inputId does, so
 * a caller ID means the same in every request and the gateway only receives canonical IDs
 */
export function inputGatewayId(value: unknown): string | undefined {
    const id = inputId(value)
    return id === undefined || id === "0" ? undefined : id
}

/** A frozen copy of a caller's ID list of at most maximum items, each passed through inputId, or undefined when the
 * value is not such a list. Each item is read once by index
 */
export function inputIds(value: unknown, maximum: number): readonly string[] | undefined {
    const items = snapshotArray(value, maximum)
    if (items === undefined) return undefined
    const ids: string[] = []
    for (const item of items) {
        const id = inputId(item)
        if (id === undefined) return undefined
        ids.push(id)
    }
    return Object.freeze(ids)
}

/** A canonical positive snowflake accepted by gateway commands, no greater than the signed int64 maximum */
export const gatewayIdentifier = (value: unknown): value is string =>
    identifier(value) && value !== "0" && withinInt64(value)

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

/** Whether a character code is one of the 64 base64 alphabet characters */
const base64Code = (code: number) =>
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 43 ||
    code === 47

/** The 6-bit value of a base64 alphabet character code */
const base64Value = (code: number) =>
    code >= 97 ? code - 71 : code >= 65 ? code - 65 : code >= 48 ? code + 4 : code === 43 ? 62 : 63

/** Why Fluxer refuses a base64 image value, or undefined when it accepts the value */
export type Base64ImageProblem = "format" | "padding"

/** The base64 text Fluxer reads from an image value, as its base64 image type does
 * (packages/schema/src/primitives/FileValidators.ts:17-47, 80-108 and SchemaPrimitives.ts:20-22 at 0098958f).
 * Fluxer removes U+000C and U+202E, trims surrounding whitespace and reads the text after the first comma, or all of it
 * without one, so a data URI header is not checked and bare base64 is accepted. Fluxer detects the image format from
 * the decoded bytes. The text must be nonempty whole groups of four base64 characters with at most two = only at the
 * end, and the bits before the padding must be zero, as standard encoders such as Buffer write them.
 * The text is checked in one pass, since a regular expression over it exhausts the stack for images of a few megabytes
 */
export function base64ImagePayload(
    value: unknown,
): { readonly payload: string } | { readonly problem: Base64ImageProblem } {
    const format = { problem: "format" } as const
    if (typeof value !== "string") return format
    const normalized = value.replace(/[\f\u202E]/g, "").trim()
    const payload = normalized.slice(normalized.indexOf(",") + 1)
    const length = payload.length
    if (length === 0 || length % 4 !== 0) return format
    let padding = 0
    while (padding < 3 && payload.charCodeAt(length - 1 - padding) === 61) padding++
    if (padding > 2) return format
    const end = length - padding
    for (let index = 0; index < end; index++) if (!base64Code(payload.charCodeAt(index))) return format
    if (padding === 0) return { payload }
    const last = base64Value(payload.charCodeAt(end - 1))
    return last % (padding === 1 ? 4 : 16) === 0 ? { payload } : { problem: "padding" }
}

/** Whether a nullable image value clears the image: null, or an empty string, which every route with a nullable image
 * reads as null before its schema (fluxer_api/src/api/Validator.ts:59-63 at 0098958f)
 */
export const clearsImage = (value: unknown) => value === null || value === ""

/** Whether Fluxer accepts a value as base64 image data, alone or after a data URI header. See base64ImagePayload */
export const base64Image = (value: unknown): value is string => "payload" in base64ImagePayload(value)

/** The explanation for an image value Fluxer refuses, naming its subject such as "Webhook avatar".
 * Nullable says whether null clears the image
 */
export function base64ImageExplanation(subject: string, value: unknown, nullable = true) {
    const checked = base64ImagePayload(value)
    return "problem" in checked && checked.problem === "padding"
        ? `${subject} is not canonical base64: The bits before its = padding must be zero, as Fluxer requires. Encode the bytes with Buffer's base64 encoding`
        : `${subject} must be ${nullable ? "null, an empty string or " : ""}base64 image data, alone or as a data URI`
}
