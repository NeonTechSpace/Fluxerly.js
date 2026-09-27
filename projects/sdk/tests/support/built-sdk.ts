/**
 * Stale-build guard for test files whose child processes or runtime scripts import the built SDK in dist instead of
 * source. The pnpm test script does not build, so without the guard those tests would silently check old code
 */
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { beforeAll } from "vitest"

const sdkRoot = fileURLToPath(new URL("../../", import.meta.url))

/** The newest modification time of any file under a directory */
function newestFile(directory: string): number {
    let newest = 0
    for (const entry of readdirSync(directory, { withFileTypes: true, recursive: true }))
        if (entry.isFile()) newest = Math.max(newest, statSync(join(entry.parentPath, entry.name)).mtimeMs)
    return newest
}

/** Why the built SDK under root cannot stand in for its current source, or undefined when it is up to date */
export function builtSdkProblem(root = sdkRoot): string | undefined {
    let built: number
    try {
        built = statSync(join(root, "dist", "index.js")).mtimeMs
    } catch {
        return "The built SDK is missing"
    }
    return newestFile(join(root, "src")) > built ? "The built SDK is older than src" : undefined
}

/** Fail every test in the calling file before it starts when dist is missing or older than the newest file in src */
export function requireBuiltSdk() {
    beforeAll(() => {
        const problem = builtSdkProblem()
        if (problem) throw new Error(`${problem}. These tests run the built SDK, so run pnpm build first`)
    })
}
