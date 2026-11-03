// Runs what the feature pages show. A snippet shown as a test file has to run and really test something when copied,
// so each runs under node --test against the built SDK, in a folder of its own that resolves the package as a reader's
// project does. Everything else in the folder is listed as a fragment, so a new snippet has to choose. Build the SDK first
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { after, test } from "node:test"
import { clientApp, starterSamples } from "../src/islands/samples.ts"

const web = resolve(import.meta.dirname, "..")
const sdk = resolve(web, "../sdk")
const snippets = join(web, "src/components/features/snippets")
const snippet = (file: string) => readFileSync(join(snippets, file), "utf8")

const folders: string[] = []
after(() => {
    for (const folder of folders) rmSync(folder, { recursive: true, force: true })
})

/** A folder that resolves the SDK and Effect as an installed project does, holding these files */
function project(files: Record<string, string>) {
    const folder = mkdtempSync(join(tmpdir(), "fluxerly-snippet-"))
    folders.push(folder)
    mkdirSync(join(folder, "node_modules/@neontechspace"), { recursive: true })
    symlinkSync(sdk, join(folder, "node_modules/@neontechspace/fluxerly"), "junction")
    symlinkSync(join(sdk, "node_modules/effect"), join(folder, "node_modules/effect"), "junction")
    writeFileSync(join(folder, "package.json"), JSON.stringify({ type: "module" }))
    for (const [name, text] of Object.entries(files)) writeFileSync(join(folder, name), text)
    return folder
}

// Longer than any of these takes, and only ever reached by a run that hangs
const hangGuard = 120_000

function run(folder: string, args: string[]) {
    // The parent runner's context would make a child runner report to it instead of running. The token stays unset, as in a reader's test
    const { NODE_TEST_CONTEXT: _context, FLUXER_BOT_TOKEN: _token, ...env } = process.env
    const { status, signal, stdout, stderr } = spawnSync(process.execPath, args, { cwd: folder, encoding: "utf8", timeout: hangGuard, env })
    return { status, signal, output: `${stdout}\n${stderr}` }
}

