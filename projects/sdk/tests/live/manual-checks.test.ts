import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterEach, expect, test, vi } from "vitest"
import { copyHarnessSupport } from "./support/fixture-root.js"
import { jsonLines } from "./support/json-lines.js"

const childTimeoutMs = 60_000
// Allow every sequential child its own limit, plus one child limit for fixture setup and cleanup
vi.setConfig({ testTimeout: (3 + 1) * childTimeoutMs })

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

// Harnesses that refuse before any HTTP request. A row with a process-only target also refuses a missing or invalid
// current selection, and every row preserves a lock held by another run
const harnesses: readonly {
    readonly script: string
    readonly helper?: string
    readonly target?: { readonly variable: string; readonly selected: string; readonly rejected: readonly string[] }
    readonly args: readonly string[]
}[] = [
    {
        script: "role-display-reset",
        helper: "guild-fixture",
        target: { variable: "FLUXER_TEST_ROLE_RESET_GUILD_ID", selected: "100", rejected: ["invalid", "101"] },
        args: ["default"],
    },
    {
        script: "typing-interactive",
        helper: "channel-fixture",
        target: { variable: "FLUXER_TEST_TYPING_USER_ID", selected: "400", rejected: ["invalid"] },
        args: [],
    },
    {
        script: "presence",
        target: { variable: "FLUXER_TEST_PRESENCE_USER_ID", selected: "400", rejected: ["invalid"] },
        args: ["default"],
    },
    { script: "sandbox", args: [] },
]

for (const { script, helper, target, args } of harnesses) {
    function run(currentSelection?: string, existingLock = false) {
        const root = mkdtempSync(join(parent, "fluxerly-manual-live-"))
        roots.push(root)
        mkdirSync(join(root, "tests/live"), { recursive: true })
        copyFileSync(new URL(`./${script}.js`, import.meta.url), join(root, `tests/live/${script}.mjs`))
        if (helper) copyFileSync(new URL(`./${helper}.mjs`, import.meta.url), join(root, `tests/live/${helper}.mjs`))
        copyHarnessSupport(root)
        const credential = "200.fixture-not-a-credential"
        writeFileSync(
            join(root, ".env.test.local"),
            [
                "FLUXER_TEST_GUILD_ID=100",
                "FLUXER_TEST_APPLICATION_ID=200",
                `FLUXER_TEST_BOT_TOKEN=${credential}`,
                ...(target ? [`${target.variable}=${target.selected}`] : []),
                "",
            ].join("\n"),
        )
        writeFileSync(
            join(root, "trap.mjs"),
            'globalThis.fetch = () => { console.log("HTTP_ATTEMPT"); throw Error("Forbidden request") }',
        )
        if (existingLock) writeFileSync(join(root, ".env.test.local.lock"), "another-run")
        const env = { ...process.env }
        if (target) delete env[target.variable]
        if (target && currentSelection !== undefined) env[target.variable] = currentSelection
        const result = spawnSync(process.execPath, ["--import", "./trap.mjs", `tests/live/${script}.mjs`, ...args], {
            cwd: root,
            env,
            encoding: "utf8",
            timeout: childTimeoutMs,
            windowsHide: true,
        })
        expect(result.error).toBeUndefined()
        expect(result.status).toBe(1)
        const output = result.stdout + result.stderr
        expect(output).not.toContain(credential)
        expect(output).not.toContain("HTTP_ATTEMPT")
        if (existingLock) expect(readFileSync(join(root, ".env.test.local.lock"), "utf8")).toBe("another-run")
        return jsonLines(output)
    }
    const refused = (check: string) => expect.objectContaining({ check, passed: false })
    if (target)
        test(`${script} requires process-only current target selection before HTTP`, () => {
            expect(run()).toContainEqual(refused("configuration"))
            for (const selection of target.rejected) expect(run(selection)).toContainEqual(refused("configuration"))
        })
    test(`${script} preserves another live run's lock without HTTP`, () => {
        expect(run(target?.selected, true)).toContainEqual(refused("sandbox_lock"))
    })
}
