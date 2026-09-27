import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, expect, test, vi } from "vitest"
import {
    HarnessCheckError,
    acquireLock,
    checkSandboxIdentity,
    loadSandboxEnvironment,
    openJournal,
    processAuthorized,
    processValue,
    verifySandboxIdentity,
} from "./support/harness.js"
import { pendingResolution, rejoinedBaseline } from "./support/voice-state.js"

const parent = realpathSync(tmpdir())
const roots: string[] = []
const fixtureToken = "200.fixture-only-not-a-credential"

afterEach(() => {
    vi.unstubAllEnvs()
    for (const root of roots.splice(0)) {
        const target = realpathSync(root)
        expect(dirname(target)).toBe(parent)
        expect(resolve(target)).toBe(resolve(root))
        rmSync(target, { recursive: true })
    }
})

function directory() {
    const root = mkdtempSync(join(parent, "fluxerly-live-safety-"))
    roots.push(root)
    return root
}

function refusal(operation: () => unknown) {
    try {
        operation()
    } catch (error) {
        expect(error).toBeInstanceOf(HarnessCheckError)
        return error as HarnessCheckError
    }
    throw Error("Expected the harness control to refuse")
}

async function asyncRefusal(operation: () => Promise<unknown>) {
    try {
        await operation()
    } catch (error) {
        expect(error).toBeInstanceOf(HarnessCheckError)
        return (error as HarnessCheckError).check
    }
    throw Error("Expected the harness control to refuse")
}

function environment(lines: readonly string[]) {
    const path = join(directory(), ".env.test.local")
    writeFileSync(path, lines.join("\n"))
    return path
}

const validEnvironment = [
    "FLUXER_TEST_GUILD_ID=100",
    "FLUXER_TEST_APPLICATION_ID=200",
    `FLUXER_TEST_BOT_TOKEN=${fixtureToken}`,
]

const exclusive = { lockClass: "shared-state", key: "administration" } as const
const shared = (key: string) => ({ lockClass: "test-owned", key }) as const

function lockFiles(root: string) {
    return readdirSync(root)
        .filter((name) => name.startsWith(".env.test.local.lock"))
        .sort()
}

test("an exclusive lock records its owner and is removed on release", () => {
    const root = directory()
    const path = join(root, ".env.test.local.lock")
    const lock = acquireLock({ path, check: exclusive })
    expect(readFileSync(path, "utf8")).toBe(String(process.pid))
    expect(lock.held).toBe(true)
    expect(lock.release()).toBe(true)
    expect(lockFiles(root)).toEqual([])
    expect(lock.held).toBe(false)
    expect(lock.release()).toBe(true)
})

test("shared locks for different checks are held together and released separately", () => {
    const root = directory()
    const path = join(root, ".env.test.local.lock")
    const first = acquireLock({ path, check: shared("messages-pins") })
    const second = acquireLock({ path, check: shared("webhooks") })
    expect(lockFiles(root)).toEqual([".env.test.local.lock.messages-pins", ".env.test.local.lock.webhooks"])
    expect(readFileSync(`${path}.webhooks`, "utf8")).toBe(String(process.pid))
    expect(first.release()).toBe(true)
    expect(lockFiles(root)).toEqual([".env.test.local.lock.webhooks"])
    expect(second.release()).toBe(true)
    expect(lockFiles(root)).toEqual([])
})

test("the same check cannot take its shared lock twice, so its journal has one owner", () => {
    const root = directory()
    const path = join(root, ".env.test.local.lock")
    const lock = acquireLock({ path, check: shared("webhooks") })
    expect(refusal(() => acquireLock({ path, check: shared("webhooks") })).check).toBe("sandbox_lock")
    expect(lockFiles(root)).toEqual([".env.test.local.lock.webhooks"])
    expect(lock.release()).toBe(true)
})

test("an exclusive lock is refused while any shared lock is held and leaves no file", () => {
    const root = directory()
    const path = join(root, ".env.test.local.lock")
    const reader = acquireLock({ path, check: shared("webhooks") })
    expect(refusal(() => acquireLock({ path, check: exclusive })).check).toBe("sandbox_lock")
    expect(lockFiles(root)).toEqual([".env.test.local.lock.webhooks"])
    expect(reader.release()).toBe(true)
    expect(acquireLock({ path, check: exclusive }).release()).toBe(true)
})

