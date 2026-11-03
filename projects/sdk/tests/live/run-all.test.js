import { spawnSync } from "node:child_process"
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, test, vi } from "vitest"
import { copyHarnessSupport } from "./support/fixture-root.js"
import { journalFile, liveChecks } from "./run-all.js"

const childTimeoutMs = 60_000
// Two sequential runner children, plus one child limit for fixture setup and cleanup
vi.setConfig({ testTimeout: (2 + 1) * childTimeoutMs })

const parent = realpathSync(tmpdir())
const roots = []

afterEach(() => {
    for (const root of roots.splice(0)) {
        const target = realpathSync(root)
        expect(dirname(target)).toBe(parent)
        expect(resolve(target)).toBe(resolve(root))
        rmSync(target, { recursive: true })
    }
})

// A fixture SDK root with the real runner, a no-op build and a stand-in webhook harness. The stand-in behaves as a
// harness does: With a journal it only removes it and exits with the recovery-only code, otherwise it runs its scenario,
// which it records in fresh.log, and exits 0
function fixture() {
    const root = mkdtempSync(join(parent, "fluxerly-live-runner-"))
    roots.push(root)
    mkdirSync(join(root, "tests/live"), { recursive: true })
    copyHarnessSupport(root)
    copyFileSync(new URL("./run-all.js", import.meta.url), join(root, "tests/live/run-all.js"))
    // The runner compiles the fixture's one-line SDK into its private build copy with the real compiler
    mkdirSync(join(root, "src"))
    writeFileSync(join(root, "src/index.ts"), "export const fixture = 1\n")
    writeFileSync(
        join(root, "tsconfig.json"),
        JSON.stringify({
            compilerOptions: {
                target: "ES2024",
                module: "NodeNext",
                strict: true,
                rootDir: "src",
                outDir: "dist",
                types: [],
            },
            include: ["src/**/*.ts"],
        }),
    )
    symlinkSync(fileURLToPath(new URL("../../node_modules", import.meta.url)), join(root, "node_modules"), "junction")
    writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
            type: "module",
            scripts: {
                build: "node --eval 0",
                "test:live:standin":
                    "pnpm run build && node tests/live/webhooks.js default && node tests/live/webhooks.js effect",
            },
        }),
    )
    writeFileSync(
        join(root, "tests/live/webhooks.js"),
        `
            import { appendFileSync, existsSync, rmSync } from "node:fs"
            import { recoveredOnly } from "./support/reporting.js"
            import { stateRoot } from "./support/state-root.js"
            const journal = new URL(".env.test.webhooks.local", stateRoot)
            if (existsSync(journal)) {
                rmSync(journal)
                recoveredOnly()
                console.log(JSON.stringify({ mode: process.argv[2], check: "recovery_only", passed: true }))
            } else {
                appendFileSync(new URL("fresh.log", stateRoot), process.argv[2] + "\\n")
                console.log(JSON.stringify({ mode: process.argv[2], check: "scenario", passed: true }))
            }
        `,
    )
    return root
}

function run(root, name) {
    const out = join(root, name)
    const child = spawnSync(process.execPath, ["tests/live/run-all.js", "--out", out, "standin"], {
        cwd: root,
        encoding: "utf8",
        timeout: childTimeoutMs,
        windowsHide: true,
    })
    expect(child.error).toBeUndefined()
    expect(child.signal).toBeNull()
    expect(existsSync(join(out, "summary.txt")), `${child.stdout}${child.stderr}`).toBe(true)
    return { status: child.status, summary: readFileSync(join(out, "summary.txt"), "utf8") }
}

