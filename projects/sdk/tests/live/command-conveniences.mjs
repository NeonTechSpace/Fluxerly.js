import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
import { parseEnv } from "node:util"
import { Cause, Effect, Exit, Scope } from "effect"

const mode = process.argv[2]
const feature = process.argv[3]
assert.ok(mode === "default" || mode === "effect")
assert.ok(feature === "waits" || feature === "arguments" || feature === "help")
assert.equal(process.argv.length, 4)

const rawFetch = globalThis.fetch
const lockPath = new URL("../../.env.test.local.lock", import.meta.url)
const journalPath = new URL("../../.env.test.command-conveniences.local", import.meta.url)
const operationDeadline = new AbortController()
const deadlineTimer = setTimeout(() => operationDeadline.abort(), 150_000).unref()
const watchdog = setTimeout(() => {
    console.error(
        JSON.stringify({
            mode,
            feature,
            stage,
            passed: false,
            reason: "deadline",
            ...(journal ? { journalRetained: true } : {}),
        }),
    )
    process.exit(1)
}, 180_000).unref()

let stage = "configuration"
let lock
let token
let guildId
let botId
let client
let scope
let journal
let verified = false
let requestDeadline = operationDeadline.signal

const report = (check, passed = true, details = {}) =>
    console.log(JSON.stringify({ mode, feature, check, passed, ...details }))
const save = () => writeFileSync(journalPath, JSON.stringify(journal))

async function value(operation, signal) {
    if (Effect.isEffect(operation)) {
        const result = await Effect.runPromise(Effect.result(operation), signal ? { signal } : undefined)
        if (result._tag === "Failure") throw result.failure
        return result.success
    }
    const result = await operation
    if (result?.isErr?.()) throw result.error
    return result?.isOk?.() ? result.value : result
}

