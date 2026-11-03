// Writes the npm download history of the SDK package to src/data/npm-downloads.json, one entry per day
// from the day the package was created to the last full day. The build reads only that snapshot. The Website workflow runs
// this before each deploy, so a new version of the site starts with current numbers, and the daily 04:00 UTC refresh in
// functions/api/npm-downloads.ts counts from then on. Run with: pnpm downloads:fetch

import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { fetchNpmHistory } from "../src/lib/npm-history.ts"

const target = fileURLToPath(new URL("../src/data/npm-downloads.json", import.meta.url))

const { package: name, days } = await fetchNpmHistory(fetch, Date.now())

// One day per line, so a fresh snapshot shows up in a diff as the days it added
const lines = days.map((entry) => `        { "day": "${entry.day}", "downloads": ${entry.downloads} }`)
await mkdir(dirname(target), { recursive: true })
await writeFile(target, `{\n    "fetchedAt": ${Date.now()},\n    "package": "${name}",\n    "days": [\n${lines.join(",\n")}\n    ]\n}\n`)

const total = days.reduce((sum, entry) => sum + entry.downloads, 0)
console.log(`wrote ${days.length} days from ${days[0].day} to ${days.at(-1).day}, ${total} downloads`)
