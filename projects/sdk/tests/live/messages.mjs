import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
import { parseEnv } from "node:util"
import WebSocket from "ws"

const mode = process.argv[2]
const recover = process.argv[3] === "--recover"
const manage = process.argv[3] === "--manage"
const changes = process.argv[3] === "--events"
const history = process.argv[3] === "--history"
const lockPath = new URL("../../.env.test.local.lock", import.meta.url)
const journalPath = new URL("../../.env.test.messages.local", import.meta.url)
const report = (check, passed) => console.log(JSON.stringify({ mode, check, passed }))
let stage = "configuration"
let lock
let token
let guildId
let verified = false
let journal
let gatewayProbe

function observeGateway() {
    const descriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, "emit")
    const original = WebSocket.prototype.emit
    const sockets = new Map()
    let malformed = false
    // Observe real inbound frames in this isolated test process without replacing transport, endpoints or SDK logic
    WebSocket.prototype.emit = function (event, ...args) {
        if (event === "open") sockets.set(this, { ready: 0, resumed: 0, heartbeat: 0 })
        const observed = sockets.get(this)
        if (observed && event === "message") {
            try {
                // Retain only protocol counters, never session IDs, credentials or message bodies
                const frame = JSON.parse(args[0].toString())
                if (frame.op === 0 && frame.t === "READY") observed.ready++
                if (frame.op === 0 && frame.t === "RESUMED") observed.resumed++
                if (frame.op === 11) observed.heartbeat++
            } catch {
                malformed = true
            }
        }
        return Reflect.apply(original, this, [event, ...args])
    }
    return {
        async interruptAndWait(client, states) {
            stage = "live_socket_interruption"
            assert.equal(client.state, "Connected")
            assert.equal(sockets.size, 1)
            const [first, initial] = [...sockets][0]
            const url = new URL(first.url)
            assert.equal(url.protocol, "wss:")
            assert.equal(url.host, "gateway.fluxer.app")
            assert.equal(initial.ready, 1)
            assert.equal(initial.resumed, 0)
            // Only this process's authenticated SDK socket is interrupted, never the host network or another bot
            first.terminate()
            report(stage, true)
            stage = "live_session_resume"
            const deadline = performance.now() + 45_000
            while (true) {
                assert.ok(!malformed && sockets.size <= 2)
                assert.ok(client.state !== "Closed" && performance.now() < deadline)
                const replacement = [...sockets][1]
                if (replacement) {
                    const [socket, observed] = replacement
                    // Re-identifying into a fresh READY session must not pass as successful session resumption
                    assert.equal(observed.ready, 0)
                    if (observed.resumed === 1 && observed.heartbeat > 0 && client.state === "Connected") {
                        assert.notEqual(socket, first)
                        assert.equal(first.readyState, WebSocket.CLOSED)
                        assert.ok(states.includes("Recovering"))
                        assert.ok(Number.isFinite(client.gatewayLatencyMs) && client.gatewayLatencyMs >= 0)
                        report("live_session_resumed", true)
                        report("post_resume_heartbeat", true)
                        break
                    }
                }
                await sleep(20)
            }
            stage = "post_resume_receive_and_reply"
        },
        verifyClosed() {
            assert.equal(sockets.size, 2)
            for (const socket of sockets.keys()) assert.equal(socket.readyState, WebSocket.CLOSED)
            report("recovery_sockets_closed", true)
        },
        restore() {
            if (descriptor) Object.defineProperty(WebSocket.prototype, "emit", descriptor)
            else delete WebSocket.prototype.emit
            sockets.clear()
        },
    }
}

async function api(method, path, body) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const response = await fetch(`https://api.fluxer.app/v1${path}`, {
            method,
            redirect: "error",
            signal: AbortSignal.timeout(10_000),
            headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        const data = response.status === 204 ? null : await response.json().catch(() => null)
        if (response.status === 429 && attempt < 2) {
            const delay =
                Math.max(Number(response.headers.get("retry-after")) || 0, Number(data?.retry_after) || 0) * 1000
            assert.ok(Number.isFinite(delay) && delay > 0 && delay <= 10_000)
            await sleep(delay)
            continue
        }
        assert.ok(response.ok || response.status === 404)
        return { status: response.status, data }
    }
    throw new Error("Sandbox request budget exhausted")
}