test("a check that only recovered a journal is not counted as passed, and the next run tests it", () => {
    const root = fixture()
    writeFileSync(join(root, ".env.test.webhooks.local"), "{}")
    const recovered = run(root, "first")
    expect(recovered.summary).toMatch(/^recovered +test-owned .* standin$/m)
    expect(recovered.summary).toContain("0 passed, 1 recovered only")
    expect(recovered.status).toBe(1)
    expect(existsSync(join(root, ".env.test.webhooks.local"))).toBe(false)
    // The recovery run stops before the second API mode, so it never starts a fresh test
    expect(existsSync(join(root, "fresh.log"))).toBe(false)

    const tested = run(root, "second")
    expect(tested.summary).toMatch(/^pass +test-owned .* standin$/m)
    expect(tested.status).toBe(0)
    // The run records each command's start and end, and the time of each harness stage line with only its names
    const lines = (file) =>
        readFileSync(join(root, "second", file), "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
    expect(lines("timeline.jsonl").map(({ check, command, code }) => ({ check, command, code }))).toEqual([
        { check: "build", command: undefined, code: 0 },
        { check: "standin", command: "webhooks.js default", code: 0 },
        { check: "standin", command: "webhooks.js effect", code: 0 },
    ])
    expect(lines("standin.stages.jsonl")).toEqual([
        { at: expect.any(String), mode: "default", check: "scenario", passed: true },
        { at: expect.any(String), mode: "effect", check: "scenario", passed: true },
    ])
    expect(tested.summary).toContain("Requests 0, hosted 429s 0, pace 750 ms")
})

// Catches: The documented recovery rerun of a paired package script cleaned up in its first API mode, and then the second
// mode found no journal and created new sandbox resources
test("a paired package script stops after a recovery-only run", () => {
    const root = fixture()
    writeFileSync(join(root, ".env.test.webhooks.local"), "{}")
    const script = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts["test:live:standin"]
    const child = spawnSync(script.replace("pnpm run build && ", ""), {
        cwd: root,
        encoding: "utf8",
        shell: true,
        timeout: childTimeoutMs,
        windowsHide: true,
    })
    expect(child.status).toBe(3)
    expect(child.stdout).toContain('"recovery_only"')
    expect(existsSync(join(root, "fresh.log"))).toBe(false)
})

// Catches: A hosted 429 in one check let the runner start the next check, adding pressure while the limit lasted
test("a hosted 429 stops the run after the running check and reports it throttled", () => {
    const root = fixture()
    const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts
    scripts["test:live:standin-second"] = "pnpm run build && node tests/live/webhooks.js default"
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", scripts }))
    // The stand-in harness meets one hosted 429 through the shared pacer. The transport is fake, so nothing is sent
    writeFileSync(
        join(root, "tests/live/webhooks.js"),
        `
            import { appendFileSync } from "node:fs"
            import { createPacer, pacedFetch } from "./support/live-pacing.js"
            import { stateRoot } from "./support/state-root.js"
            appendFileSync(new URL("started.log", stateRoot), process.argv[2] + "\\n")
            const pacer = createPacer({ logPath: process.env.FLUXERLY_LIVE_REQUEST_LOG, sleep: async () => {} })
            const limited = async () => new Response("429 - Ratelimited", { status: 429, headers: { "retry-after": "5" } })
            await pacedFetch(limited, pacer)("https://fluxer.com/api/v1/channels/123456789012345678/messages")
            console.log(JSON.stringify({ mode: process.argv[2], check: "scenario", passed: true }))
        `,
    )
    const out = join(root, "throttled")
    // One lane, so the second check would start only after the first, as the throttle stop prevents
    const child = spawnSync(
        process.execPath,
        ["tests/live/run-all.js", "--concurrency", "1", "--out", out, "standin", "standin-second"],
        {
            cwd: root,
            encoding: "utf8",
            timeout: childTimeoutMs,
            windowsHide: true,
        },
    )
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(1)
    const summary = readFileSync(join(out, "summary.txt"), "utf8")
    expect(summary).toMatch(/^skipped +test-owned .* standin-second$/m)
    expect(summary).toContain(
        "Throttled: Fluxer answered fluxer.com/api/v1/channels/:id/messages with HTTP 429 and asked for 5000 ms",
    )
    // The running check finished both of its modes, and the next check never started
    expect(readFileSync(join(root, "started.log"), "utf8")).toBe("default\neffect\n")
    // Each check's requests are logged next to its log, without credentials or bodies
    const requests = readFileSync(join(out, "standin.requests.jsonl"), "utf8").trim().split("\n")
    expect(requests.map((line) => JSON.parse(line))).toEqual([
        expect.objectContaining({ sender: "sdk", method: "GET", status: 429, headers: { "retry-after": "5" } }),
        expect.objectContaining({ sender: "sdk", method: "GET", status: 429, headers: { "retry-after": "5" } }),
    ])
})

test("every runner check maps to the journal its harness opens", () => {
    const literal = /openJournal\("([a-z0-9-]+)"\)/
    let checked = 0
    for (const check of liveChecks().values())
        for (const command of check.commands) {
            const source = readFileSync(new URL(command.harness, import.meta.url), "utf8")
            const opened = literal.exec(source)?.[1]
            if (opened === undefined) continue
            expect(journalFile(command)).toBe(`.env.test.${opened}.local`)
            checked++
        }
    expect(checked).toBeGreaterThan(10)
    // Scenarios that name their journal at run time
    expect(journalFile({ harness: "messages.js", args: ["effect", "--pins"] })).toBe(".env.test.messages-pins.local")
    expect(journalFile({ harness: "messages.js", args: ["default"] })).toBe(".env.test.messages.local")
    expect(journalFile({ harness: "command-conveniences.js", args: ["default", "waits"] })).toBe(
        ".env.test.command-conveniences-waits.local",
    )
})