// A file with no test in it still reports as one passing test, under its own name, so only named tests count
const runTests = (files: Record<string, string>) => {
    const result = run(project(files), ["--test", "--test-reporter=spec", "--test-timeout=30000", "--test-force-exit", "bot.test.ts"])
    return { ...result, count: [...result.output.matchAll(/^✔ (.+) \(\d/gm)].filter((match) => match[1] !== "bot.test.ts").length }
}

// The snippets a page shows as a whole test, with the files beside them that a reader writes first
const tests: Record<string, Record<string, string>> = {
    "first-test.ts.txt": { "bot-options.ts": snippet("bot-options.ts.txt") },
    "throwing-test.ts.txt": {},
    "rest-respond.ts.txt": {},
    "effect-test.ts.txt": {},
    "clock-test.ts.txt": {},
}

// The rest show one idea inside a bot, or a log, a command or a helper that needs the reader's own code around it
const fragments = new Set([
    "ask-name.ts.txt",
    "bot-effect.ts.txt",
    "bot-health.ts.txt",
    "bot-options.ts.txt",
    "cache-settings.ts.txt",
    "cached-or-fetch.ts.txt",
    "command-groups.ts.txt",
    "confirm-reaction.ts.txt",
    "debug-env.sh.txt",
    "effect-all.ts.txt",
    "effect-collect.ts.txt",
    "effect-match.ts.txt",
    "effect-one-request.ts.txt",
    "effect-services.ts.txt",
    "effect-test-ping.ts.txt",
    "failed-reply.log.txt",
    "fluxer-bot.service.txt",
    "guards-cooldowns.ts.txt",
    "handler-failed.log.txt",
    "health-snapshot.ts.txt",
    "help-pages.ts.txt",
    "init-bot-test.js.txt",
    "iterate-history.ts.txt",
    "lifetime-bot.js.txt",
    "logging-configure.ts.txt",
    "observe.ts.txt",
    "on-error.ts.txt",
    "production-stop.js.txt",
    "raw-event.ts.txt",
    "read-error.ts.txt",
    "register-commands.ts.txt",
    "reply-result.ts.txt",
    "rest-call.ts.txt",
    "rest-request.ts.txt",
    "retry-reply.ts.txt",
    "search-index.ts.txt",
    "session-store.ts.txt",
    "sharding-auto.ts.txt",
    "sink-entry.ts.txt",
    "skipped-events.ts.txt",
    "starter-bot.js.txt",
    "supervisor.ts.txt",
    "two-shard.log.txt",
    "typed-arguments.ts.txt",
])

test("every snippet is either run here or listed as a fragment", () => {
    const listed = new Set([...Object.keys(tests), ...fragments])
    assert.deepEqual(readdirSync(snippets).filter((file) => !listed.has(file)), [])
    assert.deepEqual([...listed].filter((file) => !existsSync(join(snippets, file))), [])
})

for (const [file, beside] of Object.entries(tests)) {
    test(`${file} runs as a test file and passes`, () => {
        const { status, signal, output, count } = runTests({ "bot.test.ts": snippet(file), ...beside })
        assert.equal(signal, null, output)
        assert.equal(status, 0, output)
        assert.ok(count >= 1, output)
    })
}

test("the first test the starter's page shows runs against the starter bot", () => {
    const { status, output } = run(project({ "bot.js": readFileSync(join(sdk, "examples/starter/bot.js"), "utf8"), "bot.test.js": snippet("init-bot-test.js.txt") }), ["--test", "--test-timeout=30000", "--test-force-exit", "bot.test.js"])
    assert.equal(status, 0, output)
})

test("the Effect test really checks the reply", () => {
    const shown = snippet("effect-test.ts.txt")
    const wrong = shown.replace('assert.deepEqual(replies, ["Pong!"])', 'assert.deepEqual(replies, ["Something else"])')
    assert.notEqual(wrong, shown)
    const { status, output } = runTests({ "bot.test.ts": wrong })
    assert.notEqual(status, 0, output)
})

test("the test clock test passes only once the clock has moved", () => {
    const shown = snippet("clock-test.ts.txt")
    const wrong = shown.replace("    await bot.advance(tenMinutes)\n", "")
    assert.notEqual(wrong, shown)
    assert.notEqual(runTests({ "bot.test.ts": wrong }).status, 0)
})

test("the broken handler test really checks the failure", () => {
    const shown = snippet("throwing-test.ts.txt")
    const wrong = shown.replace('["commands.failed"]', '["something.else"]')
    assert.notEqual(wrong, shown)
    assert.notEqual(runTests({ "bot.test.ts": wrong }).status, 0)
})

// The Reliability guide shows the same retry sample, so a copy from either place has to stop with the bot
const reliabilityGuide = readFileSync(join(web, "content/guides/reliability.md"), "utf8")
const guideRetry = [...reliabilityGuide.matchAll(/^```ts\n([\s\S]*?)^```$/gm)].map((fence) => fence[1]!).filter((code) => code.includes("errors.isRetryable(first.error)"))
assert.equal(guideRetry.length, 1, "The Reliability guide's retry sample was not found")
const retrySamples = { "retry sample": snippet("retry-reply.ts.txt"), "Reliability guide's retry sample": guideRetry[0]! }

for (const [name, shown] of Object.entries(retrySamples)) {
    test(`a bot stopped during the ${name}'s wait lets Node exit`, () => {
        // The sample's own handler, run by the test client. Fluxer's answer asks for an hour's wait, far past the hang guard.
        // The handler asks for the wait's length right as it starts waiting, which tells the script when to stop the bot
        const sdkImport = 'import { errors, runBot } from "@neontechspace/fluxerly"\n'
        const handlers = shown.replace(sdkImport, "").replace("await runBot({", "const options = {").replace(/\}\)\s*$/, "}\n")
        assert.ok(shown.includes(sdkImport) && handlers.includes("const options = {"))
        const script = `import { createTestBot } from "@neontechspace/fluxerly/testing"
import { errors as sdkErrors } from "@neontechspace/fluxerly"
const waiting = Promise.withResolvers()
const errors = { ...sdkErrors, retryAfterMs: (error) => (waiting.resolve(), sdkErrors.retryAfterMs(error)) }
${handlers}
const bot = createTestBot(options)
await bot.ready()
bot.rest.respond("POST /channels/:id/messages", { status: 429, headers: { "retry-after": "3600" }, body: { code: "RATE_LIMITED", message: "Slow down", retry_after: 3600, global: false } })
bot.emit("MESSAGE_CREATE", bot.fixtures.message({ content: "!ping" }))
await waiting.promise
await bot.client.shutdown()
await bot.shutdown().catch(() => {})
console.log("stopped")
`
        const { status, signal, output } = run(project({ "stop.ts": script }), ["stop.ts"])
        assert.equal(signal, null, `Node still waits after the bot stopped: ${output}`)
        assert.equal(status, 0, output)
        assert.match(output, /stopped/)
    })
}