async function cleanup() {
    if (!journal) return
    assert.equal(journal.guildId, guildId)
    assert.match(journal.name, /^fluxerly-sdk-test-[a-f0-9]{32}$/)
    const listed = await api("GET", `/guilds/${guildId}/channels`)
    assert.ok(Array.isArray(listed.data))
    // The unique marker is persisted before creation, so a lost POST response can be reconciled without retrying creation
    const matches = listed.data.filter((channel) => channel.name === journal.name)
    assert.ok(matches.length <= 1)
    if (matches.length === 0) {
        // Without a returned ID, absence cannot prove that an interrupted creation will not complete later
        assert.match(journal.channelId ?? "", /^\d+$/)
        assert.equal((await api("GET", `/channels/${journal.channelId}`)).status, 404)
    }
    for (const channel of matches) {
        assert.match(channel.id, /^\d+$/)
        assert.equal(channel.guild_id, guildId)
        assert.equal(channel.type, 0)
        const current = await api("GET", `/channels/${channel.id}`)
        assert.equal(current.data?.name, journal.name)
        assert.equal(current.data?.guild_id, guildId)
        await api("DELETE", `/channels/${channel.id}`)
        assert.equal((await api("GET", `/channels/${channel.id}`)).status, 404)
    }
    const after = await api("GET", `/guilds/${guildId}/channels`)
    assert.ok(Array.isArray(after.data) && !after.data.some((channel) => channel.name === journal.name))
    unlinkSync(journalPath)
    journal = undefined
    report("test_channel_and_messages_removed", true)
}

async function prepareManagement(channelId, botId) {
    stage = "management_seed"
    const content = `manage-${randomUUID()}`
    const created = await api("POST", `/channels/${channelId}/messages`, {
        content,
        embeds: [{ title: "SDK preservation fixture", description: "Temporary sandbox data" }],
        allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
    })
    assert.equal(created.status, 200)
    assert.match(created.data?.id ?? "", /^\d+$/)
    const target = { channelId, id: created.data.id }
    const before = (await api("GET", `/channels/${channelId}/messages/${target.id}`)).data
    assert.equal(before?.content, content)
    assert.equal(before?.author?.id, botId)
    assert.equal(before?.embeds?.length, 1)
    assert.equal(before.embeds[0].type, "rich")
    return { target, before, content }
}

async function verifyManaged(snapshot, content, seed) {
    assert.equal(snapshot.id, seed.target.id)
    assert.equal(snapshot.channelId, seed.target.channelId)
    assert.equal(snapshot.content, content)
    assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.author))
    const current = (await api("GET", `/channels/${snapshot.channelId}/messages/${snapshot.id}`)).data
    assert.equal(current?.content, content)
    assert.deepEqual(current?.embeds, seed.before.embeds)
    assert.deepEqual(current?.attachments, seed.before.attachments)
    assert.equal(current?.flags, seed.before.flags)
    assert.equal(current?.mention_everyone, false)
    assert.deepEqual(current?.mentions, [])
    report(stage, true)
}

function verifyMissing(error, operation) {
    assert.equal(error?._tag, "MessageOperationError")
    assert.equal(error.operation, operation)
    assert.equal(error.reason, "notFound")
    assert.equal(error.outcome, "rejected")
    assert.equal(error.status, 404)
}

function verifyClearRejection(error) {
    assert.equal(error?._tag, "MessageOperationError")
    assert.equal(error.operation, "edit")
    assert.equal(error.reason, "rejected")
    assert.equal(error.outcome, "rejected")
    assert.equal(error.status, 400)
}