test("an exclusive lock refuses every other acquisition and each refused one leaves no file", () => {
    const root = directory()
    const path = join(root, ".env.test.local.lock")
    const writer = acquireLock({ path, check: exclusive })
    expect(refusal(() => acquireLock({ path, check: exclusive })).check).toBe("sandbox_lock")
    expect(refusal(() => acquireLock({ path, check: shared("webhooks") })).check).toBe("sandbox_lock")
    expect(lockFiles(root)).toEqual([".env.test.local.lock"])
    expect(readFileSync(path, "utf8")).toBe(String(process.pid))
    expect(writer.release()).toBe(true)
})

test("stale lock files from stopped processes still block and are never removed automatically", () => {
    const root = directory()
    const path = join(root, ".env.test.local.lock")
    // Process IDs are far below this value, so the recorded owners cannot be running
    writeFileSync(`${path}.webhooks`, "4294967294")
    expect(refusal(() => acquireLock({ path, check: shared("webhooks") })).check).toBe("sandbox_lock")
    expect(refusal(() => acquireLock({ path, check: exclusive })).check).toBe("sandbox_lock")
    // Other shared checks keep running beside a stale shared lock
    expect(acquireLock({ path, check: shared("invites") }).release()).toBe(true)
    expect(readFileSync(`${path}.webhooks`, "utf8")).toBe("4294967294")

    // After the operator confirms the owner stopped and removes the file, the exclusive lock is available
    rmSync(`${path}.webhooks`)
    writeFileSync(path, "4294967294")
    expect(refusal(() => acquireLock({ path, check: shared("webhooks") })).check).toBe("sandbox_lock")
    expect(lockFiles(root)).toEqual([".env.test.local.lock"])
    rmSync(path)
    expect(acquireLock({ path, check: exclusive }).release()).toBe(true)
})

test("releasing a lock that now records another owner keeps that owner's lock", () => {
    const root = directory()
    const path = join(root, ".env.test.local.lock")
    const lock = acquireLock({ path, check: exclusive })
    writeFileSync(path, "another-run")
    expect(lock.release()).toBe(false)
    expect(readFileSync(path, "utf8")).toBe("another-run")
    expect(lock.release()).toBe(false)
})

/** Runs `operation` as if the process had been started as `node <script> ...args` */
function asHarness<T>(script: string, args: readonly string[], operation: () => T) {
    const argv = process.argv
    process.argv = [process.execPath, script, ...args]
    try {
        return operation()
    } finally {
        process.argv = argv
    }
}

test("an undeclared harness scenario cannot take the lock", () => {
    const root = directory()
    const path = join(root, ".env.test.local.lock")
    const scenarios: [string, string[]][] = [
        ["tests/live/unknown.js", ["default"]],
        ["tests/live/messages.js", ["default", "--x"]],
    ]
    for (const [script, args] of scenarios)
        expect(refusal(() => asHarness(script, args, () => acquireLock({ path }))).check).toBe("sandbox_lock")
    expect(lockFiles(root)).toEqual([])
})

test("the process arguments select the declared scenario's lock", () => {
    const root = directory()
    const path = join(root, ".env.test.local.lock")
    const reader = asHarness("tests/live/messages.js", ["effect", "--pins"], () => acquireLock({ path }))
    expect(lockFiles(root)).toEqual([".env.test.local.lock.messages-pins"])
    const writer = () => asHarness("tests/live/messages.js", ["default", "--guilds"], () => acquireLock({ path }))
    expect(refusal(writer).check).toBe("sandbox_lock")
    expect(reader.release()).toBe(true)
    expect(writer().release()).toBe(true)
    expect(lockFiles(root)).toEqual([])
})

test("the env file supplies validated sandbox identity without consulting the process by default", () => {
    vi.stubEnv("FLUXER_TEST_GUILD_ID", "999")
    const loaded = loadSandboxEnvironment({ path: environment([...validEnvironment, "FLUXER_TEST_EXTRA=kept"]) })
    expect(loaded).toMatchObject({ token: fixtureToken, guildId: "100", applicationId: "200" })
    expect(loaded.env.FLUXER_TEST_EXTRA).toBe("kept")
    expect(Object.isFrozen(loaded) && Object.isFrozen(loaded.env)).toBe(true)
})

test("process values take precedence over the env file only when a harness opts in", () => {
    vi.stubEnv("FLUXER_TEST_GUILD_ID", "101")
    vi.stubEnv("FLUXER_TEST_MEMBER_ID", "400")
    const loaded = loadSandboxEnvironment({ path: environment(validEnvironment), processOverrides: true })
    expect(loaded.guildId).toBe("101")
    expect(loaded.env.FLUXER_TEST_MEMBER_ID).toBe("400")
})