async function api(method, path, body) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await rawFetch(`https://api.fluxer.app/v1${path}`, {
            method,
            redirect: "error",
            signal: AbortSignal.any([requestDeadline, AbortSignal.timeout(15_000)]),
            headers: {
                Authorization: `Bot ${token}`,
                ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        const data = response.status === 204 || response.status === 202 ? null : await response.json().catch(() => null)
        if (response.status === 429 && attempt < 2) {
            const retryAfter = Math.max(
                Number(response.headers.get("retry-after")) || 0,
                Number(data?.retry_after) || 0,
            )
            assert.ok(Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 10)
            await sleep(retryAfter * 1_000, undefined, { signal: requestDeadline })
            continue
        }
        assert.ok(response.ok || response.status === 404, `Sandbox HTTP ${response.status}`)
        return { status: response.status, data }
    }
    throw new Error("Sandbox request budget exhausted")
}

async function waitForCondition(matches, message) {
    const deadline = performance.now() + 15_000
    while (!matches()) {
        assert.ok(performance.now() < deadline, message)
        await sleep(20, undefined, { signal: operationDeadline.signal })
    }
}

function assertJournal() {
    assert.equal(journal?.guildId, guildId)
    assert.equal(journal?.botId, botId)
    assert.match(journal?.marker ?? "", /^fluxerly-command-conveniences-[a-f0-9]{32}$/)
    assert.equal(journal?.channel?.name, journal.marker)
    assert.equal(journal?.channel?.type, 0)
    if (journal.channel.id !== undefined) assert.match(journal.channel.id, /^\d+$/)
}

async function findOwnedChannel() {
    const listed = await api("GET", `/guilds/${guildId}/channels`)
    assert.ok(Array.isArray(listed.data))
    const matches = listed.data.filter((channel) => channel?.type === 0 && channel?.name === journal.marker)
    assert.ok(matches.length <= 1)
    return matches[0]
}

async function createOwnedChannel() {
    assert.equal(journal.channel.phase, "planned")
    journal.channel.phase = "creating"
    save()
    let created
    try {
        created = (await api("POST", `/guilds/${guildId}/channels`, { name: journal.marker, type: 0 })).data
    } catch {
        // Durable intent and an exact unique name reconcile a lost creation response without replaying the POST
        created = await findOwnedChannel()
        assert.ok(created, "Unresolved test-channel creation")
    }
    assert.match(created?.id ?? "", /^\d+$/)
    assert.equal(created.guild_id, guildId)
    assert.equal(created.type, 0)
    assert.equal(created.name, journal.marker)
    journal.channel.id = created.id
    journal.channel.phase = "created"
    save()
    return created
}

async function cleanup() {
    if (!verified || !journal) return
    const priorDeadline = requestDeadline
    requestDeadline = AbortSignal.timeout(30_000)
    try {
        assertJournal()
        const located = await findOwnedChannel()
        if (!located) {
            if (journal.channel.phase === "planned" && journal.channel.id === undefined) {
                unlinkSync(journalPath)
                journal = undefined
                report("planned_channel_creation_not_dispatched")
                return
            }
            if (journal.channel.id === undefined)
                throw new Error("Unresolved test-channel creation retains its journal")
            assert.match(journal.channel.id ?? "", /^\d+$/, "Unresolved channel creation retains its journal")
            assert.equal((await api("GET", `/channels/${journal.channel.id}`)).status, 404)
        } else {
            assert.equal(located.guild_id, guildId)
            assert.equal(located.name, journal.marker)
            if (journal.channel.id !== undefined) assert.equal(located.id, journal.channel.id)
            else {
                journal.channel.id = located.id
                journal.channel.phase = "reconciled"
                save()
            }
            const current = await api("GET", `/channels/${located.id}`)
            assert.equal(current.status, 200)
            assert.equal(current.data?.id, located.id)
            assert.equal(current.data?.guild_id, guildId)
            assert.equal(current.data?.name, journal.marker)
            journal.channel.cleanupPhase = "dispatching"
            save()
            assert.equal((await api("DELETE", `/channels/${located.id}`)).status, 204)
            assert.equal((await api("GET", `/channels/${located.id}`)).status, 404)
            journal.channel.cleanupPhase = "verified"
            save()
        }
        const remaining = await api("GET", `/guilds/${guildId}/channels`)
        assert.ok(Array.isArray(remaining.data))
        assert.ok(!remaining.data.some((channel) => channel?.type === 0 && channel?.name === journal.marker))
        unlinkSync(journalPath)
        journal = undefined
        report("test_owned_channel_removed")
    } finally {
        requestDeadline = priorDeadline
    }
}

function testBotMessage(channelId, marker) {
    return (message) =>
        message.channelId === channelId &&
        message.author?.id === botId &&
        typeof message.content === "string" &&
        message.content === marker
}

function observeRejection(pending) {
    void Promise.resolve(pending).catch(() => undefined)
    return pending
}

async function verifyWaits(ops, channelId) {
    const marker = `${journal.marker}-waits`
    const options = { timeoutMs: 5_000, maxPendingMessages: 4, maxPendingBytes: 65_536 }

    stage = "event_wait_timeout"
    await assert.rejects(
        () => ops.wait("messageCreate", { ...options, timeoutMs: 50, filter: () => false }),
        (error) => error?._tag === "EventWaitError" && error?.reason === "timeout",
    )
    report(stage)

    stage = "event_wait_filter_failure"
    const filterProbe = `${marker}-filter-probe`
    const filterFailure = observeRejection(
        ops.wait("messageCreate", {
            ...options,
            filter: (message) => {
                if (!testBotMessage(channelId, filterProbe)(message)) return false
                throw new Error("Test-owned filter failure")
            },
        }),
    )
    await ops.send({ content: filterProbe })
    await assert.rejects(
        () => filterFailure,
        (error) => error?._tag === "EventWaitError" && error?.reason === "filter",
    )
    report(stage)

    stage = mode === "default" ? "event_wait_abort_cleanup" : "event_wait_interruption_cleanup"
    const cancellation = new AbortController()
    const cancellationProbe = `${marker}-cancel-probe`
    let cancellationObserved = false
    const cancelled = observeRejection(
        ops.wait("messageCreate", {
            ...options,
            signal: cancellation.signal,
            filter: (message) => {
                if (!testBotMessage(channelId, cancellationProbe)(message)) return false
                cancellationObserved = true
                return false
            },
        }),
    )
    await ops.send({ content: cancellationProbe })
    await waitForCondition(() => cancellationObserved, "Event wait cancellation registration deadline")
    cancellation.abort()
    await ops.assertCancelled(cancelled)
    report(stage)

    stage = "event_wait_probe_barrier_and_success"
    const probe = `${marker}-probe`
    const target = `${marker}-target`
    let probeObserved = false
    const pending = observeRejection(
        ops.wait("messageCreate", {
            ...options,
            filter: (message) => {
                if (!testBotMessage(channelId, probe)(message) && !testBotMessage(channelId, target)(message))
                    return false
                if (message.content === probe) {
                    probeObserved = true
                    return false
                }
                return message.content === target
            },
        }),
    )
    await ops.send({ content: probe })
    await waitForCondition(() => probeObserved, "Event wait probe registration deadline")
    const sent = await ops.send({ content: target })
    const event = await pending
    assert.equal(event.id, sent.id)
    assert.equal(event.channelId, channelId)
    assert.equal(event.author.id, botId)
    const raw = await api("GET", `/channels/${channelId}/messages/${sent.id}`)
    assert.equal(raw.status, 200)
    assert.equal(raw.data?.id, sent.id)
    assert.equal(raw.data?.channel_id, channelId)
    assert.equal(raw.data?.author?.id, botId)
    assert.equal(raw.data?.content, target)
    report(stage)
}

async function verifyArguments(ops, channelId) {
    const marker = `${journal.marker}-arguments`
    const commandName = `typed-${marker.slice(-8)}`
    const invalidInput = `!${commandName} not-an-integer fast`
    const validInput = `!${commandName} 7 fast`
    const executions = []
    const rejections = []
    const replies = []
    const claims = []
    const cooldown = await ops.cooldowns(claims)
    let router = await ops.create({ prefix: "!", ignoreBots: false })
    router = await ops.register(router, {
        name: commandName,
        description: "Live typed command arguments",
        arguments: {
            count: { type: "integer" },
            mode: { type: "choice", choices: ["fast", "slow"] },
            note: { type: "text", optional: true },
        },
        guard: ops.guard((message) => message.channelId === channelId && message.author.id === botId),
        cooldown: { store: cooldown.store, durationMs: 60_000 },
        onReject: ops.reject(async (context, rejection) => {
            const message = context.message
            if (message.channelId !== channelId || message.author.id !== botId) return
            rejections.push({ id: message.id, hasValues: "values" in context, rejection })
            replies.push(await ops.reply(message, { content: `${marker} rejected`, allowedMentions: {} }))
        }),
        execute: ops.execute(async ({ message, args, rawArgs, values }) => {
            executions.push({ id: message.id, args, rawArgs, values, frozen: Object.isFrozen(values) })
            replies.push(await ops.reply(message, { content: `${marker} accepted`, allowedMentions: {} }))
        }),
    })
    assert.deepEqual(router.commands[0]?.arguments, [
        { name: "count", type: "integer", optional: false, rest: false },
        { name: "mode", type: "choice", optional: false, rest: false, choices: ["fast", "slow"] },
        { name: "note", type: "text", optional: true, rest: false },
    ])
    const subscription = await ops.attach(router)
    try {
        stage = "typed_arguments_invalid_rejection"
        const invalid = await ops.send({ content: invalidInput, allowedMentions: {} })
        await waitForCondition(
            () => rejections.length === 1 && replies.length === 1,
            "Argument rejection and feedback deadline",
        )
        assert.deepEqual(rejections, [
            {
                id: invalid.id,
                hasValues: false,
                rejection: { _tag: "CommandArgumentRejected", argument: "count", reason: "Invalid" },
            },
        ])
        assert.deepEqual(executions, [])
        assert.deepEqual(claims, [])
        report(stage)

        stage = "typed_arguments_valid_retry"
        const valid = await ops.send({ content: validInput, allowedMentions: {} })
        await waitForCondition(
            () => executions.length === 1 && replies.length === 2,
            "Argument execution and reply deadline",
        )
        assert.deepEqual(executions, [
            {
                id: valid.id,
                args: ["7", "fast"],
                rawArgs: "7 fast",
                values: { count: 7, mode: "fast", note: undefined },
                frozen: true,
            },
        ])
        assert.equal(claims.length, 1)
        const accepted = replies.at(-1)
        assert.ok(accepted)
        const raw = await api("GET", `/channels/${channelId}/messages/${accepted.id}`)
        assert.equal(raw.status, 200)
        assert.equal(raw.data?.channel_id, channelId)
        assert.equal(raw.data?.content, `${marker} accepted`)
        assert.equal(raw.data?.message_reference?.message_id, valid.id)
        assert.equal(raw.data?.mention_everyone, false)
        assert.deepEqual(raw.data?.mentions, [])
        report(stage)
    } finally {
        await ops.close(subscription)
    }
}

async function verifyHelp(ops, channelId) {
    const marker = `${journal.marker}-help`
    const suffix = marker.slice(-8)
    const primary = {
        name: `help-${suffix}`,
        aliases: [`h-${suffix}`],
        description: `Generated primary help entry ${marker}`,
        arguments: {
            count: { type: "integer" },
            note: { type: "text", optional: true },
            tail: { type: "text", rest: true, optional: true },
        },
    }
    const legacy = {
        name: `legacy-${suffix}`,
        description: `Generated explicit usage entry ${marker}`,
        usage: "<provided>",
        arguments: { ignored: { type: "text" } },
    }
    const more = {
        name: `more-${suffix}`,
        description: `Generated pagination entry ${marker} with enough copied metadata to require a second bounded page`,
        arguments: { enabled: { type: "boolean" } },
    }
    const hidden = {
        name: `hidden-${suffix}`,
        description: `Generated hidden entry ${marker}`,
        arguments: { value: { type: "id" } },
    }
    const guards = []
    const executions = []
    const claims = []
    const included = []
    const cooldown = await ops.cooldowns(claims)
    const command = (definition) => ({
        ...definition,
        guard: ops.guard(() => {
            guards.push(definition.name)
            return true
        }),
        cooldown: { store: cooldown.store, durationMs: 60_000 },
        execute: ops.execute(async () => {
            executions.push(definition.name)
        }),
    })
    let router = await ops.create({ prefix: "?", ignoreBots: false })
    for (const definition of [primary, legacy, more, hidden]) router = await ops.register(router, command(definition))

    stage = "generated_help_visibility_and_pagination"
    const pages = await ops.help(router, {
        prefix: "!",
        maxLength: 180,
        include: (metadata) => {
            included.push(metadata.name)
            return metadata.name !== hidden.name
        },
    })
    const expected = [
        `!${primary.name} <count> [note] [tail...] (Aliases: !${primary.aliases[0]})\n${primary.description}`,
        `!${legacy.name} ${legacy.usage}\n${legacy.description}`,
        `!${more.name} <enabled>\n${more.description}`,
    ].join("\n\n")
    assert.deepEqual(included, [primary.name, legacy.name, more.name, hidden.name])
    assert.ok(pages.length > 1)
    assert.ok(pages.every((page) => page.length <= 180))
    const full = await ops.help(router, {
        prefix: "!",
        maxLength: 10_000,
        include: (metadata) => metadata.name !== hidden.name,
    })
    assert.deepEqual(full, [expected])
    assert.ok(pages.every((page) => page.length > 0 && page === page.trim()))
    // This fixture's page boundaries fall on whitespace, not inside words
    assert.equal(pages.join(" ").replace(/\s+/g, " "), expected.replace(/\s+/g, " "))
    assert.ok(!pages.join("").includes(hidden.name))
    assert.deepEqual(guards, [])
    assert.deepEqual(executions, [])
    assert.deepEqual(claims, [])
    const before = await api("GET", `/channels/${channelId}/messages?limit=100`)
    assert.equal(before.status, 200)
    assert.ok(Array.isArray(before.data))
    assert.ok(!before.data.some((message) => message?.author?.id === botId && pages.includes(message?.content)))
    report(stage)

    stage = "generated_help_explicit_page_delivery"
    const sent = []
    for (const page of pages) sent.push(await ops.send({ content: page, allowedMentions: {} }))
    for (const [index, message] of sent.entries()) {
        const raw = await api("GET", `/channels/${channelId}/messages/${message.id}`)
        stage = "generated_help_page_identity"
        assert.equal(raw.status, 200)
        assert.equal(raw.data?.channel_id, channelId)
        assert.equal(raw.data?.author?.id, botId)
        stage = "generated_help_page_content"
        assert.equal(raw.data?.content, pages[index])
        assert.equal(raw.data?.content, message.content)
        stage = "generated_help_page_mentions"
        assert.equal(raw.data?.mention_everyone, false)
        assert.deepEqual(raw.data?.mentions, [])
    }
    report("generated_help_explicit_page_delivery")
}

async function createOps(sdk, channelId) {
    if (mode === "default") {
        client = sdk.createClient({ token })._unsafeUnwrap()
        return {
            connect: () => value(client.connect()),
            send: (input) => value(client.messages.send(channelId, input)),
            wait: (event, options) => value(client.waitFor(event, options)),
            create: (options) => value(Promise.resolve(sdk.commands.create(options))),
            register: (router, command) => value(Promise.resolve(router.register(command))),
            help: (router, options) => value(Promise.resolve(router.help(options))),
            attach: (router) => value(Promise.resolve(router.attach(client))),
            close: async (subscription) => {
                subscription.unsubscribe()
                await value(subscription.waitForClose())
            },
            guard:
                (predicate) =>
                ({ message }) =>
                    predicate(message),
            execute:
                (handler) =>
                ({ message, args, rawArgs, values }) =>
                    handler({ message, args, rawArgs, values }),
            reject: (handler) => (context, rejection) => handler(context, rejection),
            reply: (message, input) => value(client.messages.reply(message, input)),
            cooldowns: async (claims) => {
                const store = await value(Promise.resolve(sdk.commands.memoryCooldowns({ maxEntries: 4 })))
                return {
                    store: {
                        claim(input) {
                            const result = store.claim(input)
                            if (result.isOk()) claims.push(result.value)
                            return result
                        },
                    },
                }
            },
            assertCancelled: (pending) =>
                assert.rejects(
                    () => pending,
                    (error) => error?._tag === "CancelledError",
                ),
        }
    }
    scope = Scope.makeUnsafe()
    client = await Effect.runPromise(sdk.createClient({ token }).pipe(Scope.provide(scope)))
    return {
        connect: () => value(client.connect()),
        send: (input) => value(client.messages.send(channelId, input)),
        wait: (event, options) => {
            const { signal, ...nativeOptions } = options
            const operation = client.waitFor(event, nativeOptions)
            return signal === undefined ? value(operation) : Effect.runPromiseExit(operation, { signal })
        },
        create: (options) => value(sdk.commands.create(options)),
        register: (router, command) => value(router.register(command)),
        help: (router, options) => value(router.help(options)),
        attach: (router) => value(router.attach(client).pipe(Scope.provide(scope))),
        close: (subscription) =>
            value(
                Effect.gen(function* () {
                    yield* subscription.unsubscribe()
                    yield* subscription.waitForClose()
                }),
            ),
        guard:
            (predicate) =>
            ({ message }) =>
                Effect.sync(() => predicate(message)),
        execute:
            (handler) =>
            ({ message, args, rawArgs, values }) =>
                Effect.promise(() => handler({ message, args, rawArgs, values })),
        reject: (handler) => (context, rejection) => Effect.promise(() => handler(context, rejection)),
        reply: (message, input) => value(client.messages.reply(message, input)),
        cooldowns: async (claims) => {
            const store = await value(sdk.commands.memoryCooldowns({ maxEntries: 4 }))
            return {
                store: {
                    claim: (input) =>
                        store.claim(input).pipe(Effect.tap((claim) => Effect.sync(() => claims.push(claim)))),
                },
            }
        },
        assertCancelled: async (pending) => {
            const exit = await pending
            assert.ok(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))
        },
    }
}