test("with an onError hook the hook gets the failure, and without one the shutdown rejects", () => {
    const script = `import assert from "node:assert/strict"
import { test } from "node:test"
import { createTestBot, UnhandledTestFailuresError } from "@neontechspace/fluxerly/testing"

const commands = { prefix: "!", commands: { broken: { execute: () => { throw new Error("Not implemented yet") } } } }
const fail = async (options) => {
    const bot = createTestBot(options)
    await bot.ready()
    bot.emit("MESSAGE_CREATE", bot.fixtures.message({ content: "!broken" }))
    await bot.idle()
    return bot
}

test("without a hook", async () => {
    const bot = await fail({ commands })
    await assert.rejects(bot.shutdown(), UnhandledTestFailuresError)
})

test("with a hook", async () => {
    const seen = []
    const bot = await fail({ commands, onError: (report) => void seen.push(report) })
    assert.equal(bot.failures().length, 0)
    await bot.shutdown()
    assert.equal(seen.length, 1)
})
`
    const { status, output } = run(project({ "hook.test.js": script }), ["--test", "--test-timeout=30000", "--test-force-exit", "hook.test.js"])
    assert.equal(status, 0, output)
})

test("each homepage sample names the file init writes for that language", async () => {
    const { writeStarterProject } = await import(join(sdk, "dist/internal/starter-project.js"))
    const templates: Record<string, string> = { JavaScript: "js", TypeScript: "ts", Effect: "effect" }
    assert.deepEqual(starterSamples.map((sample) => sample.label).sort(), Object.keys(templates).sort())
    for (const sample of starterSamples) {
        const folder = mkdtempSync(join(tmpdir(), "fluxerly-starter-"))
        folders.push(folder)
        writeStarterProject(folder, sdk, templates[sample.label])
        assert.ok(existsSync(join(folder, sample.filename)), `${sample.label}: ${sample.filename}`)
    }
})

test("the homepage's application example exits with a failure status when the bot stops on a failure", () => {
    // The sample's own lines, with createClient handing over a test client whose Fluxer rejects the token once connected
    const sdkImport = 'import { createClient } from "@neontechspace/fluxerly"'
    assert.ok(clientApp.includes(sdkImport))
    const shim = `import { createTestClient } from "@neontechspace/fluxerly/testing"
const harness = createTestClient({ logging: { level: "silent" } })
export function createClient() {
    harness.client.observeState((state) => {
        if (state === "Connected") harness.disconnect({ code: 4004 })
    })
    return harness.client
}
`
    const { status, signal, output } = run(project({ "app.js": clientApp.replace(sdkImport, 'import { createClient } from "./shim.js"'), "shim.js": shim }), ["app.js"])
    assert.equal(signal, null, output)
    assert.equal(status, 1, output)
})

// The Logging guide shows the same health helper as the feature page, so a copy from either place has to count every drop
const loggingGuide = readFileSync(join(web, "content/guides/logging.md"), "utf8")
const guideHealth = [...loggingGuide.matchAll(/^```ts\n([\s\S]*?)^```$/gm)].map((fence) => fence[1]!).filter((code) => code.includes("function healthSnapshot"))
assert.equal(guideHealth.length, 1, "The Logging guide's health helper was not found")
const healthSamples = { "health helper": snippet("health-snapshot.ts.txt"), "Logging guide's health helper": guideHealth[0]! }

