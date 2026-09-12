import { spawnSync } from "node:child_process"
import {
    copyFileSync,
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

const parent = realpathSync(tmpdir())
const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const roots: string[] = []

afterEach(() => {
    for (const root of roots.splice(0)) {
        const target = realpathSync(root)
        expect(dirname(target)).toBe(parent)
        expect(resolve(target)).toBe(resolve(root))
        rmSync(target, { recursive: true })
    }
})

function fixture() {
    const root = mkdtempSync(join(parent, "fluxerly-users-live-"))
    roots.push(root)
    mkdirSync(join(root, "tests/live"), { recursive: true })
    copyFileSync(join(sdkRoot, "tests/live/users.mjs"), join(root, "tests/live/users.mjs"))
    copyFileSync(join(sdkRoot, "tests/live/sdk.mjs"), join(root, "tests/live/sdk.mjs"))
    mkdirSync(join(root, "node_modules"))
    for (const dependency of ["effect", "ws"])
        symlinkSync(join(sdkRoot, "node_modules", dependency), join(root, "node_modules", dependency), "junction")
    writeFileSync(
        join(root, ".env.test.local"),
        [
            "FLUXER_TEST_GUILD_ID=100",
            "FLUXER_TEST_APPLICATION_ID=200",
            "FLUXER_TEST_BOT_TOKEN=fixture-not-a-credential",
            "FLUXER_TEST_DM_USER_ID=499",
            "FLUXER_TEST_GROUP_DM_ID=599",
            "FLUXER_TEST_GROUP_EXTRA_USER_ID=600",
        ].join("\n"),
    )
    writeFileSync(
        join(root, "trap.mjs"),
        'globalThis.fetch = () => { console.log("HTTP_ATTEMPT"); throw Error("Forbidden request") }',
    )
    return root
}

function run(
    root: string,
    script: "users.mjs" | "sdk.mjs",
    args: string[],
    environment: Record<string, string | undefined> = {},
) {
    const env = { ...process.env, ...environment }
    for (const name of ["FLUXER_TEST_DM_USER_ID", "FLUXER_TEST_GROUP_DM_ID", "FLUXER_TEST_GROUP_EXTRA_USER_ID"])
        if (!(name in environment)) delete env[name]
    return spawnSync(process.execPath, ["--import", "./trap.mjs", `tests/live/${script}`, ...args], {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
    })
}

function expectNoHttp(result: ReturnType<typeof run>) {
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    const output = result.stdout + result.stderr
    expect(output).not.toContain("HTTP_ATTEMPT")
    expect(output).not.toContain("fixture-not-a-credential")
    return output
}

const marker = `fluxerly-dm-${"a".repeat(32)}`

function recoveryFixture(journal: object, state: object) {
    const root = fixture()
    writeFileSync(join(root, ".env.test.users.local"), JSON.stringify(journal))
    writeFileSync(join(root, "state.json"), JSON.stringify({ requests: [], deleted: [], ...state }))
    writeFileSync(
        join(root, "trap.mjs"),
        `import { readFileSync, writeFileSync } from "node:fs"
const statePath = new URL("./state.json", import.meta.url)
const state = JSON.parse(readFileSync(statePath, "utf8"))
const reply = (status, data = null) =>
    new Response(data === null ? null : JSON.stringify(data), { status, headers: { "content-type": "application/json" } })
const privateChannels = () => (state.privateChannels ??= [{ id: "500", type: 1, recipients: [{ id: "400" }] }])
globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    const method = init.method ?? "GET"
    state.requests.push(method + " " + url.pathname + url.search)
    const parts = url.pathname.split("/").filter(Boolean)
    const loseCloseResponse =
        state.loseCloseResponse === true && parts[0] === "v1" && parts[1] === "channels" && parts.length === 3 && method === "DELETE"
    if (state.failPrivateList === true && method === "GET" && url.pathname === "/v1/users/@me/channels") {
        writeFileSync(statePath, JSON.stringify(state))
        throw new TypeError("Test-owned private-list response loss")
    }
    let response
    if (method === "GET" && url.pathname === "/v1/applications/@me")
        response = reply(200, { id: "200", bot: { id: "300" } })
    else if (method === "GET" && url.pathname === "/v1/users/@me") response = reply(200, { id: "300", bot: true })
    else if (method === "GET" && url.pathname === "/v1/users/@me/channels") response = reply(200, privateChannels())
    else if (method === "GET" && url.pathname === "/v1/guilds/100") response = reply(200, { id: "100" })
    else if (method === "GET" && url.pathname === "/v1/guilds/100/members/400")
        response = reply(200, { user: { id: "400" } })
    else if (
        parts[0] === "v1" && parts[1] === "channels" && parts[3] === "messages" && parts.length === 4 && method === "GET"
    ) {
        const key = url.searchParams.get("before") ?? "first"
        response = reply(200, state.history?.[key] ?? [])
    } else if (
        parts[0] === "v1" && parts[1] === "channels" && parts[3] === "messages" && parts.length === 5 && method === "GET"
    ) {
        response = state.messages?.[parts[4]] === undefined ? reply(404) : reply(200, state.messages[parts[4]])
    } else if (
        parts[0] === "v1" && parts[1] === "channels" && parts[3] === "messages" && parts.length === 5 && method === "DELETE"
    ) {
        if (state.messages?.[parts[4]] === undefined) response = reply(404)
        else {
            delete state.messages[parts[4]]
            state.deleted.push(parts[4])
            response = reply(204)
        }
    } else if (parts[0] === "v1" && parts[1] === "channels" && parts.length === 3 && method === "DELETE") {
        state.privateChannels = privateChannels().filter((channel) => channel.id !== parts[2])
        if (loseCloseResponse) state.failPrivateList = true
        response = reply(204)
    } else response = reply(500, { error: "unexpected" })
    writeFileSync(statePath, JSON.stringify(state))
    if (loseCloseResponse) throw new TypeError("Test-owned close response loss")
    return response
}
`,
    )
    return root
}

function runRecovery(root: string) {
    return run(root, "users.mjs", ["default"], { FLUXER_TEST_DM_USER_ID: "400" })
}

function recoveryJournal(changes: Record<string, unknown> = {}) {
    return {
        version: 2,
        guildId: "100",
        botId: "300",
        recipient: "400",
        marker,
        dm: { id: "500", wasOpen: true },
        messages: [],
        pendingSends: {},
        ...changes,
    }
}

function message(id: string, content: string, author = "300") {
    return { id, author: { id: author }, content }
}

function readState(root: string) {
    return JSON.parse(readFileSync(join(root, "state.json"), "utf8"))
}

test("users live script rejects missing or invalid process-only selections before HTTP", () => {
    const root = fixture()
    expect(expectNoHttp(run(root, "users.mjs", ["default"]))).toContain("DM recipient")
    expect(expectNoHttp(run(root, "users.mjs", ["default"], { FLUXER_TEST_DM_USER_ID: "invalid" }))).toContain(
        "DM recipient",
    )
    expect(
        expectNoHttp(
            run(root, "users.mjs", ["default"], {
                FLUXER_TEST_DM_USER_ID: "400",
                FLUXER_TEST_GROUP_DM_ID: "invalid",
            }),
        ),
    ).toContain("group ID")
    expect(
        expectNoHttp(
            run(root, "users.mjs", ["default"], {
                FLUXER_TEST_DM_USER_ID: "400",
                FLUXER_TEST_GROUP_EXTRA_USER_ID: "invalid",
            }),
        ),
    ).toContain("group participant")
})

test("users live script ignores stored participant selections and preserves another lock", () => {
    const root = fixture()
    writeFileSync(
        join(root, ".env.test.local"),
        [
            "FLUXER_TEST_GUILD_ID=100",
            "FLUXER_TEST_APPLICATION_ID=200",
            "FLUXER_TEST_BOT_TOKEN=fixture-not-a-credential",
            "FLUXER_TEST_DM_USER_ID=499",
            "FLUXER_TEST_GROUP_DM_ID=stale-group",
            "FLUXER_TEST_GROUP_EXTRA_USER_ID=stale-extra",
            "",
        ].join("\n"),
    )
    writeFileSync(join(root, ".env.test.local.lock"), "another-run")
    const output = expectNoHttp(run(root, "users.mjs", ["default"], { FLUXER_TEST_DM_USER_ID: "400" }))
    expect(output).toContain('"stage":"configuration"')
    expect(readFileSync(join(root, ".env.test.local.lock"), "utf8")).toBe("another-run")
})

test("quality SDK script rejects process-only targets before identity HTTP", () => {
    const root = fixture()
    expect(expectNoHttp(run(root, "sdk.mjs", ["default", "--quality"]))).toContain("quality user")
    expect(
        expectNoHttp(
            run(root, "sdk.mjs", ["default", "--quality"], {
                FLUXER_TEST_DM_USER_ID: "400",
                FLUXER_TEST_GROUP_DM_ID: "invalid",
            }),
        ),
    ).toContain("quality group")
})

test("recovery deletes a journaled message buried behind 100 unrelated messages without history cleanup", () => {
    const root = recoveryFixture(
        recoveryJournal({ messages: [{ channelId: "500", id: "700", marker: `${marker}:dm-hello` }] }),
        {
            messages: { "700": message("700", `${marker}:dm-hello`) },
            history: {
                first: Array.from({ length: 100 }, (_, index) => message(String(1_000 - index), "unrelated", "999")),
            },
        },
    )
    const result = runRecovery(root)
    expect(result.status).toBe(0)
    const state = readState(root)
    expect(state.deleted).toEqual(["700"])
    expect(state.requests).toContain("GET /v1/channels/500/messages/700")
    expect(state.requests.some((request: string) => request.includes("/messages?limit="))).toBe(false)
    expect(() => readFileSync(join(root, ".env.test.users.local"), "utf8")).toThrow()
})

test("recovery reconciles one pending DM open and restores list-visible open state", () => {
    const root = recoveryFixture(recoveryJournal({ dm: { wasOpen: false, opening: true } }), { messages: {} })
    const result = runRecovery(root)
    expect(result.status).toBe(0)
    const state = readState(root)
    expect(state.requests).toContain("DELETE /v1/channels/500")
    expect(
        state.requests.filter((request: string) => request === "GET /v1/users/@me/channels").length,
    ).toBeGreaterThanOrEqual(3)
    expect(state.privateChannels).toEqual([])
    expect(() => readFileSync(join(root, ".env.test.users.local"), "utf8")).toThrow()
})

test("recovery accepts a test-opened DM already closed after its close response was lost", () => {
    const root = recoveryFixture(recoveryJournal({ dm: { id: "500", wasOpen: false, closing: true } }), {
        messages: {},
        privateChannels: [],
    })
    expect(runRecovery(root).status).toBe(0)
    const state = readState(root)
    expect(state.requests).not.toContain("DELETE /v1/channels/500")
    expect(() => readFileSync(join(root, ".env.test.users.local"), "utf8")).toThrow()
})

test("recovery records an uncertain close and finishes after its next list readback", () => {
    const root = recoveryFixture(recoveryJournal({ dm: { id: "500", wasOpen: false } }), {
        messages: {},
        loseCloseResponse: true,
    })
    expect(runRecovery(root).status).toBe(1)
    let state = readState(root)
    expect(state.privateChannels).toEqual([])
    expect(readFileSync(join(root, ".env.test.users.local"), "utf8")).toContain('"closing":true')
    state.loseCloseResponse = false
    state.failPrivateList = false
    writeFileSync(join(root, "state.json"), JSON.stringify(state))
    expect(runRecovery(root).status).toBe(0)
    state = readState(root)
    expect(state.requests.filter((request: string) => request === "DELETE /v1/channels/500")).toHaveLength(1)
    expect(() => readFileSync(join(root, ".env.test.users.local"), "utf8")).toThrow()
})

test("legacy recovery reconciles a possible lost DM open only with one current recipient match", () => {
    const root = recoveryFixture(
        { guildId: "100", botId: "300", recipient: "400", marker, dmWasOpen: false },
        { messages: {} },
    )
    expect(runRecovery(root).status).toBe(0)
    const state = readState(root)
    expect(state.requests).toContain("DELETE /v1/channels/500")
    expect(state.privateChannels).toEqual([])
    expect(() => readFileSync(join(root, ".env.test.users.local"), "utf8")).toThrow()
})

test("legacy recovery retains an unresolved possible lost DM open", () => {
    const root = recoveryFixture(
        { guildId: "100", botId: "300", recipient: "400", marker, dmWasOpen: false },
        { messages: {}, privateChannels: [] },
    )
    expect(runRecovery(root).status).toBe(1)
    expect(readState(root).deleted).toEqual([])
    expect(readFileSync(join(root, ".env.test.users.local"), "utf8")).toContain('"opening":true')
})

test("recovery retains a v2 test-opened DM with no known or pending identity", () => {
    const root = recoveryFixture(recoveryJournal({ dm: { wasOpen: false } }), { messages: {} })
    expect(runRecovery(root).status).toBe(1)
    expect(readState(root).deleted).toEqual([])
    expect(readFileSync(join(root, ".env.test.users.local"), "utf8")).toContain('"wasOpen":false')
})

test("recovery rejects an unverified journaled message channel before any message read or deletion", () => {
    const entry = { channelId: "600", id: "700", marker: `${marker}:dm-hello` }
    const root = recoveryFixture(recoveryJournal({ messages: [entry] }), {
        messages: { "700": message("700", entry.marker) },
    })
    expect(runRecovery(root).status).toBe(1)
    const state = readState(root)
    expect(state.deleted).toEqual([])
    expect(state.requests).not.toContain("GET /v1/channels/600/messages/700")
    expect(readFileSync(join(root, ".env.test.users.local"), "utf8")).toContain('"600"')
})

test("recovery retains a completed message entry without its journaled ID", () => {
    const root = recoveryFixture(recoveryJournal({ messages: [{ channelId: "500", marker: `${marker}:dm-hello` }] }), {
        messages: {},
    })
    expect(runRecovery(root).status).toBe(1)
    const state = readState(root)
    expect(state.deleted).toEqual([])
    expect(state.requests).not.toContain("GET /v1/channels/500/messages/undefined")
    expect(readFileSync(join(root, ".env.test.users.local"), "utf8")).toContain(":dm-hello")
})

test("recovery finds one pending lost-response send with bounded backwards history", () => {
    const pending = `${marker}:dm-lost`
    const root = recoveryFixture(
        recoveryJournal({ pendingSends: { "dm-lost": { channelId: "500", marker: pending } } }),
        {
            messages: { "900": message("900", pending) },
            history: {
                first: Array.from({ length: 100 }, (_, index) => message(String(1_000 - index), "unrelated", "999")),
                "901": [message("900", pending)],
            },
        },
    )
    const result = runRecovery(root)
    expect(result.status).toBe(0)
    const state = readState(root)
    expect(state.requests).toContain("GET /v1/channels/500/messages?limit=100")
    expect(state.requests).toContain("GET /v1/channels/500/messages?limit=100&before=901")
    expect(state.deleted).toEqual(["900"])
})

test("recovery preserves a journal when an uncertain send exceeds the 500-message cap", () => {
    const page = (start: number) =>
        Array.from({ length: 100 }, (_, index) => message(String(start - index), "unrelated", "999"))
    const root = recoveryFixture(
        recoveryJournal({ pendingSends: { "dm-lost": { channelId: "500", marker: `${marker}:dm-lost` } } }),
        {
            messages: {},
            history: { first: page(1_000), "901": page(900), "801": page(800), "701": page(700), "601": page(600) },
        },
    )
    const result = runRecovery(root)
    expect(result.status).toBe(1)
    expect(readState(root).deleted).toEqual([])
    expect(readFileSync(join(root, ".env.test.users.local"), "utf8")).toContain('"pendingSends"')
})

test("recovery preserves an ownership mismatch and succeeds on a later verified rerun", () => {
    const entry = { channelId: "500", id: "700", marker: `${marker}:dm-hello` }
    const root = recoveryFixture(recoveryJournal({ messages: [entry] }), {
        messages: { "700": message("700", entry.marker, "999") },
    })
    expect(runRecovery(root).status).toBe(1)
    expect(readState(root).deleted).toEqual([])
    expect(readFileSync(join(root, ".env.test.users.local"), "utf8")).toContain('"700"')
    const state = readState(root)
    state.messages["700"] = message("700", entry.marker)
    writeFileSync(join(root, "state.json"), JSON.stringify(state))
    expect(runRecovery(root).status).toBe(0)
    expect(readState(root).deleted).toEqual(["700"])
    expect(() => readFileSync(join(root, ".env.test.users.local"), "utf8")).toThrow()
})

test("an existing legacy journal selects recovery-only cleanup", () => {
    const legacy = {
        guildId: "100",
        botId: "300",
        recipient: "400",
        marker,
        dmId: "500",
        dmWasOpen: true,
    }
    const root = recoveryFixture(legacy, {
        messages: { "700": message("700", `${marker}:legacy`) },
        history: { first: [message("700", `${marker}:legacy`)] },
    })
    expect(runRecovery(root).status).toBe(0)
    expect(readState(root).deleted).toEqual(["700"])
    expect(() => readFileSync(join(root, ".env.test.users.local"), "utf8")).toThrow()
})

test("legacy recovery finds a journaled marker beyond 100 newer messages", () => {
    const legacy = { guildId: "100", botId: "300", recipient: "400", marker, dmId: "500", dmWasOpen: true }
    const root = recoveryFixture(legacy, {
        messages: { "900": message("900", `${marker}:legacy`) },
        history: {
            first: Array.from({ length: 100 }, (_, index) => message(String(1_000 - index), "unrelated", "999")),
            "901": [message("900", `${marker}:legacy`)],
        },
    })
    expect(runRecovery(root).status).toBe(0)
    const state = readState(root)
    expect(state.requests).toContain("GET /v1/channels/500/messages?limit=100")
    expect(state.requests).toContain("GET /v1/channels/500/messages?limit=100&before=901")
    expect(state.deleted).toEqual(["900"])
    expect(() => readFileSync(join(root, ".env.test.users.local"), "utf8")).toThrow()
})

test("legacy recovery retains its journal when the bounded marker scan is exhausted", () => {
    const page = (start: number) =>
        Array.from({ length: 100 }, (_, index) => message(String(start - index), "unrelated", "999"))
    const root = recoveryFixture(
        { guildId: "100", botId: "300", recipient: "400", marker, dmId: "500", dmWasOpen: true },
        {
            messages: {},
            history: { first: page(1_000), "901": page(900), "801": page(800), "701": page(700), "601": page(600) },
        },
    )
    expect(runRecovery(root).status).toBe(1)
    expect(readState(root).deleted).toEqual([])
    expect(readFileSync(join(root, ".env.test.users.local"), "utf8")).toContain(marker)
})

test("legacy recovery retains a claimed open DM without a journaled channel ID", () => {
    const root = recoveryFixture(
        {
            guildId: "100",
            botId: "300",
            recipient: "400",
            marker,
            dmWasOpen: true,
        },
        { messages: {} },
    )
    expect(runRecovery(root).status).toBe(1)
    expect(readState(root).deleted).toEqual([])
    expect(readFileSync(join(root, ".env.test.users.local"), "utf8")).toContain('"dmWasOpen":true')
})
