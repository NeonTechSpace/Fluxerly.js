// The npm download history of the SDK package, fetched from npm's public APIs. One implementation serves the
// snapshot script (scripts/fetch-downloads.mjs) and the edge endpoint (functions/api/npm-downloads.ts), and the
// page checks what it receives with the same validator. Fetch and the current time are parameters so a test can
// fake both

export const packageName = "@neontechspace/fluxerly"

export interface DownloadDay {
    // The calendar day in UTC, like 2026-09-14
    day: string
    downloads: number
}

export interface NpmHistory {
    package: string
    days: DownloadDay[]
}

const dayMs = 86_400_000
// The downloads API answers at most 18 months per request, so a year per request stays well inside it
const chunkDays = 365
// A request that npm never answers must not hold the page or the refresh open
const requestTimeoutMs = 10_000

export const isoDay = (time: number) => new Date(time).toISOString().slice(0, 10)

// One day per entry, in a row from the first day on, each with a whole number of downloads. The chart places
// its points by position, so a gap, a repeat or a day out of order would draw the wrong history
export function isNpmHistory(value: unknown): value is NpmHistory {
    if (typeof value !== "object" || value === null) return false
    const { package: name, days } = value as { package?: unknown; days?: unknown }
    if (name !== packageName || !Array.isArray(days) || days.length === 0) return false
    const first = Date.parse(`${days[0]?.day}T00:00:00Z`)
    if (!Number.isFinite(first)) return false
    return days.every((entry, index) => {
        if (typeof entry !== "object" || entry === null) return false
        const { day, downloads } = entry as { day?: unknown; downloads?: unknown }
        return day === isoDay(first + index * dayMs) && Number.isSafeInteger(downloads) && (downloads as number) >= 0
    })
}

async function json(fetchJson: typeof fetch, url: string): Promise<unknown> {
    const response = await fetchJson(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(requestTimeoutMs) })
    if (!response.ok) throw new Error(`${url} answered ${response.status}`)
    return response.json()
}

// One entry per day from the day the package was created to the last day npm has counted. Throws when npm
// cannot be reached or answers with anything the chart could not draw
export async function fetchNpmHistory(fetchJson: typeof fetch, now: number): Promise<NpmHistory> {
    const registry = (await json(fetchJson, `https://registry.npmjs.org/${packageName}`)) as { time?: { created?: unknown } }
    const created = Date.parse(String(registry?.time?.created))
    if (!Number.isFinite(created)) throw new Error(`The registry has no creation date for ${packageName}`)

    const first = Date.parse(`${isoDay(created)}T00:00:00Z`)
    // Today is still being counted, so the history ends with yesterday in UTC, the time zone npm counts in
    const last = Date.parse(`${isoDay(now)}T00:00:00Z`) - dayMs
    if (last < first) throw new Error(`${packageName} has no full day of downloads yet`)

    const days: DownloadDay[] = []
    for (let start = first; start <= last; start += chunkDays * dayMs) {
        const end = Math.min(last, start + (chunkDays - 1) * dayMs)
        const range = (await json(fetchJson, `https://api.npmjs.org/downloads/range/${isoDay(start)}:${isoDay(end)}/${packageName}`)) as {
            downloads?: unknown
        }
        if (!Array.isArray(range?.downloads)) throw new Error(`The downloads from ${isoDay(start)} to ${isoDay(end)} are not a list`)
        const counts = new Map(range.downloads.map((entry: { day: string; downloads: number }) => [entry?.day, entry?.downloads]))
        // A day the API leaves out had no downloads it counted
        for (let day = start; day <= end; day += dayMs) days.push({ day: isoDay(day), downloads: counts.get(isoDay(day)) ?? 0 })
    }

    // npm publishes a day's count some hours after the day ends, so the newest days can read 0 while they are
    // still being counted. Ending the history at the last counted day keeps the total and stops the line from
    // looking stalled
    while (days.length > 1 && days.at(-1)!.downloads === 0) days.pop()

    const history = { package: packageName, days }
    if (!isNpmHistory(history)) throw new Error("npm answered with download counts that are not whole numbers")
    return history
}
