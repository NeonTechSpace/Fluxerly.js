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
import { afterEach, expect, test } from "vitest"

const temporaryParent = realpathSync(tmpdir())
const temporaryRoots: string[] = []

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
        const target = realpathSync(root)
        expect(dirname(target)).toBe(temporaryParent)
        expect(resolve(target)).toBe(resolve(root))
        rmSync(target, { recursive: true })
    }
})

function fixture() {
    const root = mkdtempSync(join(temporaryParent, "fluxerly-message-cleanup-"))
    temporaryRoots.push(root)
    mkdirSync(join(root, "tests/live"), { recursive: true })
    mkdirSync(join(root, "node_modules/@neontechspace"), { recursive: true })
    copyFileSync(new URL("./live/messages.mjs", import.meta.url), join(root, "tests/live/messages.mjs"))
    for (const helper of [
        "upload-diagnostics.mjs",
        "channel-fixture.mjs",
        "reaction-fixture.mjs",
        "guild-fixture.mjs",
        "moderation-fixture.mjs",
        "attachment-sources.mjs",
    ])
        copyFileSync(new URL(`./live/${helper}`, import.meta.url), join(root, `tests/live/${helper}`))
    symlinkSync(
        fileURLToPath(new URL("../", import.meta.url)),
        join(root, "node_modules/@neontechspace/fluxerly"),
        "junction",
    )
    symlinkSync(
        fileURLToPath(new URL("../node_modules/effect", import.meta.url)),
        join(root, "node_modules/effect"),
        "junction",
    )
    symlinkSync(
        fileURLToPath(new URL("../node_modules/ws", import.meta.url)),
        join(root, "node_modules/ws"),
        "junction",
    )
    writeFileSync(
        join(root, "trap.mjs"),
        `
            const name = "fluxerly-sdk-test-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            let channelPresent = true
            const fixtureFetch = async (url, options = {}) => {
                const path = new URL(url).pathname
                const method = options.method ?? "GET"
                if (path === "/v1/users/@me") throw Error("fixture moderation cleanup failure")
                if (method === "GET" && path === "/v1/guilds/100/channels")
                    return Response.json(channelPresent ? [{ id: "300", name, guild_id: "100", type: 0 }] : [])
                if (method === "GET" && path === "/v1/channels/300")
                    return channelPresent
                        ? Response.json({ id: "300", name, guild_id: "100", type: 0 })
                        : Response.json(null, { status: 404 })
                if (method === "DELETE" && path === "/v1/channels/300") {
                    channelPresent = false
                    return Response.json({})
                }
                return Response.json([])
            }
            globalThis.fetch = fixtureFetch
            process.on("exit", () => console.log(JSON.stringify({ fixture: "channel_present", channelPresent })))
        `,
    )
    const path = join(root, "tests/live/messages.mjs")
    const script = readFileSync(path, "utf8")
    const fixtureBranch = `
    if (process.env.FLUXERLY_MESSAGES_CLEANUP_FIXTURE === "1") {
        lock = openSync(lockPath, "wx")
        writeSync(lock, String(process.pid))
        guildId = "100"
        verified = true
        moderationUserId = "400"
        journal = {
            guildId: process.env.FLUXERLY_MESSAGES_INVALID_JOURNAL_FIXTURE === "1" ? "999" : guildId,
            name: "fluxerly-sdk-test-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            channelId: "300",
            moderation: {
                userId: moderationUserId,
                botId: "200",
                reason: "fluxerly-sdk-test-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-moderation",
            },
        }
        writeFileSync(journalPath, JSON.stringify(journal), { flag: "wx" })
        await cleanup()
        throw Error("Fixture cleanup unexpectedly succeeded")
    }
`
    const injected = script.replace(
        'try {\n    assert.ok(mode === "default" || mode === "effect")',
        `try {${fixtureBranch}    assert.ok(mode === "default" || mode === "effect")`,
    )
    expect(injected).not.toBe(script)
    writeFileSync(path, injected)
    return root
}

test.each(["default", "effect"])(
    "%s message live cleanup deletes the owned channel after moderation recovery fails",
    (mode) => {
        const root = fixture()
        const child = spawnSync(process.execPath, ["--import", "./trap.mjs", "tests/live/messages.mjs", mode], {
            cwd: root,
            env: { ...process.env, FLUXERLY_MESSAGES_CLEANUP_FIXTURE: "1" },
            encoding: "utf8",
            timeout: 10_000,
            windowsHide: true,
        })

        expect(child.error).toBeUndefined()
        expect(child.signal).toBeNull()
        expect(child.status).toBe(1)
        const output = child.stdout + child.stderr
        expect(output).toContain('"check":"test_channel_and_messages_removed","passed":true')
        expect(output).toContain('"fixture":"channel_present","channelPresent":false')
        expect(output).not.toContain("fixture moderation cleanup failure")
        expect(existsSync(join(root, ".env.test.messages.local"))).toBe(true)
        expect(existsSync(join(root, ".env.test.local.lock"))).toBe(false)
    },
)

test.each(["default", "effect"])(
    "%s message live cleanup retains the journal and channel when the journal guild identity is invalid",
    (mode) => {
        const root = fixture()
        const child = spawnSync(process.execPath, ["--import", "./trap.mjs", "tests/live/messages.mjs", mode], {
            cwd: root,
            env: {
                ...process.env,
                FLUXERLY_MESSAGES_CLEANUP_FIXTURE: "1",
                FLUXERLY_MESSAGES_INVALID_JOURNAL_FIXTURE: "1",
            },
            encoding: "utf8",
            timeout: 10_000,
            windowsHide: true,
        })

        expect(child.error).toBeUndefined()
        expect(child.signal).toBeNull()
        expect(child.status).toBe(1)
        const output = child.stdout + child.stderr
        expect(output).not.toContain('"check":"test_channel_and_messages_removed","passed":true')
        expect(output).toContain('"fixture":"channel_present","channelPresent":true')
        expect(existsSync(join(root, ".env.test.messages.local"))).toBe(true)
        expect(existsSync(join(root, ".env.test.local.lock"))).toBe(false)
    },
)
