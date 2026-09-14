import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")
const comparePaths = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

export function safePath(path) {
    if (
        !path ||
        path.includes("\\") ||
        path.includes("\0") ||
        path.startsWith("/") ||
        path.split("/").some((part) => !part || part === "." || part === "..") ||
        /^[a-z]:/i.test(path)
    )
        throw new Error("Unsafe package file path")
    return path
}

export async function readDirectory(directory) {
    const files = new Map()
    async function visit(subdirectory = "") {
        for (const entry of await readdir(join(directory, subdirectory), { withFileTypes: true })) {
            const path = subdirectory ? `${subdirectory}/${entry.name}` : entry.name
            safePath(path)
            if (entry.isDirectory()) await visit(path)
            else if (entry.isFile()) files.set(path, await readFile(join(directory, path)))
            else throw new Error("Package directories must contain only regular files and directories")
        }
    }
    await visit()
    return files
}

export function exactFiles(files) {
    return Object.fromEntries(
        [...files]
            .sort(([a], [b]) => comparePaths(a, b))
            .map(([path, bytes]) => [safePath(path), { sha256: sha256(bytes), size: bytes.length }]),
    )
}

function normalizeVersion(path, bytes) {
    if (path !== "package.json") return bytes
    const text = bytes.toString("utf8")
    const parsed = JSON.parse(text)
    parsePackageVersion(parsed.version)
    let count = 0
    let normalized = text.replace(/("version"\s*:\s*)"([^"\\]*)"/g, (match, prefix, value) => {
        count++
        if (value !== parsed.version) throw new Error("Ambiguous package version bookkeeping")
        return `${prefix}"<release-version>"`
    })
    if (count !== 1) throw new Error("Ambiguous package version bookkeeping")
    return Buffer.from(normalized)
}

function parsePackageVersion(version) {
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-(canary|rc)\.\d+)?$/.test(version))
        throw new Error("Invalid staged package version")
}

export function contentFingerprint(files) {
    if (!(files instanceof Map) || files.size === 0)
        throw new Error("An npm publishable package inventory is required")
    const hash = createHash("sha256")
    for (const [path, bytes] of [...files].sort(([a], [b]) => comparePaths(a, b))) {
        if (path === "CHANGELOG.md") continue
        hash.update(JSON.stringify([safePath(path), sha256(normalizeVersion(path, bytes))]) + "\n")
    }
    return hash.digest("hex")
}

export function assertExactFiles(actual, expected) {
    if (JSON.stringify(exactFiles(actual)) !== JSON.stringify(expected))
        throw new Error("Published package contents do not match the immutable candidate")
}

// The npm pack format is gzip-compressed POSIX tar, without links or extended headers
export function readNpmTarball(compressed) {
    const tar = gunzipSync(compressed, { maxOutputLength: 128 * 1024 * 1024 })
    const files = new Map()
    let offset = 0
    while (offset + 512 <= tar.length) {
        const header = tar.subarray(offset, offset + 512)
        if (header.every((byte) => byte === 0)) break
        const string = (start, length) =>
            header
                .subarray(start, start + length)
                .toString("utf8")
                .replace(/\0.*$/s, "")
        const checksum = Number.parseInt(string(148, 8).trim(), 8)
        const computed = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0)
        if (checksum !== computed) throw new Error("Invalid npm archive header checksum")
        const prefix = string(345, 155)
        const path = (prefix ? `${prefix}/` : "") + string(0, 100)
        const type = string(156, 1)
        const sizeText = string(124, 12).trim()
        if (!/^[0-7]+$/.test(sizeText)) throw new Error("Invalid npm archive entry size")
        const size = Number.parseInt(sizeText, 8)
        if (!Number.isSafeInteger(size) || offset + 512 + size > tar.length)
            throw new Error("Truncated npm archive entry")
        if (!path.startsWith("package/")) throw new Error("Unexpected npm archive root")
        if (type === "5") {
            const directory = path.slice(8).replace(/\/$/, "")
            if (directory) safePath(directory)
        } else if (type === "0" || type === "") {
            const file = safePath(path.slice(8))
            if (files.has(file)) throw new Error("Duplicate npm archive file")
            files.set(file, Buffer.from(tar.subarray(offset + 512, offset + 512 + size)))
        } else throw new Error("Unsupported npm archive entry type")
        offset += 512 + Math.ceil(size / 512) * 512
    }
    if (files.size === 0) throw new Error("Empty npm archive")
    return files
}