for (const [name, shown] of Object.entries(healthSamples)) {
    test(`the ${name} counts an event dropped by a closed subscription`, () => {
        // One event waits behind a busy handler, then that subscription closes, which drops it for the reason closed
        const script = `import assert from "node:assert/strict"
import { createTestClient } from "@neontechspace/fluxerly/testing"
import { healthSnapshot } from "./health.ts"
await using bot = createTestClient({ logging: { level: "silent" } })
const began = Promise.withResolvers(), release = Promise.withResolvers(), seen = Promise.withResolvers()
let count = 0
const busy = bot.client.on("messageCreate", () => (began.resolve(), release.promise), { concurrency: 1 })
bot.client.on("messageCreate", () => {
    if (++count === 2) seen.resolve()
})
await bot.ready()
bot.emit("MESSAGE_CREATE", bot.fixtures.message())
await began.promise
bot.emit("MESSAGE_CREATE", bot.fixtures.message())
await seen.promise
busy.close()
release.resolve()
await bot.idle()
const dropped = bot.client.diagnostics().counters.eventsDropped
assert.equal(dropped.closed, 1)
assert.equal(healthSnapshot(bot.client).droppedEvents, Object.values(dropped).reduce((total, n) => total + n, 0))
console.log("counted")
`
        const { status, signal, output } = run(project({ "health.ts": shown, "check.ts": script }), ["check.ts"])
        assert.equal(signal, null, output)
        assert.equal(status, 0, output)
        assert.match(output, /counted/)
    })
}

// The reminder recipe saves before it schedules, so a reminder whose save failed is never sent later
const lifetimeGuide = readFileSync(join(web, "content/guides/starter-lifetime.md"), "utf8")
const reminderRecipe = [...lifetimeGuide.matchAll(/^```ts\n([\s\S]*?)^```$/gm)].map((fence) => fence[1]!).filter((code) => code.includes("function addReminder"))
assert.equal(reminderRecipe.length, 1, "The reminder recipe in the Starter lifetime guide was not found")

test("the reminder recipe sends nothing for a reminder whose save failed", () => {
    // A folder named like the store makes the save fail. The manual clock then passes the due time without real waiting
    const script = `import assert from "node:assert/strict"
import { mkdirSync, rmdirSync } from "node:fs"
import { createTestClient } from "@neontechspace/fluxerly/testing"
import { addReminder } from "./reminders.ts"
await using bot = createTestClient({ clock: "manual", logging: { level: "silent" } })
await bot.ready()
const sent = () => bot.requests().filter((request) => request.method === "POST" && request.path.endsWith("/messages")).map((request) => request.body.content)
mkdirSync("reminders.json")
await assert.rejects(addReminder(bot.client, bot.fixtures.ids.channel, 60_000, "lost"))
await bot.advance(120_000)
assert.deepEqual(sent(), [])
rmdirSync("reminders.json")
await addReminder(bot.client, bot.fixtures.ids.channel, 60_000, "kept")
await bot.advance(120_000)
assert.deepEqual(sent(), ["kept"])
console.log("checked")
`
    const { status, signal, output } = run(project({ "reminders.ts": reminderRecipe[0]!, "check.ts": script }), ["check.ts"])
    assert.equal(signal, null, output)
    assert.equal(status, 0, output)
    assert.match(output, /checked/)
})

test("the reminder recipe keeps the saved list readable when a write stops partway", () => {
    // A folder named like the temporary file makes the write fail before anything replaces the saved list, as a process
    // stopped during the write would
    const script = `import assert from "node:assert/strict"
import { mkdirSync, readFileSync } from "node:fs"
import { createTestClient } from "@neontechspace/fluxerly/testing"
import { addReminder } from "./reminders.ts"
await using bot = createTestClient({ clock: "manual", logging: { level: "silent" } })
await bot.ready()
await addReminder(bot.client, bot.fixtures.ids.channel, 60_000, "kept")
mkdirSync("reminders.json.tmp")
await assert.rejects(addReminder(bot.client, bot.fixtures.ids.channel, 60_000, "lost"))
assert.deepEqual(JSON.parse(readFileSync("reminders.json", "utf8")).map((reminder) => reminder.text), ["kept"])
console.log("checked")
`
    const { status, signal, output } = run(project({ "reminders.ts": reminderRecipe[0]!, "check.ts": script }), ["check.ts"])
    assert.equal(signal, null, output)
    assert.equal(status, 0, output)
    assert.match(output, /checked/)
})