function observeMessageChanges(channelId) {
    const received = { messageUpdate: [], messageDelete: [], messageDeleteBulk: [] }
    return {
        receive(event, payload) {
            if (payload.channelId !== channelId) return
            assert.ok(received[event].length < 32)
            assert.ok(Object.isFrozen(payload))
            received[event].push(payload)
        },
        async exercise(botId) {
            stage = "create_change_event_seeds"
            const content = `event-${randomUUID()}`
            const seeds = []
            for (let index = 0; index < 3; index++) {
                const seed = (
                    await api("POST", `/channels/${channelId}/messages`, {
                        content: `${content}-${index}`,
                        allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
                    })
                ).data
                assert.match(seed?.id ?? "", /^\d+$/)
                assert.equal(seed.channel_id, channelId)
                assert.equal(seed.author?.id, botId)
                seeds.push(seed)
            }
            const waitFor = async (event, matches) => {
                const until = performance.now() + 15_000
                while (true) {
                    const found = received[event].find(matches)
                    if (found) return found
                    assert.ok(performance.now() < until)
                    await sleep(20)
                }
            }
            // Raw API mutations prove the SDK receives real gateway events rather than synthesizing method results
            stage = "live_message_update_event"
            await api("PATCH", `/channels/${channelId}/messages/${seeds[0].id}`, {
                content: `${content}-edited`,
                allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
            })
            const updated = await waitFor(
                "messageUpdate",
                (message) => message.id === seeds[0].id && message.content === `${content}-edited`,
            )
            assert.equal(updated.author.id, botId)
            assert.ok(Object.isFrozen(updated.author))
            assert.equal(
                (await api("GET", `/channels/${channelId}/messages/${updated.id}`)).data?.content,
                updated.content,
            )
            report(stage, true)
            stage = "live_message_delete_event"
            await api("DELETE", `/channels/${channelId}/messages/${seeds[0].id}`)
            const deleted = await waitFor("messageDelete", (message) => message.id === seeds[0].id)
            if ("content" in deleted) assert.equal(deleted.content, updated.content)
            if ("authorId" in deleted) assert.equal(deleted.authorId, botId)
            assert.equal((await api("GET", `/channels/${channelId}/messages/${deleted.id}`)).status, 404)
            report(stage, true)
            stage = "live_message_delete_bulk_event"
            const ids = seeds.slice(1).map((seed) => seed.id)
            const result = await api("POST", `/channels/${channelId}/messages/bulk-delete`, { message_ids: ids })
            assert.equal(result.status, 204)
            const batch = await waitFor("messageDeleteBulk", (batch) => ids.every((id) => batch.ids.includes(id)))
            assert.deepEqual([...batch.ids].sort(), [...ids].sort())
            assert.ok(Object.isFrozen(batch.ids))
            for (const id of ids) assert.equal((await api("GET", `/channels/${channelId}/messages/${id}`)).status, 404)
            assert.ok(!received.messageDelete.some((message) => ids.includes(message.id)))
            report(stage, true)
        },
    }
}

async function prepareHistory(channelId, botId) {
    stage = "history_seed"
    const seeds = []
    for (let index = 0; index < 5; index++) {
        const seed = (
            await api("POST", `/channels/${channelId}/messages`, {
                content: `history-${randomUUID()}`,
                allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
            })
        ).data
        assert.match(seed?.id ?? "", /^\d+$/)
        assert.equal(seed.channel_id, channelId)
        assert.equal(seed.author?.id, botId)
        seeds.push(seed)
    }
    const ids = seeds.map((seed) => seed.id)
    for (let index = 1; index < ids.length; index++) assert.ok(BigInt(ids[index]) > BigInt(ids[index - 1]))
    return {
        cases: [
            { name: "history_default", query: undefined, ids: [...ids].reverse() },
            { name: "history_latest_page", query: { limit: 2 }, ids: [ids[4], ids[3]] },
            { name: "history_older_page", query: { limit: 2, before: ids[3] }, ids: [ids[2], ids[1]] },
            { name: "history_last_page", query: { limit: 2, before: ids[1] }, ids: [ids[0]] },
            { name: "history_empty_page", query: { before: ids[0] }, ids: [] },
            { name: "history_after", query: { limit: 2, after: ids[0] }, ids: [ids[2], ids[1]] },
            { name: "history_around", query: { limit: 3, around: ids[2] }, ids: [ids[3], ids[2], ids[1]] },
            { name: "history_maximum_limit", query: { limit: 100 }, ids: [...ids].reverse() },
        ],
        async verify(page, check) {
            assert.ok(Object.isFrozen(page))
            assert.deepEqual(
                page.map((message) => message.id),
                check.ids,
            )
            const query = new URLSearchParams(check.query)
            const actual = await api("GET", `/channels/${channelId}/messages?${query}`)
            assert.equal(actual.status, 200)
            assert.ok(Array.isArray(actual.data))
            assert.deepEqual(
                page.map((message) => message.id),
                actual.data.map((message) => message.id),
            )
            for (let index = 0; index < page.length; index++) {
                const message = page[index]
                assert.equal(message.channelId, channelId)
                assert.equal(message.author.id, botId)
                assert.equal(message.content, actual.data[index].content)
                assert.ok(Object.isFrozen(message) && Object.isFrozen(message.author))
            }
            report(check.name, true)
        },
    }
}