test.each([
    ["a missing token", validEnvironment.slice(0, 2)],
    [
        "a token with surrounding whitespace",
        [...validEnvironment.slice(0, 2), `FLUXER_TEST_BOT_TOKEN=" ${fixtureToken}"`],
    ],
    ["a non-snowflake guild", ["FLUXER_TEST_GUILD_ID=0100", ...validEnvironment.slice(1)]],
    ["a missing application", [validEnvironment[0]!, validEnvironment[2]!]],
])("the env loader refuses %s without echoing the credential", (_name, lines) => {
    const error = refusal(() => loadSandboxEnvironment({ path: environment(lines) }))
    expect(error.check).toBe("configuration")
    expect(error.message).not.toContain(fixtureToken)
})

test("a missing env file is a configuration refusal", () => {
    expect(refusal(() => loadSandboxEnvironment({ path: join(directory(), "absent") })).check).toBe("configuration")
})

test("the application-token rule refuses a token issued for another application", () => {
    const path = environment([
        "FLUXER_TEST_GUILD_ID=100",
        "FLUXER_TEST_APPLICATION_ID=201",
        `FLUXER_TEST_BOT_TOKEN=${fixtureToken}`,
    ])
    expect(loadSandboxEnvironment({ path }).applicationId).toBe("201")
    expect(refusal(() => loadSandboxEnvironment({ path, requireApplicationToken: true })).check).toBe(
        "configured_application",
    )
})

test("process-only targets and authorizations ignore stored values", () => {
    const loaded = loadSandboxEnvironment({
        path: environment([...validEnvironment, "FLUXER_TEST_VOICE_USER_ID=400", "FLUXER_TEST_VANITY_MUTATIONS=1"]),
        processOverrides: true,
    })
    expect(loaded.env.FLUXER_TEST_VANITY_MUTATIONS).toBe("1")
    vi.stubEnv("FLUXER_TEST_VOICE_USER_ID", undefined)
    vi.stubEnv("FLUXER_TEST_VANITY_MUTATIONS", undefined)
    expect(refusal(() => processValue("FLUXER_TEST_VOICE_USER_ID")).check).toBe("configuration")
    expect(processAuthorized("FLUXER_TEST_VANITY_MUTATIONS")).toBe(false)

    vi.stubEnv("FLUXER_TEST_VOICE_USER_ID", "401")
    vi.stubEnv("FLUXER_TEST_VANITY_MUTATIONS", "1")
    expect(processValue("FLUXER_TEST_VOICE_USER_ID")).toBe("401")
    expect(processAuthorized("FLUXER_TEST_VANITY_MUTATIONS")).toBe(true)

    vi.stubEnv("FLUXER_TEST_VOICE_USER_ID", "not-an-id")
    vi.stubEnv("FLUXER_TEST_VANITY_MUTATIONS", "true")
    expect(refusal(() => processValue("FLUXER_TEST_VOICE_USER_ID")).check).toBe("configuration")
    expect(processAuthorized("FLUXER_TEST_VANITY_MUTATIONS")).toBe(false)
})

function journalIn(root: string, name = "fixture") {
    return openJournal(name, new URL(`${pathToFileURL(root).href}/`))
}

test("journal writes replace the whole record and leave no temporary file", () => {
    const root = directory()
    const journal = journalIn(root)
    expect(journal.exists()).toBe(false)
    journal.create({ marker: "fx_one", ids: [] })
    journal.save({ marker: "fx_one", ids: ["10"] })
    expect(journal.read()).toEqual({ marker: "fx_one", ids: ["10"] })
    expect(readdirSync(root)).toEqual([".env.test.fixture.local"])
    journal.remove()
    expect(journal.exists()).toBe(false)
})

test("starting a journal refuses to overwrite an existing recovery record", () => {
    const journal = journalIn(directory())
    journal.save({ marker: "fx_existing" })
    expect(() => journal.create({ marker: "fx_new" })).toThrow()
    expect(journal.read()).toEqual({ marker: "fx_existing" })
})

test.each(["{not json", "[]", "null"])("a corrupt journal %s fails closed and stays for inspection", (content) => {
    const root = directory()
    const path = join(root, ".env.test.fixture.local")
    writeFileSync(path, content)
    expect(refusal(() => journalIn(root).read()).check).toBe("journal")
    expect(readFileSync(path, "utf8")).toBe(content)
})

