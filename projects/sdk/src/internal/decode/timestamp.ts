/**
 * The SDK's one ISO-8601 timestamp grammar for provider data and timestamp inputs.
 * Invariant: A timestamp has a calendar date, a T separator, hours, minutes and seconds, an optional fraction of any
 * length and a Z or ±hh:mm offset, names a real calendar day, and is kept exactly as received or supplied.
 * Implements [SDK contracts: Validation requirements](/docs/SDK-CONTRACTS.md#validation-requirements)
 */

const monthDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const
const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

/** Reject calendar overflow that Date.parse normalizes, such as April 31, and values Date.parse cannot read */
export function validCalendarTimestamp(value: string): boolean {
    const match = /^(\d{4})-(\d{2})-(\d{2})T/.exec(value)
    if (match === null) return false
    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    if (month < 1 || month > 12 || day < 1) return false
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
    const maximum = month === 2 && leap ? 29 : monthDays[month - 1]!
    return day <= maximum && Number.isFinite(Date.parse(value))
}

/** An ISO-8601 timestamp with seconds, any fraction and a Z or ±hh:mm offset, on a real calendar day */
export const timestamp = (value: unknown): value is string =>
    typeof value === "string" && isoTimestamp.test(value) && validCalendarTimestamp(value)

/** A timestamp or null */
export const nullableTimestamp = (value: unknown): value is string | null => value === null || timestamp(value)
