// The npm download history of the SDK package, shaped for the homepage chart. The build draws it from the
// snapshot that scripts/fetch-downloads.mjs writes, so the build never reaches the network, and the page
// draws a newer history from the edge endpoint with these same functions
import { packageName, type DownloadDay } from "./npm-history"

export const packageUrl = `https://www.npmjs.com/package/${packageName}`

// Single days stay readable as steps up to about twenty weeks. A longer history is told in weeks
const weeklyAfterDays = 20 * 7

export interface DownloadPoint {
    // Days from the start of the package's first day to the end of this step
    at: number
    label: string
    count: number
    total: number
}

export interface DownloadHistory {
    unit: "day" | "week"
    // Days in the whole history, the length of the time axis
    span: number
    total: number
    points: DownloadPoint[]
    months: { at: number; label: string }[]
    // Top of the value axis and the values marked on it, above zero
    top: number
    ticks: number[]
}

const dayMs = 86_400_000
const monthName = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" })
const dayName = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" })

export const formatCount = (value: number) => value.toLocaleString("en-US")

// A round step for the value axis: 1, 2 or 5 times a power of ten, so the marks read as plain numbers
function roundStep(raw: number) {
    const power = 10 ** Math.floor(Math.log10(Math.max(raw, 1)))
    for (const factor of [1, 2, 5, 10]) if (factor * power >= raw) return factor * power
    return 10 * power
}

export function downloadHistory(days: DownloadDay[]): DownloadHistory {
    const first = Date.parse(`${days[0].day}T00:00:00Z`)
    const span = days.length
    const unit = span > weeklyAfterDays ? "week" : "day"
    const size = unit === "week" ? 7 : 1

    const points: DownloadPoint[] = []
    let total = 0
    for (let start = 0; start < span; start += size) {
        const bucket = days.slice(start, start + size)
        const count = bucket.reduce((sum, entry) => sum + entry.downloads, 0)
        total += count
        const date = dayName.format(first + start * dayMs)
        points.push({ at: start + bucket.length, label: unit === "week" ? `Week of ${date}` : date, count, total })
    }

    // The line ends below the top, with room above it for the next weeks of growth
    const step = roundStep((Math.max(total, 1) * 1.05) / 3)
    const top = Math.ceil((Math.max(total, 1) * 1.05) / step) * step
    const ticks = Array.from({ length: Math.round(top / step) }, (_, index) => (index + 1) * step)

    // Month marks at the first of each month. A long history marks every second, third or sixth month, and a
    // new year shows the year instead of January
    const starts: { at: number; month: number; year: number }[] = []
    const cursor = new Date(first)
    cursor.setUTCDate(1)
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
    while (cursor.getTime() < first + span * dayMs) {
        starts.push({ at: Math.round((cursor.getTime() - first) / dayMs), month: cursor.getUTCMonth(), year: cursor.getUTCFullYear() })
        cursor.setUTCMonth(cursor.getUTCMonth() + 1)
    }
    const every = [1, 2, 3, 6, 12].find((candidate) => Math.ceil(starts.length / candidate) <= 7) ?? 12
    const months = starts
        .filter((start) => start.month % every === 0 && start.at / span < 0.94)
        .map((start) => ({ at: start.at, label: start.month === 0 ? String(start.year) : monthName.format(Date.UTC(start.year, start.month, 1)) }))
    // A short history also names the month it starts in, when its first new month is far enough along
    if (every === 1 && (months.length === 0 || months[0].at / span > 0.18)) months.unshift({ at: 0, label: monthName.format(first) })

    return { unit, span, total, points, months, top, ticks }
}

export const plural = (count: number) => (count === 1 ? "download" : "downloads")

// What the readout shows for each step, read by the script in Maker.astro
export interface Reading {
    x: number
    y: number
    label: string
    count: string
    total: string
}

// Everything the chart shows, worked out in one place. Maker.astro draws it at build time and the script in
// it draws it again in the browser when a newer history arrives, so the two can never disagree.
// Chart space: x from 0 to 1000 across the time axis, y from 0 at the top to 1000 at the baseline. The SVG
// stretches to its box, so labels and dots are laid over it in HTML and keep their own size
export function chartView(history: DownloadHistory) {
    const { unit, span, top, total } = history
    const x = (at: number) => (at / span) * 1000
    const y = (value: number) => 1000 - (value / top) * 1000
    const percent = (value: number) => `${(value / 10).toFixed(2)}%`
    const line = [{ at: 0, total: 0 }, ...history.points].map((point, index) => `${index ? "L" : "M"} ${x(point.at).toFixed(1)} ${y(point.total).toFixed(1)}`).join(" ")
    const last = history.points.at(-1)!
    const readings: Reading[] = history.points.map((point) => ({
        x: x(point.at) / 10,
        y: y(point.total) / 10,
        label: point.label,
        count: `${formatCount(point.count)} ${plural(point.count)} that ${unit}`,
        total: `${formatCount(point.total)} in total`,
    }))

    return {
        unit,
        total: formatCount(total),
        word: plural(total),
        line,
        area: `${line} L 1000 1000 L 0 1000 Z`,
        gridlines: history.ticks.map(y),
        ticks: history.ticks.map((tick) => ({ label: formatCount(tick), top: percent(y(tick)) })),
        months: history.months.map((month) => ({ label: month.label, left: percent(x(month.at)) })),
        bead: { left: percent(x(last.at)), top: percent(y(last.total)) },
        readings,
        rows: history.points.map((point) => ({ label: point.label, count: formatCount(point.count), total: formatCount(point.total) })),
        plotLabel: `Running total by ${unit}. The arrow keys read each ${unit}`,
        firstColumn: unit === "week" ? "Week" : "Day",
    }
}

export type ChartView = ReturnType<typeof chartView>
