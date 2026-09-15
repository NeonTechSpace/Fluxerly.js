const monthDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const

/** Reject calendar overflow that Date.parse normalizes. Callers retain their own time, timezone and precision rules */
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
