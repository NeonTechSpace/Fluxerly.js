import { spawnSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { expect, test } from "vitest"

const module = new URL("./support/state-root.js", import.meta.url).href

function stateRootWith(env) {
    const child = spawnSync(
        process.execPath,
        [
            "--input-type=module",
            "--eval",
            `import { stateRoot } from ${JSON.stringify(module)}; console.log(stateRoot.href)`,
        ],
        { encoding: "utf8", env: { ...process.env, ...env }, timeout: 30_000 },
    )
    expect(child.status).toBe(0)
    return child.stdout.trim()
}

// Catches: Harnesses run from the private build copy that kept locks, journals and pacing beside the copy, where other
// runs and the recovery rerun would never see them
test("harnesses keep their live state in the SDK folder the runner names, or their own package folder", () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "fluxerly-live-state-")))
    try {
        expect(stateRootWith({ FLUXERLY_LIVE_STATE_ROOT: folder })).toBe(pathToFileURL(`${folder}/`).href)
        expect(stateRootWith({ FLUXERLY_LIVE_STATE_ROOT: "" })).toBe(new URL("../../", import.meta.url).href)
    } finally {
        rmSync(folder, { recursive: true })
    }
})
