import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Copies the shared live-harness support modules into a temporary fixture root laid out like the SDK package, so a
 * copied harness resolves `./support/*.js` and treats the fixture root as its env, lock and journal directory
 */
export function copyHarnessSupport(root: string) {
    const target = join(root, "tests/live/support")
    mkdirSync(target, { recursive: true })
    const source = new URL("./", import.meta.url)
    for (const file of readdirSync(source))
        if (file.endsWith(".js")) copyFileSync(new URL(file, source), join(target, file))
    // The support modules are ES modules, as they are inside the SDK package
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }))
}

/** The sandbox lock files in a fixture root: the exclusive lock and one shared lock per running check */
export function lockFiles(root: string) {
    return readdirSync(root)
        .filter((name) => name.startsWith(".env.test.local.lock"))
        .sort()
}