// Failure containment only: A forced exit is never reported as successful cleanup
setTimeout(() => {
    report("process_timeout", false)
    process.exit(1)
}, 120_000).unref()

try {
    assert.ok(mode === "default" || mode === "effect")
    assert.ok(process.argv.length === 3 || (process.argv.length === 4 && (recover || manage || changes || history)))
    stage = "sandbox_lock"
    lock = openSync(lockPath, "wx")
    writeSync(lock, String(process.pid))
    stage = "configuration"
    const env = parseEnv(readFileSync(new URL("../../.env.test.local", import.meta.url), "utf8"))
    token = env.FLUXER_TEST_BOT_TOKEN
    guildId = env.FLUXER_TEST_GUILD_ID
    const applicationId = env.FLUXER_TEST_APPLICATION_ID
    assert.ok(token && token === token.trim())
    assert.match(guildId ?? "", /^\d+$/)
    assert.match(applicationId ?? "", /^\d+$/)
    stage = "sandbox_identity"
    const application = (await api("GET", "/applications/@me")).data
    const user = (await api("GET", "/users/@me")).data
    assert.equal(application?.id, applicationId)
    assert.equal(user?.bot, true)
    assert.equal(application?.bot?.id, user.id)
    assert.equal((await api("GET", `/guilds/${guildId}`)).data?.id, guildId)
    verified = true
    report(stage, true)
    stage = "recover_prior_test"
    if (existsSync(journalPath)) {
        journal = JSON.parse(readFileSync(journalPath, "utf8"))
        await cleanup()
    }
    journal = { guildId, name: `fluxerly-sdk-test-${randomUUID().replaceAll("-", "")}` }
    writeFileSync(journalPath, JSON.stringify(journal), { flag: "wx" })
    stage = "create_test_channel"
    const channel = (await api("POST", `/guilds/${guildId}/channels`, { name: journal.name, type: 0 })).data
    assert.match(channel?.id ?? "", /^\d+$/)
    assert.equal(channel.guild_id, guildId)
    assert.equal(channel.name, journal.name)
    journal.channelId = channel.id
    writeFileSync(journalPath, JSON.stringify(journal))
    const ping = `ping-${randomUUID()}`
    const pong = `pong-${randomUUID()}`
    let client
    let seed
    let reply
    const states = []
    if (recover) gatewayProbe = observeGateway()
    stage = "sdk_receive_and_reply"
    if (mode === "default") {
        const { createClient } = await import("@neontechspace/fluxerly")
        const created = createClient({ token })
        assert.ok(created.isOk())
        client = created.value
        const done = Promise.withResolvers()
        const stopState = recover
            ? client.observeState((state) => {
                  states.push(state)
              })
            : undefined
        let timer
        try {
            if (history) {
                const probe = await prepareHistory(channel.id, user.id)
                assert.equal(client.state, "Disconnected")
                for (const check of probe.cases) {
                    stage = check.name
                    const page = await client.messages.fetchHistory(channel.id, check.query)
                    assert.ok(page.isOk())
                    await probe.verify(page.value, check)
                }
                stage = "sdk_receive_and_reply"
            }
            if (manage) {
                const managed = await prepareManagement(channel.id, user.id)
                assert.equal(client.state, "Disconnected")
                stage = "sdk_fetch_disconnected"
                const fetched = await client.messages.fetch(managed.target)
                assert.ok(fetched.isOk())
                await verifyManaged(fetched.value, managed.content, managed)
                stage = "sdk_edit_and_preserve_embed"
                const edited = await client.messages.edit(fetched.value, {
                    content: `${managed.content}-edited @everyone`,
                })
                assert.ok(edited.isOk())
                await verifyManaged(edited.value, `${managed.content}-edited @everyone`, managed)
                stage = "sdk_empty_edit_rejected_without_change"
                const cleared = await client.messages.edit(edited.value, { content: "" })
                assert.ok(cleared.isErr())
                verifyClearRejection(cleared.error)
                await verifyManaged(edited.value, `${managed.content}-edited @everyone`, managed)
                stage = "sdk_delete_and_confirm_absence"
                const deleted = await client.messages.delete(edited.value)
                assert.ok(deleted.isOk())
                assert.equal(deleted.value, undefined)
                assert.equal((await api("GET", `/channels/${channel.id}/messages/${managed.target.id}`)).status, 404)
                report(stage, true)
                stage = "sdk_missing_target_errors"
                verifyMissing((await client.messages.fetch(managed.target)).error, "fetch")
                verifyMissing((await client.messages.edit(managed.target, { content: "gone" })).error, "edit")
                verifyMissing((await client.messages.delete(managed.target)).error, "delete")
                report(stage, true)
                stage = "sdk_receive_and_reply"
            }
            const registered = client.on("messageCreate", async (message, signal) => {
                if (message.channelId !== channel.id || message.author.id !== user.id || message.content !== ping)
                    return
                // Deliberately consume this test bot's own seed event; default bot examples filter bot authors
                const sent = await client.messages.reply(message, { content: pong }, { signal })
                done.resolve(sent)
            })
            assert.ok(registered.isOk())
            const terminal = registered.value.waitForClose().then(
                (result) => {
                    if (result.isErr()) done.resolve(result)
                },
                () => done.resolve(null),
            )
            assert.ok((await client.connect()).isOk())
            if (recover) await gatewayProbe.interruptAndWait(client, states)
            const sent = await client.messages.send(channel.id, { content: ping })
            assert.ok(sent.isOk())
            seed = sent.value
            timer = setTimeout(() => done.resolve(null), 20_000)
            const replied = await done.promise
            assert.ok(replied?.isOk())
            reply = replied.value
            registered.value.unsubscribe()
            assert.ok((await registered.value.waitForClose()).isOk())
            await terminal
            if (changes) {
                const probe = observeMessageChanges(channel.id)
                const updates = client.on("messageUpdate", (message) => probe.receive("messageUpdate", message))
                assert.ok(updates.isOk())
                const deletion = client.events("messageDelete")
                const bulk = client.events("messageDeleteBulk")
                assert.ok(deletion.isOk() && bulk.isOk())
                const consume = async (event, subscription) => {
                    while (true) {
                        const result = await subscription.next()
                        assert.ok(result.isOk())
                        if (result.value === null) return
                        probe.receive(event, result.value)
                    }
                }
                const readers = [consume("messageDelete", deletion.value), consume("messageDeleteBulk", bulk.value)]
                const readsDone = Promise.allSettled(readers)
                try {
                    await probe.exercise(user.id)
                } finally {
                    updates.value.unsubscribe()
                    deletion.value.unsubscribe()
                    bulk.value.unsubscribe()
                    assert.ok((await updates.value.waitForClose()).isOk())
                    assert.ok((await readsDone).every((result) => result.status === "fulfilled"))
                }
            }
        } finally {
            clearTimeout(timer)
            assert.ok((await client.shutdown()).isOk())
            stopState?.()
        }
    } else {
        const { Deferred, Effect, Exit, Stream } = await import("effect")
        const { createClient } = await import("@neontechspace/fluxerly/effect")
        const exit = await Effect.runPromiseExit(
            Effect.scoped(
                Effect.gen(function* () {
                    client = yield* createClient({ token })
                    if (history) {
                        const probe = yield* Effect.promise(() => prepareHistory(channel.id, user.id))
                        assert.equal(client.state, "Disconnected")
                        for (const check of probe.cases) {
                            stage = check.name
                            const page = yield* client.messages.fetchHistory(channel.id, check.query)
                            yield* Effect.promise(() => probe.verify(page, check))
                        }
                        stage = "sdk_receive_and_reply"
                    }
                    if (manage) {
                        const managed = yield* Effect.promise(() => prepareManagement(channel.id, user.id))
                        assert.equal(client.state, "Disconnected")
                        stage = "sdk_fetch_disconnected"
                        const fetched = yield* client.messages.fetch(managed.target)
                        yield* Effect.promise(() => verifyManaged(fetched, managed.content, managed))
                        stage = "sdk_edit_and_preserve_embed"
                        const edited = yield* client.messages.edit(fetched, {
                            content: `${managed.content}-edited @everyone`,
                        })
                        yield* Effect.promise(() =>
                            verifyManaged(edited, `${managed.content}-edited @everyone`, managed),
                        )
                        stage = "sdk_empty_edit_rejected_without_change"
                        const cleared = yield* client.messages.edit(edited, { content: "" }).pipe(Effect.flip)
                        verifyClearRejection(cleared)
                        yield* Effect.promise(() =>
                            verifyManaged(edited, `${managed.content}-edited @everyone`, managed),
                        )
                        stage = "sdk_delete_and_confirm_absence"
                        assert.equal(yield* client.messages.delete(edited), undefined)
                        const absent = yield* Effect.promise(() =>
                            api("GET", `/channels/${channel.id}/messages/${managed.target.id}`),
                        )
                        assert.equal(absent.status, 404)
                        report(stage, true)
                        stage = "sdk_missing_target_errors"
                        verifyMissing(yield* client.messages.fetch(managed.target).pipe(Effect.flip), "fetch")
                        verifyMissing(
                            yield* client.messages.edit(managed.target, { content: "gone" }).pipe(Effect.flip),
                            "edit",
                        )
                        verifyMissing(yield* client.messages.delete(managed.target).pipe(Effect.flip), "delete")
                        report(stage, true)
                        stage = "sdk_receive_and_reply"
                    }
                    if (recover)
                        yield* Effect.forkScoped(
                            Stream.runForEach(client.observeState(), (state) =>
                                Effect.sync(() => {
                                    states.push(state)
                                }),
                            ),
                        )
                    const done = yield* Deferred.make()
                    const subscription = yield* client.on("messageCreate", (message) =>
                        Effect.gen(function* () {
                            if (
                                message.channelId !== channel.id ||
                                message.author.id !== user.id ||
                                message.content !== ping
                            )
                                return
                            const sent = yield* client.messages.reply(message, { content: pong })
                            yield* Deferred.succeed(done, sent)
                        }),
                    )
                    yield* client.connect()
                    if (recover) yield* Effect.promise(() => gatewayProbe.interruptAndWait(client, states))
                    seed = yield* client.messages.send(channel.id, { content: ping })
                    reply = yield* Deferred.await(done).pipe(Effect.timeout(20_000))
                    yield* subscription.unsubscribe()
                    yield* subscription.waitForClose()
                    if (changes) {
                        const probe = observeMessageChanges(channel.id)
                        yield* Effect.scoped(
                            Effect.gen(function* () {
                                yield* client.on("messageUpdate", (message) =>
                                    Effect.sync(() => probe.receive("messageUpdate", message)),
                                )
                                for (const event of ["messageDelete", "messageDeleteBulk"]) {
                                    yield* Effect.forkScoped(
                                        Stream.runForEach(client.events(event), (message) =>
                                            Effect.sync(() => probe.receive(event, message)),
                                        ),
                                    )
                                }
                                yield* Effect.promise(() => probe.exercise(user.id))
                            }),
                        )
                    }
                }),
            ),
        )
        assert.ok(Exit.isSuccess(exit))
    }
    assert.equal(client.state, "Closed")
    gatewayProbe?.verifyClosed()
    stage = "live_reply_readback"
    const actual = (await api("GET", `/channels/${channel.id}/messages/${reply.id}`)).data
    assert.equal(actual?.channel_id, channel.id)
    assert.equal(actual?.content, pong)
    assert.equal(actual?.message_reference?.message_id, seed.id)
    assert.equal(actual?.mention_everyone, false)
    assert.deepEqual(actual?.mentions, [])
    report("sdk_receive_and_reply", true)
    if (recover) report("post_resume_receive_and_reply", true)
    report("reply_reference_and_mentions_verified", true)
    report("sdk_closed", true)
} catch {
    // Never print assertions, HTTP bodies, native causes, configured identities or credentials
    report(stage, false)
    process.exitCode = 1
} finally {
    gatewayProbe?.restore()
    if (verified && journal) {
        try {
            await cleanup()
        } catch {
            report("cleanup_failed_journal_retained", false)
            process.exitCode = 1
        }
    }
    if (lock !== undefined) {
        closeSync(lock)
        unlinkSync(lockPath)
    }
}