try {
    stage = "sandbox_lock"
    lock = openSync(lockPath, "wx")
    writeSync(lock, String(process.pid))

    const env = parseEnv(readFileSync(new URL("../../.env.test.local", import.meta.url), "utf8"))
    token = env.FLUXER_TEST_BOT_TOKEN
    guildId = env.FLUXER_TEST_GUILD_ID
    assert.ok(token && token === token.trim())
    assert.match(guildId ?? "", /^\d+$/)

    stage = "sandbox_identity"
    const application = (await api("GET", "/applications/@me")).data
    const self = (await api("GET", "/users/@me")).data
    assert.equal(application?.id, env.FLUXER_TEST_APPLICATION_ID)
    assert.equal(application?.bot?.id, self?.id)
    assert.equal(self?.bot, true)
    assert.equal((await api("GET", `/guilds/${guildId}`)).data?.id, guildId)
    botId = self.id
    const membership = await api("GET", `/guilds/${guildId}/members/${botId}`)
    assert.equal(membership.status, 200)
    assert.equal(membership.data?.user?.id, botId)
    verified = true
    report(stage)

    stage = "recover_prior_test_channel"
    if (existsSync(journalPath)) {
        journal = JSON.parse(readFileSync(journalPath, "utf8"))
        await cleanup()
        report("recovery_only")
    } else {
        const marker = `fluxerly-command-conveniences-${randomUUID().replaceAll("-", "")}`
        journal = {
            guildId,
            botId,
            marker,
            channel: { name: marker, type: 0, phase: "planned" },
        }
        writeFileSync(journalPath, JSON.stringify(journal), { flag: "wx" })
        stage = "create_test_owned_channel"
        const channel = await createOwnedChannel()
        report(stage)
        const sdk = await import(mode === "default" ? "@neontechspace/fluxerly" : "@neontechspace/fluxerly/effect")
        const ops = await createOps(sdk, channel.id)
        await ops.connect()
        if (feature === "waits") {
            await verifyWaits(ops, channel.id)
            report("waits_complete")
        } else if (feature === "arguments") {
            await verifyArguments(ops, channel.id)
            report("arguments_complete")
        } else {
            await verifyHelp(ops, channel.id)
            report("help_complete")
        }
    }
} catch (error) {
    // Never print assertions, configured identities, message bodies, raw failures or credentials
    console.error(
        JSON.stringify({
            mode,
            feature,
            stage,
            passed: false,
            tag: error?._tag ?? error?.name ?? "Error",
            ...(typeof error?.reason === "string" ? { reason: error.reason } : {}),
            ...(journal ? { journalRetained: true } : {}),
        }),
    )
    process.exitCode = 1
} finally {
    let quiescent = true
    try {
        if (client) await value(client.shutdown())
    } catch {
        quiescent = false
        console.error(JSON.stringify({ mode, feature, stage: "client_cleanup", passed: false }))
        process.exitCode = 1
    }
    try {
        if (scope) await Effect.runPromise(Scope.close(scope, Exit.void))
    } catch {
        quiescent = false
        console.error(JSON.stringify({ mode, feature, stage: "scope_cleanup", passed: false }))
        process.exitCode = 1
    }
    if (quiescent) {
        try {
            await cleanup()
        } catch {
            console.error(
                JSON.stringify({ mode, feature, stage: "resource_cleanup", passed: false, journalRetained: true }),
            )
            process.exitCode = 1
        }
        try {
            if (lock !== undefined) {
                closeSync(lock)
                unlinkSync(lockPath)
            }
        } catch {
            console.error(JSON.stringify({ mode, feature, stage: "lock_cleanup", passed: false }))
            process.exitCode = 1
        }
        clearTimeout(deadlineTimer)
        clearTimeout(watchdog)
    }
}