test("journals refuse to record a loaded credential or a non-object record", () => {
    loadSandboxEnvironment({ path: environment(validEnvironment) })
    const journal = journalIn(directory())
    journal.save({ marker: "fx_safe" })
    expect(refusal(() => journal.save({ marker: "fx_safe", leaked: `Bot ${fixtureToken}` })).check).toBe("journal")
    expect(refusal(() => journal.save([] as unknown as object)).check).toBe("journal")
    expect(journal.read()).toEqual({ marker: "fx_safe" })
    expect(refusal(() => openJournal("../escape")).check).toBe("journal")
})

const application = { id: "200", bot: { id: "300" } }
const user = { id: "300", bot: true }
const guild = { id: "100" }
const configured = { applicationId: "200", guildId: "100" }

test("identity checks accept only the configured application, its bot and the sandbox server", () => {
    expect(checkSandboxIdentity({ application, user, guild }, configured)).toBe("300")
    for (const [documents, check] of [
        [{ application: { ...application, id: "201" }, user, guild }, "application_identity"],
        [{ application, user: { ...user, bot: false }, guild }, "bot_identity"],
        [{ application, user: { ...user, id: "301" }, guild }, "bot_identity"],
        [{ application, user: { ...user, id: "not-a-snowflake" }, guild }, "bot_identity"],
        [{ application: { ...application, bot: undefined }, user, guild }, "bot_identity"],
        [{ application, user, guild: { id: "101" } }, "test_server_identity"],
        [{ application, user, guild: null }, "test_server_identity"],
    ] as const)
        expect(refusal(() => checkSandboxIdentity(documents, configured)).check).toBe(check)
})

function reader(responses: Record<string, unknown>) {
    const reads: string[] = []
    return {
        reads,
        read: async (path: string) => {
            reads.push(path)
            return responses[path]
        },
    }
}

test("sequential identity verification reads in order and stops at the first mismatch", async () => {
    const accepted = reader({ "/oauth2/applications/@me": application, "/users/@me": user, "/guilds/100": guild })
    const identity = await verifySandboxIdentity(accepted.read, {
        ...configured,
        applicationPath: "/oauth2/applications/@me",
    })
    expect(identity.botId).toBe("300")
    expect(identity.guild).toBe(guild)
    expect(accepted.reads).toEqual(["/oauth2/applications/@me", "/users/@me", "/guilds/100"])

    const mismatched = reader({ "/applications/@me": { ...application, id: "201" } })
    expect(await asyncRefusal(() => verifySandboxIdentity(mismatched.read, configured))).toBe("application_identity")
    expect(mismatched.reads).toEqual(["/applications/@me"])
})

test("concurrent identity verification issues the same three reads before deciding", async () => {
    const wrongServer = reader({ "/applications/@me": application, "/users/@me": user, "/guilds/100": { id: "7" } })
    expect(await asyncRefusal(() => verifySandboxIdentity(wrongServer.read, { ...configured, concurrent: true }))).toBe(
        "test_server_identity",
    )
    expect(wrongServer.reads.toSorted()).toEqual(["/applications/@me", "/guilds/100", "/users/@me"])
})

const baseline = { channelId: "3", muted: false, deafened: false }

test.each(["muted", "deafened"] as const)(
    "voice recovery refuses a concurrent %s change after the participant has rejoined",
    (flag) => {
        expect(refusal(() => rejoinedBaseline({ ...baseline, [flag]: true }, baseline)).check).toBe(
            "participant_voice_conflict",
        )
    },
)

test("voice recovery accepts an unchanged rejoin and keeps waiting while the participant is elsewhere", () => {
    expect(rejoinedBaseline(baseline, baseline)).toBe(true)
    expect(rejoinedBaseline({ ...baseline, channelId: null, muted: true }, baseline)).toBe(false)
    expect(rejoinedBaseline({ ...baseline, channelId: "4" }, baseline)).toBe(false)
})

test("an uncertain voice operation resolves only to its before or intended state", () => {
    const intended = { channelId: "2", muted: true, deafened: false }
    expect(pendingResolution(intended, { before: baseline, intended })).toBe("intended")
    expect(pendingResolution(baseline, { before: baseline, intended })).toBe("before")
    expect(pendingResolution({ ...baseline, deafened: true }, { before: baseline, intended })).toBe("conflict")
})
