// @ts-check
// Em-dash lint for one project folder, run by the SDK and website lint scripts: node ../scripts/em-dashes.mjs
// Repository prose uses no em dashes, so every tracked or new text file in the folder fails on one, with its position.
// Fixtures that copy Fluxer's own text keep it exactly, and an empty file list fails so a broken scan cannot pass
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const dash = String.fromCharCode(0x2014)
// Upstream text kept exactly as Fluxer publishes it
const exactUpstream = new Set(["tests/contract/fixtures/gateway-docs.json", "tests/contract/fixtures/openapi-examples.json"])
const binary = /\.(?:png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|glb|gltf|bin|zip|gz|tgz|pdf|wasm|mp4|webm)$/i

const folder = resolve(process.argv[2] ?? ".")
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: folder,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
})
    .split("\0")
    .filter((file) => file !== "" && !binary.test(file) && !exactUpstream.has(file))
if (files.length === 0) throw new Error(`No files to check in ${folder}`)

const found = []
for (const file of files) {
    let text
    try {
        text = readFileSync(resolve(folder, file), "utf8")
    } catch (error) {
        // A file deleted from the working tree but still tracked has nothing left to check
        if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") continue
        throw error
    }
    if (text.includes("\0") || !text.includes(dash)) continue
    text.split("\n").forEach((line, index) => {
        const column = line.indexOf(dash)
        if (column !== -1) found.push(`${file}:${index + 1}:${column + 1}`)
    })
}
if (found.length > 0) {
    console.error(`Em dashes found. Rephrase with a comma, colon, parentheses or two sentences:\n${found.join("\n")}`)
    process.exit(1)
}
console.log(`No em dashes in ${files.length} files`)
