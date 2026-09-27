// Shared safety controls for the opt-in live sandbox harnesses: the sandbox lock, env loading,
// process-only authorization, recovery journals, sandbox identity decisions and owned finalization.
// Every decision here is local. Harnesses keep their own requests, targets, cleanup and ordering, and
// pass their request function in, so this module never contacts the sandbox itself
import {
    closeSync,
    existsSync,
    openSync,
    readdirSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
    writeSync,
} from "node:fs"
import { basename, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { parseEnv } from "node:util"
import { declaredCheck } from "./check-classes.js"

/** The SDK package directory, which holds the ignored env file, the sandbox lock files and every journal */
const sdkRoot = new URL("../../../", import.meta.url)
const environmentPath = new URL(".env.test.local", sdkRoot)
const lockPath = new URL(".env.test.local.lock", sdkRoot)
export const snowflake = /^[1-9][0-9]{0,19}$/

// Values loaded as credentials. Journals refuse to record any of them
const secrets = new Set()

/**
 * A failed local safety decision. `check` names the refused control for the harness report.
 * Messages never contain credentials, IDs or file contents
 */
export class HarnessCheckError extends Error {
    constructor(check, message = check) {
        super(message)
        this.name = "HarnessCheckError"
        this.check = check
    }
}

/**
 * A held sandbox lock file that records this process ID. An existing lock file, including a stale one left by a
 * crashed run, is never replaced or removed here: the operator confirms that the recorded process has stopped before
 * removing it
 */
class SandboxLock {
    #descriptor
    #state = "held"

    constructor(path, descriptor) {
        this.path = path
        this.#descriptor = descriptor
    }

    /** Whether this process still holds the lock */
    get held() {
        return this.#state === "held"
    }

    /**
     * Releases the lock only when it still records this process. Returns whether the lock file is gone.
     * A lock that records another owner is closed but kept, and later calls keep returning false
     */
    release() {
        if (this.#state !== "held") return this.#state === "released"
        const descriptor = this.#descriptor
        this.#descriptor = undefined
        this.#state = "retained"
        try {
            const owned = readFileSync(this.path, "utf8") === String(process.pid)
            closeSync(descriptor)
            if (!owned) return false
            unlinkSync(this.path)
            if (existsSync(this.path)) return false
            this.#state = "released"
            return true
        } catch {
            try {
                closeSync(descriptor)
            } catch {
                // allow-silent: the descriptor may already be closed; the lock stays retained and false is returned
            }
            return false
        }
    }
}

/** Creates `path` exclusively and records this process ID, or returns undefined when it already exists */
function createLockFile(path, message) {
    let descriptor
    try {
        descriptor = openSync(path, "wx")
    } catch {
        return undefined
    }
    try {
        writeSync(descriptor, String(process.pid))
    } catch {
        closeSync(descriptor)
        unlinkSync(path)
        throw new HarnessCheckError("sandbox_lock", message)
    }
    return new SandboxLock(path, descriptor)
}

/** Removes a lock file this call just created, before any live request, and reports the refusal */
function refuse(lock, message) {
    lock.release()
    return new HarnessCheckError("sandbox_lock", message)
}

/**
 * Takes the sandbox lock for the running harness scenario or throws a `sandbox_lock` check error, leaving every
 * existing lock file untouched. `check` is the scenario's declaration from check-classes.js, found from the process
 * arguments by default, and an undeclared scenario is refused.
 *
 * The exclusive lock is the `path` file itself. A shared lock is the file `<path>.<key>`, one per check key, so
 * read-only and test-owned checks run together while the same check, and its journal, stay single. Each side
 * creates its own file first and then looks for the other side's files, so when a shared and an exclusive
 * acquisition race, at least one of them sees the other and backs out
 */
export function acquireLock({
    path = lockPath,
    check = declaredCheck(basename(process.argv[1] ?? ""), process.argv.slice(2)),
} = {}) {
    if (!check) throw new HarnessCheckError("sandbox_lock", "This harness scenario has no declared lock class")
    const file = path instanceof URL ? fileURLToPath(path) : path
    if (check.lockClass === "shared-state") {
        const lock = createLockFile(file, "The exclusive sandbox lock could not record its owner")
        if (!lock) throw new HarnessCheckError("sandbox_lock", "The sandbox lock is held by another run or unavailable")
        const prefix = `${basename(file)}.`
        if (readdirSync(dirname(file)).some((name) => name.startsWith(prefix)))
            throw refuse(lock, "Shared sandbox runs hold the lock")
        return lock
    }
    const lock = createLockFile(`${file}.${check.key}`, "The shared sandbox lock could not record its owner")
    if (!lock) throw new HarnessCheckError("sandbox_lock", "The same check holds a sandbox lock or left a stale one")
    if (existsSync(file)) throw refuse(lock, "An exclusive run holds the sandbox lock")
    return lock
}

/**
 * Loads and validates the sandbox env file. The bot token must be present without surrounding whitespace and the
 * guild and application IDs must be snowflakes. With `processOverrides`, process environment values take precedence
 * over the file for every key, as the harnesses that accept target IDs from either source require.
 * With `requireApplicationToken`, the token's first segment must name the configured application
 */
export function loadSandboxEnvironment({
    path = environmentPath,
    processOverrides = false,
    requireApplicationToken = false,
} = {}) {
    let file
    try {
        file = parseEnv(readFileSync(path, "utf8"))
    } catch {
        throw new HarnessCheckError("configuration", "The sandbox env file is missing or unreadable")
    }
    const env = Object.freeze(processOverrides ? { ...file, ...process.env } : { ...file })
    const token = env.FLUXER_TEST_BOT_TOKEN
    if (typeof token !== "string" || token === "" || token !== token.trim())
        throw new HarnessCheckError("configuration", "Set FLUXER_TEST_BOT_TOKEN without surrounding whitespace")
    secrets.add(token)
    if (env.FLUXER_TEST_CLIENT_SECRET) secrets.add(env.FLUXER_TEST_CLIENT_SECRET)
    const guildId = env.FLUXER_TEST_GUILD_ID
    const applicationId = env.FLUXER_TEST_APPLICATION_ID
    if (!snowflake.test(guildId ?? "") || !snowflake.test(applicationId ?? ""))
        throw new HarnessCheckError("configuration", "Set FLUXER_TEST_GUILD_ID and FLUXER_TEST_APPLICATION_ID")
    if (requireApplicationToken && token.split(".")[0] !== applicationId)
        throw new HarnessCheckError("configured_application", "The bot token does not belong to the application")
    return Object.freeze({ env, token, guildId, applicationId })
}

/**
 * Returns a target ID supplied by the current process environment only. A stored value is never authorization,
 * so the env file is not consulted
 */
export function processValue(name, pattern = snowflake) {
    const value = process.env[name]
    if (typeof value !== "string" || !pattern.test(value))
        throw new HarnessCheckError("configuration", `Set the currently authorized ${name}`)
    return value
}

/** Whether the current process explicitly authorizes an opt-in effect with `name=1`. The env file never counts */
export function processAuthorized(name) {
    return process.env[name] === "1"
}

function serialize(value) {
    const text = JSON.stringify(value)
    if (typeof text !== "string" || typeof value !== "object" || value === null || Array.isArray(value))
        throw new HarnessCheckError("journal", "A recovery journal must be an object")
    for (const secret of secrets)
        if (text.includes(secret)) throw new HarnessCheckError("journal", "Refused to record a credential in a journal")
    return text
}

/**
 * A recovery journal in the SDK directory. Writes replace the whole file atomically, refuse credentials, and
 * never leave a partially written journal behind. A corrupt journal fails closed and stays for inspection
 */
class SandboxJournal {
    constructor(path) {
        this.path = path
    }

    exists() {
        return existsSync(this.path)
    }

    read() {
        let value
        try {
            value = JSON.parse(readFileSync(this.path, "utf8"))
        } catch {
            throw new HarnessCheckError("journal", "The recovery journal is unreadable; retain it for inspection")
        }
        if (typeof value !== "object" || value === null || Array.isArray(value))
            throw new HarnessCheckError("journal", "The recovery journal is corrupt; retain it for inspection")
        return value
    }

    /** Starts a journal, failing when one already exists */
    create(value) {
        writeFileSync(this.path, serialize(value), { flag: "wx" })
    }

    save(value) {
        const text = serialize(value)
        const temporary = new URL(`${this.path.href}.tmp`)
        writeFileSync(temporary, text)
        renameSync(temporary, this.path)
    }

    /** Deletes the journal after verified restoration or removal */
    remove() {
        unlinkSync(this.path)
        if (existsSync(this.path)) throw new HarnessCheckError("journal", "The recovery journal is still present")
    }
}

/** Opens `.env.test.<name>.local` in the SDK directory */
export function openJournal(name, directory = sdkRoot) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new HarnessCheckError("journal", "Invalid journal name")
    return new SandboxJournal(new URL(`.env.test.${name}.local`, directory))
}

/** Requires the application read to match the configured application */
function checkApplication(application, applicationId) {
    if (typeof applicationId !== "string" || application?.id !== applicationId)
        throw new HarnessCheckError("application_identity", "The token does not belong to the configured application")
}

/** Requires the current user to be the application's bot and returns the bot ID */
function checkBot(user, application) {
    if (user?.bot !== true || typeof user.id !== "string" || !snowflake.test(user.id))
        throw new HarnessCheckError("bot_identity", "The token does not belong to a bot user")
    if (application?.bot?.id !== user.id)
        throw new HarnessCheckError("bot_identity", "The bot does not belong to the configured application")
    return user.id
}

/** Requires the guild read to be the configured sandbox server */
function checkServer(guild, guildId) {
    if (typeof guildId !== "string" || guild?.id !== guildId)
        throw new HarnessCheckError("test_server_identity", "The configured sandbox server is not accessible")
}

/** Checks already-read application, bot-user and guild documents and returns the bot ID */
export function checkSandboxIdentity({ application, user, guild }, { applicationId, guildId }) {
    checkApplication(application, applicationId)
    const botId = checkBot(user, application)
    checkServer(guild, guildId)
    return botId
}

/**
 * Reads and verifies bot, application and server identity through the harness's own `read(path)`, which returns
 * the parsed response body. Sequential mode reads the application, the current user and the guild in that order and
 * stops at the first mismatch. Concurrent mode issues the same three reads together
 */
export async function verifySandboxIdentity(
    read,
    { applicationId, guildId, applicationPath = "/applications/@me", concurrent = false },
) {
    const guildPath = `/guilds/${guildId}`
    if (concurrent) {
        const [application, user, guild] = await Promise.all([
            read(applicationPath),
            read("/users/@me"),
            read(guildPath),
        ])
        const botId = checkSandboxIdentity({ application, user, guild }, { applicationId, guildId })
        return Object.freeze({ application, user, guild, botId })
    }
    const application = await read(applicationPath)
    checkApplication(application, applicationId)
    const user = await read("/users/@me")
    const botId = checkBot(user, application)
    const guild = await read(guildPath)
    checkServer(guild, guildId)
    return Object.freeze({ application, user, guild, botId })
}

/**
 * Shuts down a default-API client, then runs `after` (for example closing a state observer) even when shutdown fails.
 * Returns whether shutdown proved the client closed: an Err result or a rejection returns false
 */
export async function shutdownDefaultClient(client, after) {
    try {
        return (await client.shutdown()).isOk()
    } catch {
        return false
    } finally {
        after?.()
    }
}

/**
 * Finalizes a harness in the order that keeps recovery evidence safe:
 * 1. Every owned writer closes, even after another one fails
 * 2. Only when all writers closed, each check runs in order until one fails
 * 3. Only when the run is still quiescent, remote cleanup runs, the lock is released and the watchdog is cleared.
 *    A cleanup failure keeps its journal but still releases the lock, because no writer remains
 *
 * Entries are `[finalizer, operation]` pairs, and falsy entries are skipped. `onFailure(finalizer)` receives each
 * failed finalizer name, or `cleanup` and `sandbox_lock`, and must report it and mark the run failed. A `cleanup`
 * failure also passes its error, and is reported before the lock is released.
 * Returns whether the run was quiescent. A non-quiescent run keeps its lock and watchdog
 */
export async function finalizeOwned({ writers = [], checks = [], cleanup, lock, watchdog, onFailure }) {
    let quiescent = true
    for (const entry of writers) {
        if (!entry) continue
        const [finalizer, close] = entry
        try {
            await close()
        } catch {
            quiescent = false
            onFailure(finalizer)
        }
    }
    for (const entry of checks) {
        if (!quiescent) break
        if (!entry) continue
        const [finalizer, check] = entry
        try {
            await check()
        } catch {
            quiescent = false
            onFailure(finalizer)
        }
    }
    if (!quiescent) return false
    if (cleanup)
        try {
            await cleanup()
        } catch (error) {
            onFailure("cleanup", error)
        }
    if (lock && !lock.release()) onFailure("sandbox_lock")
    if (watchdog !== undefined) clearTimeout(watchdog)
    return true
}
