import { spawnSync } from "node:child_process"
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, test } from "vitest"
import { copyHarnessSupport, lockFiles } from "./support/fixture-root.js"
import { jsonLines } from "./support/json-lines.js"

const temporaryParent = realpathSync(tmpdir())
const temporaryRoots: string[] = []
const fixtureToken = "fixture-token-not-a-credential"

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
        const target = realpathSync(root)
        expect(dirname(target)).toBe(temporaryParent)
        expect(resolve(target)).toBe(resolve(root))
        rmSync(target, { recursive: true })
    }
})

/** A fixture root whose sandbox answers the test-channel create with a 429 that asks for a wait over ten seconds */
function fixture() {
    const root = mkdtempSync(join(temporaryParent, "fluxerly-command-conveniences-"))
    temporaryRoots.push(root)
    mkdirSync(join(root, "tests/live"), { recursive: true })
    mkdirSync(join(root, "node_modules"), { recursive: true })
    symlinkSync(
        fileURLToPath(new URL("../../node_modules/effect", import.meta.url)),
        join(root, "node_modules/effect"),
        "junction",
    )
    copyFileSync(
        new URL("./command-conveniences.js", import.meta.url),
        join(root, "tests/live/command-conveniences.mjs"),
    )
    copyHarnessSupport(root)
    writeFileSync(
        join(root, ".env.test.local"),
        `FLUXER_TEST_GUILD_ID=100\nFLUXER_TEST_APPLICATION_ID=150\nFLUXER_TEST_BOT_TOKEN=${fixtureToken}\n`,
    )
    writeFileSync(
        join(root, "trap.mjs"),
        `
            const reads = {
                "/v1/applications/@me": { id: "150", bot: { id: "200" } },
                "/v1/users/@me": { id: "200", bot: true },
                "/v1/guilds/100": { id: "100" },
                "/v1/guilds/100/members/200": { user: { id: "200" } },
                "/v1/guilds/100/channels": [],
            }
            globalThis.fetch = async (url, options = {}) => {
                const path = new URL(url).pathname
                const method = options.method ?? "GET"
                console.log(JSON.stringify({ fixture: "remote_request", method, path }))
                if (method === "GET" && reads[path]) return Response.json(reads[path])
                if (method === "POST" && path === "/v1/guilds/100/channels")
                    return Response.json({ retry_after: 60 }, { status: 429 })
                return Response.json(null, { status: 500 })
            }
        `,
    )
    return root
}

test.each(["default", "effect"])(
    "%s command conveniences removes the journal of a test-channel create that Fluxer refused with 429",
    (mode) => {
        const root = fixture()
        const child = spawnSync(
            process.execPath,
            ["--import", "./trap.mjs", "tests/live/command-conveniences.mjs", mode, "help"],
            { cwd: root, encoding: "utf8", timeout: 10_000, windowsHide: true },
        )
        expect(child.error).toBeUndefined()
        expect(child.status).toBe(1)
        const output = child.stdout + child.stderr
        expect(output).not.toContain(fixtureToken)
        const lines = jsonLines(output)
        expect(lines).toContainEqual(
            expect.objectContaining({ stage: "create_test_owned_channel", passed: false, journalRetained: true }),
        )
        // The refused create is not replayed, and cleanup confirms the channel is absent before removing the journal
        expect(lines.filter((line) => line.fixture === "remote_request" && line.method === "POST")).toHaveLength(1)
        expect(lines).toContainEqual(expect.objectContaining({ check: "planned_channel_creation_not_dispatched" }))
        expect(existsSync(join(root, ".env.test.command-conveniences-help.local"))).toBe(false)
        expect(lockFiles(root)).toEqual([])
    },
)
