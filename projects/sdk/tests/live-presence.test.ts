import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterEach, expect, test } from "vitest"

const temporaryParent = realpathSync(tmpdir())
const roots: string[] = []
const fakeToken = "200.fixture-only-not-a-credential"

afterEach(() => {
    for (const root of roots.splice(0)) {
        const target = realpathSync(root)
        expect(dirname(target)).toBe(temporaryParent)
        expect(resolve(target)).toBe(resolve(root))
        rmSync(target, { recursive: true })
    }
})

function fixture() {
    const root = mkdtempSync(join(temporaryParent, "fluxerly-presence-live-tests-"))
    roots.push(root)
    mkdirSync(join(root, "tests/live"), { recursive: true })
    copyFileSync(new URL("./live/presence.mjs", import.meta.url), join(root, "tests/live/presence.mjs"))
    writeFileSync(
        join(root, ".env.test.local"),
        [
            "FLUXER_TEST_GUILD_ID=100",
            "FLUXER_TEST_APPLICATION_ID=200",
            `FLUXER_TEST_BOT_TOKEN=${fakeToken}`,
            "FLUXER_TEST_PRESENCE_USER_ID=400",
        ].join("\n"),
    )
    writeFileSync(
        join(root, "boundaries.mjs"),
        `globalThis.fetch = async () => { console.log("HTTP_ATTEMPT"); throw Error("Forbidden request") }`,
    )
    return root
}

function run(root: string, targetId?: string) {
    const env = { ...process.env }
    delete env.FLUXER_TEST_PRESENCE_USER_ID
    if (targetId !== undefined) env.FLUXER_TEST_PRESENCE_USER_ID = targetId
    const child = spawnSync(process.execPath, ["--import", "./boundaries.mjs", "tests/live/presence.mjs", "default"], {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
    })
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(1)
    const output = child.stdout + child.stderr
    expect(output).not.toContain(fakeToken)
    expect(output).not.toContain("HTTP_ATTEMPT")
    return output
}

test("live presence requires a currently selected process-only participant before HTTP", () => {
    expect(run(fixture())).toContain('"check":"configuration"')
    expect(run(fixture(), "invalid")).toContain('"check":"configuration"')
})

test("live presence preserves an existing shared sandbox lock before HTTP", () => {
    const root = fixture()
    const lock = join(root, ".env.test.local.lock")
    writeFileSync(lock, "fixture-owned-lock")
    expect(run(root, "400")).toContain('"check":"sandbox_lock"')
    expect(readFileSync(lock, "utf8")).toBe("fixture-owned-lock")
})
