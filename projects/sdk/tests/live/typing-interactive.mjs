import assert from "node:assert/strict"
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs"
import { createInterface } from "node:readline"
import { setTimeout as sleep } from "node:timers/promises"
import { parseEnv } from "node:util"
import { createGuildChannelFixture, cleanupGuildChannelFixtures } from "./channel-fixture.mjs"

const targetId = process.env.FLUXER_TEST_TYPING_USER_ID
const lockPath = new URL("../../.env.test.local.lock", import.meta.url)
const journalPath = new URL("../../.env.test.typing.local", import.meta.url)
const rawFetch = globalThis.fetch
let stage = "configuration"
let mode = "setup"
let lock, token, guildId, botId, journal, terminal
let verified = false
let confirmedMode
let confirmationSource
let stopped = false
const report = (check, details = {}) => console.log(JSON.stringify({ mode, check, passed: true, ...details }))

async function api(method, path, body) {
    const response = await rawFetch(`https://api.fluxer.app/v1${path}`, {
        method,
        headers: {
            Authorization: `Bot ${token}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
    })
    const data = response.status === 204 ? (await response.body?.cancel(), null) : await response.json()
    assert.ok(response.ok || (method === "GET" && response.status === 404))
    return { status: response.status, data }
}

async function cleanup() {
    if (!verified || !journal) return
    assert.equal(journal.kind, "interactive-typing")
    assert.equal(journal.guildId, guildId)
    assert.equal(journal.botId, botId)
    await cleanupGuildChannelFixtures(api, journal)
    unlinkSync(journalPath)
    journal = undefined
    report("test_channel_removed")
}

async function runMode(channel) {
    const sdk = await import(mode === "default" ? "@neontechspace/fluxerly" : "@neontechspace/fluxerly/effect")
    const { Effect, Exit, Scope } = await import("effect")
    const scope = mode === "effect" ? Scope.makeUnsafe() : undefined
    const value = async (operation) => {
        if (mode === "default") {
            const result = await operation
            if (result.isErr()) throw result.error
            return result.value
        }
        const result = await Effect.runPromise(Effect.result(operation))
        if (result._tag === "Failure") throw result.failure
        return result.success
    }
    let client
    let received = false
    let handlerFailed = false
    let ready = false
    let typingRequests = 0
    let lastTypingAt = 0
    const earliest = Math.floor(Date.now() / 1000) - 5
    confirmedMode = undefined
    confirmationSource = undefined
    try {
        const creating = sdk.createClient({ token })
        client = await value(scope ? creating.pipe(Scope.provide(scope)) : creating)
        const on = (event, receive) => {
            const options = {
                maxPendingMessages: 16,
                maxPendingBytes: 65_536,
                onError:
                    mode === "default"
                        ? () => {
                              handlerFailed = true
                          }
                        : () =>
                              Effect.sync(() => {
                                  handlerFailed = true
                              }),
            }
            const registered = client.on(
                event,
                mode === "default" ? receive : (item) => Effect.sync(() => receive(item)),
                options,
            )
            return value(scope ? registered.pipe(Scope.provide(scope)) : registered)
        }
        await on("guildCreate", (event) => {
            if (event.id === guildId) ready = true
        })
        await on("typingStart", (event) => {
            if (event.channelId !== channel.id || event.userId !== targetId) return
            assert.ok(Object.isFrozen(event))
            assert.ok(event.guildId === undefined || event.guildId === guildId)
            assert.ok(
                Number.isSafeInteger(event.timestamp) &&
                    event.timestamp >= earliest &&
                    event.timestamp <= Date.now() / 1000 + 5,
            )
            if (!received)
                report("inbound_typing_observed", { frozen: true, guildContext: event.guildId !== undefined })
            received = true
        })
        await value(client.connect())
        const readinessDeadline = performance.now() + 15_000
        while (!ready) {
            assert.ok(
                !stopped && !handlerFailed && client.state === "Connected" && performance.now() < readinessDeadline,
            )
            await sleep(25)
        }
        globalThis.fetch = async (request, options) => {
            const url = new URL(typeof request === "string" || request instanceof URL ? request : request.url)
            if (url.pathname !== `/v1/channels/${channel.id}/typing`) return rawFetch(request, options)
            assert.equal(options?.method, "POST")
            assert.equal(options.body, undefined)
            const now = performance.now()
            assert.ok(typingRequests === 0 || now - lastTypingAt >= 7_950)
            lastTypingAt = now
            const response = await rawFetch(request, options)
            assert.equal(response.status, 204)
            typingRequests++
            assert.ok(typingRequests <= 25)
            return response
        }
        stage = "await_human_typing_check"
        const task = async (signal) => {
            report(stage, {
                channelId: channel.id,
                channelName: channel.name,
                guildId,
                confirmCommand: `visible ${mode}`,
            })
            const deadline = performance.now() + 180_000
            while (!(received && confirmedMode === mode && typingRequests >= 2)) {
                assert.ok(!stopped && !handlerFailed && client.state === "Connected" && performance.now() < deadline)
                await sleep(25, undefined, { signal })
            }
        }
        await value(client.messages.keepTyping(channel.id, mode === "default" ? task : Effect.promise(task)))
        report("outbound_visibility_confirmed", {
            source: confirmationSource,
            inboundObserved: received,
            typingRequests,
        })
        stage = "typing_refresh_stopped"
        const count = typingRequests
        await sleep(8_500)
        assert.equal(typingRequests, count)
        report(stage)
    } finally {
        globalThis.fetch = rawFetch
        try {
            if (client) {
                await value(client.shutdown())
                assert.equal(client.state, "Closed")
            }
        } finally {
            if (scope) await Effect.runPromise(Scope.close(scope, Exit.void))
        }
        report("client_closed")
    }
}

const watchdog = setTimeout(() => {
    console.error(JSON.stringify({ mode, check: stage, passed: false, reason: "deadline", cleanupVerified: false }))
    process.exit(1)
}, 480_000).unref()

try {
    assert.equal(process.argv.length, 2)
    assert.match(targetId ?? "", /^[1-9][0-9]{0,19}$/)
    const env = parseEnv(readFileSync(new URL("../../.env.test.local", import.meta.url), "utf8"))
    guildId = env.FLUXER_TEST_GUILD_ID
    token = env.FLUXER_TEST_BOT_TOKEN
    assert.ok(token && token === token.trim())
    assert.match(guildId ?? "", /^[1-9][0-9]{0,19}$/)
    assert.match(env.FLUXER_TEST_APPLICATION_ID ?? "", /^[1-9][0-9]{0,19}$/)
    stage = "sandbox_lock"
    lock = openSync(lockPath, "wx")
    writeSync(lock, String(process.pid))
    stage = "sandbox_identity"
    const [application, self, guild, member] = await Promise.all([
        api("GET", "/oauth2/applications/@me"),
        api("GET", "/users/@me"),
        api("GET", `/guilds/${guildId}`),
        api("GET", `/guilds/${guildId}/members/${targetId}`),
    ])
    assert.equal(application.data.id, env.FLUXER_TEST_APPLICATION_ID)
    assert.equal(application.data.bot?.id, self.data.id)
    assert.equal(self.data.bot, true)
    assert.equal(guild.data.id, guildId)
    assert.equal(member.data.user?.id, targetId)
    assert.notEqual(member.data.user.bot, true)
    assert.notEqual(targetId, self.data.id)
    botId = self.data.id
    verified = true
    report(stage)
    if (existsSync(journalPath)) {
        journal = JSON.parse(readFileSync(journalPath, "utf8"))
        await cleanup()
    }
    journal = { kind: "interactive-typing", guildId, botId }
    writeFileSync(journalPath, JSON.stringify(journal), { flag: "wx" })
    stage = "create_test_channel"
    const channel = await createGuildChannelFixture(
        journal,
        () => writeFileSync(journalPath, JSON.stringify(journal)),
        "explicitChild",
        { type: 0 },
        async (input) => {
            const created = (await api("POST", `/guilds/${guildId}/channels`, input)).data
            return { ...created, guildId: created.guild_id }
        },
    )
    terminal = createInterface({ input: process.stdin })
    terminal.on("line", (line) => {
        if ((line === `visible ${mode}` || line === `browser ${mode}`) && stage === "await_human_typing_check") {
            confirmedMode = mode
            confirmationSource = line.startsWith("browser ") ? "browser-observation" : "human"
        }
        if (line === "stop") stopped = true
    })
    terminal.on("close", () => {
        stopped = true
    })
    for (mode of ["default", "effect"]) await runMode(channel)
} catch {
    console.error(JSON.stringify({ mode, check: stage, passed: false }))
    process.exitCode = 1
} finally {
    terminal?.close()
    globalThis.fetch = rawFetch
    try {
        await cleanup()
    } catch {
        console.error(JSON.stringify({ mode, check: "channel_cleanup", passed: false, journalRetained: true }))
        process.exitCode = 1
    }
    clearTimeout(watchdog)
    if (lock !== undefined) {
        closeSync(lock)
        unlinkSync(lockPath)
    }
}
