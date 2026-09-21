import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterEach, expect, test } from "vitest"

const parent = realpathSync(tmpdir())
const roots: string[] = []
afterEach(() => {
    for (const root of roots.splice(0)) {
        const target = realpathSync(root)
        expect(dirname(target)).toBe(parent)
        expect(resolve(target)).toBe(resolve(root))
        rmSync(target, { recursive: true })
    }
})

for (const [script, helper, variable, selected, args] of [
    ["role-display-reset", "guild-fixture", "FLUXER_TEST_ROLE_RESET_GUILD_ID", "100", ["default"]],
    ["typing-interactive", "channel-fixture", "FLUXER_TEST_TYPING_USER_ID", "400", []],
] as const) {
    function run(currentSelection?: string, existingLock = false) {
        const root = mkdtempSync(join(parent, "fluxerly-manual-live-"))
        roots.push(root)
        mkdirSync(join(root, "tests/live"), { recursive: true })
        copyFileSync(new URL(`./live/${script}.js`, import.meta.url), join(root, `tests/live/${script}.mjs`))
        copyFileSync(new URL(`./live/${helper}.mjs`, import.meta.url), join(root, `tests/live/${helper}.mjs`))
        const credential = "fixture-not-a-credential"
        writeFileSync(
            join(root, ".env.test.local"),
            `FLUXER_TEST_GUILD_ID=100\nFLUXER_TEST_APPLICATION_ID=200\nFLUXER_TEST_BOT_TOKEN=${credential}\n${variable}=${selected}\n`,
        )
        writeFileSync(
            join(root, "trap.mjs"),
            'globalThis.fetch = () => { console.log("HTTP_ATTEMPT"); throw Error("Forbidden request") }',
        )
        if (existingLock) writeFileSync(join(root, ".env.test.local.lock"), "another-run")
        const env = { ...process.env }
        delete env[variable]
        if (currentSelection !== undefined) env[variable] = currentSelection
        const result = spawnSync(process.execPath, ["--import", "./trap.mjs", `tests/live/${script}.mjs`, ...args], {
            cwd: root,
            env,
            encoding: "utf8",
            timeout: 10_000,
            windowsHide: true,
        })
        expect(result.error).toBeUndefined()
        expect(result.status).toBe(1)
        const output = result.stdout + result.stderr
        expect(output).not.toContain(credential)
        expect(output).not.toContain("HTTP_ATTEMPT")
        if (existingLock) expect(readFileSync(join(root, ".env.test.local.lock"), "utf8")).toBe("another-run")
        return output
    }
    test(`${script} requires process-only current target selection before HTTP`, () => {
        expect(run()).toContain('"check":"configuration"')
        expect(run("invalid")).toContain('"check":"configuration"')
        if (script === "role-display-reset") expect(run("101")).toContain('"check":"configuration"')
    })
    test(`${script} preserves another live run's lock without HTTP`, () => {
        expect(run(selected, true)).toContain('"check":"sandbox_lock"')
    })
}
