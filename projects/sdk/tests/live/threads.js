// Threads, forum channels and webhook thread posts in test-owned channels: Read-only thread state, public, private and
// message-started threads with their events, members, edits, archives and permissions, forum tags, posts, search and
// webhook posts, and the caches after deleting a parent channel that holds a cached thread.
// Journal `.env.test.threads.local` records sandbox and bot identity, a unique marker, the channel fixtures with their
// markers and IDs, the created thread IDs and the forum webhook's name and ID, never webhook tokens or message bodies.
// An existing journal triggers recovery only: The webhook is verified against the designated bot and the owned forum
// before deletion, the owned channels are removed, which deletes their threads, and every journaled thread and the
// active thread list are then checked for leftovers under those channels
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"
import { Effect, Exit, Scope } from "effect"
import { cleanupGuildChannelFixtures, createGuildChannelFixture } from "./channel-fixture.mjs"
import {
    acquireLock,
    finalizeOwned,
    loadSandboxEnvironment,
    openJournal,
    snowflake,
    verifySandboxIdentity,
} from "./support/harness.js"
import { createReporter } from "./support/reporting.js"
import { settle as value } from "./support/results.js"
import { createDeadlineSandboxApi } from "./support/sandbox-api.js"

const mode = process.argv[2]
assert.ok(mode === "default" || mode === "effect")
assert.equal(process.argv.length, 3)

const rawFetch = globalThis.fetch
const journalFile = openJournal("threads")
const markerPattern = /^fluxerly-threads-[a-f0-9]{32}$/
const threadTypes = [10, 11, 12]
const report = createReporter({ mode }, { passed: true })

// Whole-run bounds derived from the work: About 120 requests and 25 event waits, which normally take well under a
// second each, get two minutes. Up to 15 thread searches 2 s apart, 10 audit reads 1 s apart and one minute for a spent
// per-minute edge limit come on top. Cleanup makes about 20 requests and gets its own budget with one more edge window
const eventWaitMs = 15_000
const searchAttempts = 15
const searchIntervalMs = 2_000
const auditAttempts = 10
const auditIntervalMs = 1_000
const edgeWindowMs = 60_000
const operationMs = 120_000 + searchAttempts * searchIntervalMs + auditAttempts * auditIntervalMs + edgeWindowMs
const cleanupMs = 30_000 + edgeWindowMs

let lock, journal, bot, hook, scope, token, guildId, botId
let verified = false
let stage = "configuration"
const operationDeadline = new AbortController()
let requestDeadline = operationDeadline.signal
const save = () => journalFile.save(journal)
const api = createDeadlineSandboxApi({ fetch: rawFetch, token: () => token, deadline: () => requestDeadline })
const deadlineTimer = setTimeout(() => operationDeadline.abort(), operationMs).unref()
// This is failure containment, not cleanup evidence. The journal remains for a later verified recovery
const watchdog = setTimeout(() => {
    console.error(JSON.stringify({ mode, stage, passed: false, reason: "deadline", journalRetained: !!journal }))
    process.exit(1)
}, operationMs + cleanupMs).unref()

const pause = (ms) => sleep(ms, undefined, { signal: operationDeadline.signal })
// Cache reads return a value in the default API and an Effect in the native API
const read = (result) => (Effect.isEffect(result) ? Effect.runPromise(result) : result)
const ownedChannelIds = () =>
    new Set(
        Object.values(journal?.channelFixtures ?? {})
            .map((entry) => entry.id)
            .filter((id) => id !== undefined),
    )

async function cleanup() {
    if (!verified || !journal) return
    const priorRequestDeadline = requestDeadline
    requestDeadline = AbortSignal.timeout(cleanupMs)
    try {
        assert.equal(journal.guildId, guildId)
        assert.equal(journal.botId, botId)
        assert.match(journal.marker ?? "", markerPattern)
        assert.ok(Array.isArray(journal.threadIds) && journal.threadIds.every((id) => snowflake.test(id)))
        if (journal.webhook !== undefined) {
            assert.equal(journal.webhook.name, `${journal.marker}-hook`)
            if (journal.webhook.id !== undefined) assert.match(journal.webhook.id, snowflake)
            const forumId = journal.channelFixtures?.forum?.id
            const matches = (item) => item.id === journal.webhook.id || item.name === journal.webhook.name
            const hooks = (await api("GET", `/guilds/${guildId}/webhooks`)).data
            assert.ok(Array.isArray(hooks))
            for (const item of hooks.filter(matches)) {
                assert.equal(item.name, journal.webhook.name)
                assert.equal(item.user?.id, botId)
                assert.equal(item.guild_id, guildId)
                assert.ok(forumId !== undefined && item.channel_id === forumId)
                journal.webhook.id = item.id
                save()
                assert.equal((await api("DELETE", `/webhooks/${item.id}`)).status, 204)
                assert.equal((await api("GET", `/webhooks/${item.id}`)).status, 404)
            }
            assert.ok(journal.webhook.id !== undefined || journal.webhook.rejected, "Unresolved webhook creation")
            const after = (await api("GET", `/guilds/${guildId}/webhooks`)).data
            assert.ok(Array.isArray(after) && !after.some(matches))
        }
        await cleanupGuildChannelFixtures(api, journal, save)
        const owned = ownedChannelIds()
        for (const id of journal.threadIds) {
            const current = await api("GET", `/channels/${id}`)
            if (current.status === 404) continue
            // A thread that outlived its deleted parent is removed only while it still names an owned parent
            assert.equal(current.status, 200)
            assert.equal(current.data?.guild_id, guildId)
            assert.ok(threadTypes.includes(current.data?.type) && owned.has(current.data?.parent_id))
            assert.equal((await api("DELETE", `/channels/${id}`)).status, 204)
            assert.equal((await api("GET", `/channels/${id}`)).status, 404)
        }
        const active = (await api("GET", `/guilds/${guildId}/threads/active`)).data
        assert.ok(Array.isArray(active?.threads) && !active.threads.some((thread) => owned.has(thread.parent_id)))
        journalFile.remove()
        journal = undefined
        report("webhook_channels_and_threads_cleanup_verified")
    } finally {
        requestDeadline = priorRequestDeadline
    }
}

async function scenario(sdk) {
    const { ChannelFlags, ChannelType, MessageFlags, MessageType, Permissions } = sdk
    const marker = journal.marker
    scope = Scope.makeUnsafe()
    const scoped = (operation) =>
        mode === "default" ? operation : Effect.runPromise(operation.pipe(Effect.provideService(Scope.Scope, scope)))
    bot = await scoped(sdk.createClient({ token, cache: { channels: true, messages: true } }))

    // Observations are limited to the owned channels and their threads, and to thread membership in the sandbox.
    // The raw THREAD_MEMBER_UPDATE reports a change to the bot's own membership, which has no public event and evicts
    // that thread from the channel cache
    const observed = {
        threadCreate: [],
        threadUpdate: [],
        threadDelete: [],
        threadMembersUpdate: [],
        guildChannelDelete: [],
        messageCreate: [],
        raw: [],
    }
    let overflow = false
    const observe = (event, item) => {
        const owned = ownedChannelIds()
        const relevant =
            event === "raw"
                ? item.t === "THREAD_MEMBER_UPDATE" && item.d?.guild_id === guildId
                : event === "threadMembersUpdate"
                  ? item.guildId === guildId
                  : event === "guildChannelDelete"
                    ? owned.has(item.id)
                    : event === "messageCreate"
                      ? owned.has(item.channelId)
                      : owned.has(item.parentId)
        if (!relevant) return
        if (observed[event].length >= 48) overflow = true
        else observed[event].push(item)
    }
    for (const event of Object.keys(observed)) {
        if (mode === "default") bot.on(event, (item) => observe(event, item))
        else
            await Effect.runPromise(
                bot
                    .on(event, (item) => Effect.sync(() => observe(event, item)))
                    .pipe(Effect.provideService(Scope.Scope, scope)),
            )
    }
    const waitFor = async (event, predicate, from = 0) => {
        const until = performance.now() + eventWaitMs
        for (;;) {
            assert.equal(overflow, false, "Owned event observation overflow")
            const found = observed[event].slice(from).find(predicate)
            if (found) return found
            assert.ok(performance.now() < until, `Missing ${event} observation`)
            await pause(25)
        }
    }
    const waitForCache = async (get, predicate) => {
        const until = performance.now() + eventWaitMs
        for (;;) {
            const snapshot = await read(get())
            if (predicate(snapshot)) return snapshot
            assert.ok(performance.now() < until, "Cache observation deadline")
            await pause(25)
        }
    }
    // Fluxer allows 10 thread creations per 10 s in one channel, so creations in one channel start at least 1 s apart
    const lastThreadCreate = new Map()
    const paceThreadCreate = async (channelId) => {
        const waitMs = (lastThreadCreate.get(channelId) ?? -Infinity) + 1_000 - performance.now()
        if (waitMs > 0) await pause(waitMs)
        lastThreadCreate.set(channelId, performance.now())
    }
    const recordThread = (id) => {
        assert.match(id, snowflake)
        journal.threadIds.push(id)
        save()
    }
    const assertThread = (thread, parentId, type) => {
        assert.ok(sdk.isThreadChannel(thread) && Object.isFrozen(thread))
        assert.match(thread.id, snowflake)
        assert.equal(thread.type, type)
        assert.equal(thread.guildId, guildId)
        assert.equal(thread.parentId, parentId)
    }
    const tagNames = (tags) => (tags ?? []).map((tag) => tag.name).sort()

    await value(bot.connect())

    stage = "guild_list_threads_active"
    const guilds = await value(bot.guilds.fetchPage())
    assert.equal(guilds.find((item) => item.id === guildId)?.threadsActive, true)
    report(stage)

    stage = "fetch_active_read_only"
    const initiallyActive = await value(bot.threads.fetchActive(guildId))
    assert.ok(Array.isArray(initiallyActive) && Object.isFrozen(initiallyActive))
    assert.ok(initiallyActive.every((thread) => sdk.isThreadChannel(thread) && thread.guildId === guildId))
    report(stage, { activeThreads: initiallyActive.length })

    stage = "create_parent_channels"
    const createChannel = (key, input) =>
        createGuildChannelFixture(journal, save, key, input, (channelInput) =>
            value(bot.channels.create(guildId, channelInput)),
        )
    const parent = await createChannel("threadParent", { type: ChannelType.Text })
    const forum = await createChannel("forum", {
        type: ChannelType.Forum,
        topic: "SDK forum check",
        availableTags: [{ name: "alpha" }, { name: "beta" }],
        flags: ChannelFlags.RequireTag,
    })
    const doomed = await createChannel("deletedParent", { type: ChannelType.Text })
    assert.deepEqual(tagNames(forum.availableTags), ["alpha", "beta"])
    assert.ok(forum.availableTags.every((tag) => snowflake.test(tag.id) && tag.moderated === false))
    assert.equal(forum.flags & ChannelFlags.RequireTag, ChannelFlags.RequireTag)
    const rawForum = (await api("GET", `/channels/${forum.id}`)).data
    assert.equal(rawForum?.type, ChannelType.Forum)
    assert.deepEqual(
        rawForum.available_tags.map((tag) => tag.id).sort(),
        forum.availableTags.map((tag) => tag.id).sort(),
    )
    const alpha = forum.availableTags.find((tag) => tag.name === "alpha")
    const beta = forum.availableTags.find((tag) => tag.name === "beta")
    report(stage)

    stage = "forum_audit_entry"
    let auditEntry
    for (let attempt = 1; attempt <= auditAttempts && !auditEntry; attempt++) {
        const page = await value(
            bot.auditLogs.fetchPage(guildId, {
                userId: botId,
                actionType: sdk.AuditLogActions.ChannelCreate,
                limit: 50,
            }),
        )
        auditEntry = page.entries.find((entry) => entry.targetId === forum.id)
        if (!auditEntry && attempt < auditAttempts) await pause(auditIntervalMs)
    }
    assert.ok(auditEntry, "Missing forum channel audit entry")
    const auditTags = auditEntry.changes?.find((change) => change.key === "available_tags")?.newValue
    if (auditTags !== undefined) assert.deepEqual(tagNames(auditTags), ["alpha", "beta"])
    report(stage, { availableTagsChange: auditTags !== undefined })

    stage = "thread_create_public_private"
    await paceThreadCreate(parent.id)
    const publicThread = await value(
        bot.threads.create(parent.id, {
            name: `${marker}-public`,
            autoArchiveMinutes: sdk.ThreadAutoArchiveMinutes.OneDay,
        }),
    )
    recordThread(publicThread.id)
    assertThread(publicThread, parent.id, ChannelType.PublicThread)
    assert.equal(publicThread.name, `${marker}-public`)
    assert.equal(publicThread.ownerId, botId)
    assert.equal(publicThread.archived, false)
    assert.equal(publicThread.locked, false)
    assert.equal(publicThread.autoArchiveMinutes, sdk.ThreadAutoArchiveMinutes.OneDay)
    assert.equal((await waitFor("threadCreate", (item) => item.id === publicThread.id)).isNewlyCreated, true)
    const notice = await waitFor(
        "messageCreate",
        (item) => item.channelId === parent.id && item.type === MessageType.ThreadCreated,
    )
    assert.equal(notice.messageReference?.channelId, publicThread.id)
    await paceThreadCreate(parent.id)
    const privateThread = await value(
        bot.threads.create(parent.id, { name: `${marker}-private`, type: ChannelType.PrivateThread, invitable: false }),
    )
    recordThread(privateThread.id)
    assertThread(privateThread, parent.id, ChannelType.PrivateThread)
    assert.equal(privateThread.invitable, false)
    assert.equal((await waitFor("threadCreate", (item) => item.id === privateThread.id)).isNewlyCreated, true)
    report(stage, { threadCreatedNotice: true })

    stage = "thread_from_message"
    const starter = await value(bot.messages.send(parent.id, { content: "SDK thread starter" }))
    await paceThreadCreate(parent.id)
    const startedThread = await value(bot.threads.createFromMessage(starter, { name: `${marker}-started` }))
    recordThread(startedThread.id)
    assertThread(startedThread, parent.id, ChannelType.PublicThread)
    assert.equal(startedThread.id, starter.id)
    await waitFor("threadCreate", (item) => item.id === startedThread.id)
    const refreshedStarter = await value(bot.messages.fetch({ id: starter.id, channelId: parent.id }))
    assert.equal(refreshedStarter.flags & MessageFlags.HasThread, MessageFlags.HasThread)
    assert.equal(refreshedStarter.thread?.id, startedThread.id)
    assert.equal(refreshedStarter.thread?.parentId, parent.id)
    report(stage)

    stage = "thread_permissions_from_parent"
    const threadBits = await value(bot.permissions.fetch({ guildId, userId: botId, channelId: publicThread.id }))
    const parentBits = await value(bot.permissions.fetch({ guildId, userId: botId, channelId: parent.id }))
    // Fluxer's thread rule: The parent's permissions, with SendMessages exactly when SendMessagesInThreads is granted
    const inThreads = (parentBits & Permissions.SendMessagesInThreads) !== 0n
    assert.equal(threadBits, (parentBits & ~Permissions.SendMessages) | (inThreads ? Permissions.SendMessages : 0n))
    const administrator = (parentBits & Permissions.Administrator) !== 0n
    report(stage, { administrator })
    // An overwrite cannot deny an administrator, so a denying parent overwrite proves nothing for this bot
    console.log(
        JSON.stringify({
            mode,
            check: "thread_parent_overwrite_denial",
            skipped: true,
            reason: administrator ? "administrator_bypasses_overwrites" : "not_covered",
        }),
    )

    stage = "fetch_active_lists_owned_threads"
    const active = await value(bot.threads.fetchActive(guildId))
    for (const thread of [publicThread, privateThread, startedThread])
        assert.ok(active.some((item) => item.id === thread.id))
    assert.match(active.find((item) => item.id === publicThread.id).membership?.joinedAt ?? "", /^\d{4}-\d{2}-\d{2}T/)
    report(stage)

    stage = "thread_members_leave_join"
    const memberIds = async () => (await value(bot.threads.fetchMembers(publicThread.id))).map((item) => item.userId)
    assert.ok((await memberIds()).includes(botId))
    const own = await value(bot.threads.fetchMember(publicThread.id, botId, { withMember: true }))
    assert.equal(own.threadId, publicThread.id)
    assert.equal(own.userId, botId)
    assert.equal(own.member?.userId, botId)
    assert.equal(own.member?.guildId, guildId)
    let from = observed.threadMembersUpdate.length
    await value(bot.threads.leave(publicThread.id))
    await waitFor(
        "threadMembersUpdate",
        (item) => item.threadId === publicThread.id && item.removedUserIds.includes(botId),
        from,
    )
    assert.ok(!(await memberIds()).includes(botId))
    from = observed.threadMembersUpdate.length
    const createsBeforeJoin = observed.threadCreate.length
    await value(bot.threads.join(publicThread.id))
    await waitFor(
        "threadMembersUpdate",
        (item) => item.threadId === publicThread.id && item.added.some((member) => member.userId === botId),
        from,
    )
    assert.ok((await memberIds()).includes(botId))
    const rejoinCreate = observed.threadCreate
        .slice(createsBeforeJoin)
        .find((item) => item.id === publicThread.id && item.isNewlyCreated === false)
    report(stage, { rejoinThreadCreate: rejoinCreate !== undefined })

    stage = "thread_edit_rename_archive_lock"
    const renamedName = `${marker}-renamed`
    from = observed.threadUpdate.length
    const renamed = await value(bot.threads.edit(publicThread.id, { name: renamedName }))
    assertThread(renamed, parent.id, ChannelType.PublicThread)
    assert.equal(renamed.name, renamedName)
    await waitFor("threadUpdate", (item) => item.id === publicThread.id && item.name === renamedName, from)
    from = observed.threadUpdate.length
    const closed = await value(
        bot.threads.edit(publicThread.id, { archived: true, locked: true }, { auditReason: "SDK thread check" }),
    )
    assert.equal(closed.archived, true)
    assert.equal(closed.locked, true)
    await waitFor("threadUpdate", (item) => item.id === publicThread.id && item.archived && item.locked, from)
    const rawClosed = (await api("GET", `/channels/${publicThread.id}`)).data
    assert.equal(rawClosed?.name, renamedName)
    assert.equal(rawClosed.thread_metadata?.archived, true)
    assert.equal(rawClosed.thread_metadata?.locked, true)
    from = observed.threadUpdate.length
    assert.equal((await value(bot.threads.edit(privateThread.id, { archived: true }))).archived, true)
    await waitFor("threadUpdate", (item) => item.id === privateThread.id && item.archived, from)
    report(stage)

    stage = "fetch_archived_scopes"
    const publicPage = await value(bot.threads.fetchArchived(parent.id, { scope: "public" }))
    const listedClosed = publicPage.threads.find((item) => item.id === publicThread.id)
    assert.ok(listedClosed?.archived && listedClosed.locked)
    assert.equal(typeof publicPage.hasMore, "boolean")
    assert.ok(!publicPage.threads.some((item) => item.id === privateThread.id))
    const privatePage = await value(bot.threads.fetchArchived(parent.id, { scope: "private" }))
    assert.ok(privatePage.threads.some((item) => item.id === privateThread.id))
    const joinedPage = await value(bot.threads.fetchArchived(parent.id, { scope: "joinedPrivate" }))
    const joinedPrivate = joinedPage.threads.find((item) => item.id === privateThread.id)
    assert.equal(joinedPrivate?.type, ChannelType.PrivateThread)
    report(stage, { joinedPrivateMembership: joinedPrivate.membership !== undefined })

    stage = "thread_delete_event"
    from = observed.threadDelete.length
    await value(bot.channels.delete(startedThread.id))
    const deletion = await waitFor("threadDelete", (item) => item.id === startedThread.id, from)
    assert.equal(deletion.guildId, guildId)
    assert.equal(deletion.parentId, parent.id)
    assert.equal(deletion.type, ChannelType.PublicThread)
    assert.equal(await read(bot.channels.get(startedThread.id)), undefined)
    assert.equal((await api("GET", `/channels/${startedThread.id}`)).status, 404)
    report(stage)

    stage = "forum_decoded_in_fetch_all"
    const listed = await value(bot.channels.fetchAll(guildId))
    const listedForum = listed.find((item) => item.id === forum.id)
    assert.equal(listedForum?.type, ChannelType.Forum)
    assert.deepEqual(tagNames(listedForum.availableTags), ["alpha", "beta"])
    assert.equal(listedForum.flags & ChannelFlags.RequireTag, ChannelFlags.RequireTag)
    assert.ok(!listed.some((item) => sdk.isThreadChannel(item)))
    report(stage)

    stage = "forum_tags"
    const withGamma = await value(bot.channels.createForumTag(forum.id, { name: "gamma" }))
    assert.deepEqual(tagNames(withGamma.availableTags), ["alpha", "beta", "gamma"])
    const gamma = withGamma.availableTags.find((tag) => tag.name === "gamma")
    assert.match(gamma.id, snowflake)
    const editedGamma = (
        await value(bot.channels.editForumTag(forum.id, gamma.id, { ...gamma, name: "gamma-edited", moderated: true }))
    ).availableTags.find((tag) => tag.id === gamma.id)
    assert.equal(editedGamma?.name, "gamma-edited")
    assert.equal(editedGamma.moderated, true)
    const withoutGamma = await value(bot.channels.deleteForumTag(forum.id, gamma.id))
    assert.deepEqual(tagNames(withoutGamma.availableTags), ["alpha", "beta"])
    const rawTags = (await api("GET", `/channels/${forum.id}`)).data?.available_tags
    assert.deepEqual(rawTags.map((tag) => tag.id).sort(), [alpha.id, beta.id].sort())
    report(stage)

    stage = "forum_post_requires_tag"
    await paceThreadCreate(forum.id)
    let untagged
    await assert.rejects(
        () =>
            value(
                bot.threads.createPost(forum.id, {
                    name: `${marker}-untagged`,
                    message: { content: "SDK untagged post" },
                }),
            ),
        (error) => {
            untagged = error
            return error?._tag === "ChannelOperationError" && error.outcome === "rejected"
        },
    )
    report(stage, { status: untagged.status, providerCode: untagged.apiError?.providerCode })

    stage = "forum_post_with_tag_and_upload"
    await paceThreadCreate(forum.id)
    const post = await value(
        bot.threads.createPost(forum.id, {
            name: `${marker}-post`,
            appliedTagIds: [alpha.id],
            message: {
                content: "SDK forum post",
                attachments: [{ filename: "post.txt", data: new TextEncoder().encode("forum post bytes") }],
            },
        }),
    )
    recordThread(post.thread.id)
    assertThread(post.thread, forum.id, ChannelType.PublicThread)
    assert.deepEqual(post.thread.appliedTagIds, [alpha.id])
    assert.equal(post.message.channelId, post.thread.id)
    assert.equal(post.message.attachments.length, 1)
    assert.equal(post.message.attachments[0].filename, "post.txt")
    await waitFor("threadCreate", (item) => item.id === post.thread.id)
    report(stage)

    stage = "forum_post_pin"
    const pinned = await value(bot.threads.edit(post.thread.id, { pinned: true }))
    assert.equal(pinned.flags & ChannelFlags.Pinned, ChannelFlags.Pinned)
    report(stage)

    stage = "thread_search"
    let found
    let indexingPages = 0
    let attempts = 0
    while (!found && attempts < searchAttempts) {
        if (attempts++ > 0) await pause(searchIntervalMs)
        const page = await value(bot.threads.search(forum.id, { tagIds: [alpha.id], limit: 5 }))
        if (page.indexing) indexingPages++
        else if (page.threads.some((thread) => thread.id === post.thread.id)) found = page
    }
    if (!found)
        stage = indexingPages === attempts ? "thread_search_indexing_timeout" : "thread_search_owned_hit_timeout"
    assert.ok(found, "Thread search did not return the owned post within the bounded retry budget")
    assert.equal(found.firstMessages.find((message) => message.channelId === post.thread.id)?.id, post.message.id)
    assert.ok(Number.isSafeInteger(found.total) && typeof found.hasMore === "boolean")
    report(stage, { attempts, indexingPages })

    stage = "webhook_forum_post"
    journal.webhook = { name: `${marker}-hook` }
    save()
    let createdHook
    try {
        createdHook = await value(bot.webhooks.create(forum.id, { name: journal.webhook.name }))
    } catch (error) {
        if (["rejected", "notDispatched"].includes(error?.outcome)) {
            journal.webhook.rejected = true
            save()
        }
        throw error
    }
    journal.webhook.id = createdHook.webhook.id
    save()
    hook = await scoped(sdk.createWebhookClient(createdHook.credentials))
    await paceThreadCreate(forum.id)
    const hookFirst = await value(
        hook.send({ content: "SDK webhook post", threadName: `${marker}-hook-post`, appliedTagIds: [beta.id] }),
    )
    assert.notEqual(hookFirst.channelId, forum.id)
    recordThread(hookFirst.channelId)
    assert.equal(hookFirst.webhookId, createdHook.webhook.id)
    const hookPost = await value(bot.channels.fetch(hookFirst.channelId))
    assertThread(hookPost, forum.id, ChannelType.PublicThread)
    assert.equal(hookPost.name, `${marker}-hook-post`)
    assert.deepEqual(hookPost.appliedTagIds, [beta.id])
    report(stage)

    stage = "webhook_thread_messages"
    const note = await value(hook.send({ content: "SDK webhook thread note", threadId: hookPost.id }))
    assert.equal(note.channelId, hookPost.id)
    assert.equal((await value(hook.fetchMessage(note.id, { threadId: hookPost.id }))).id, note.id)
    await assert.rejects(
        () => value(hook.fetchMessage(note.id)),
        (error) => error?._tag === "WebhookOperationError" && error.reason === "notFound",
    )
    const editedNote = "SDK webhook thread note edited"
    assert.equal((await value(hook.editMessage(note.id, editedNote, { threadId: hookPost.id }))).content, editedNote)
    assert.equal((await api("GET", `/channels/${hookPost.id}/messages/${note.id}`)).data?.content, editedNote)
    await value(hook.deleteMessage(note.id, { threadId: hookPost.id }))
    assert.equal((await api("GET", `/channels/${hookPost.id}/messages/${note.id}`)).status, 404)
    await value(hook.delete())
    assert.equal((await api("GET", `/webhooks/${createdHook.webhook.id}`)).status, 404)
    report(stage)

    stage = "parent_deletion_cache_seeded"
    await paceThreadCreate(doomed.id)
    const doomedThread = await value(bot.threads.create(doomed.id, { name: `${marker}-doomed` }))
    recordThread(doomedThread.id)
    assertThread(doomedThread, doomed.id, ChannelType.PublicThread)
    await waitFor("threadCreate", (item) => item.id === doomedThread.id)
    // The bot's first message in a thread makes Fluxer send THREAD_MEMBER_UPDATE, which evicts the cached thread, so
    // the thread is read into the cache only after that dispatch arrived
    const threadMessage = await value(bot.messages.send(doomedThread.id, { content: "SDK cached thread message" }))
    const threadMessageReference = { id: threadMessage.id, channelId: doomedThread.id }
    await waitFor("raw", (item) => item.d?.id === doomedThread.id)
    await value(bot.channels.fetch(doomedThread.id))
    await waitForCache(
        () => bot.channels.get(doomedThread.id),
        (item) => item?.id === doomedThread.id,
    )
    await waitForCache(
        () => bot.messages.get(threadMessageReference),
        (item) => item?.id === threadMessage.id,
    )
    report(stage)

    stage = "parent_deletion_evicts_cached_thread"
    // The parent is deleted outside the SDK, so only the gateway's channel deletion can evict the cached thread
    assert.equal((await read(bot.channels.get(doomedThread.id)))?.id, doomedThread.id)
    assert.equal((await read(bot.messages.get(threadMessageReference)))?.id, threadMessage.id)
    assert.equal((await api("DELETE", `/channels/${doomed.id}`)).status, 204)
    await waitFor("guildChannelDelete", (item) => item.id === doomed.id)
    assert.ok(!observed.threadDelete.some((item) => item.id === doomedThread.id))
    assert.equal(await read(bot.channels.get(doomedThread.id)), undefined)
    assert.equal(await read(bot.messages.get(threadMessageReference)), undefined)
    assert.equal((await api("GET", `/channels/${doomedThread.id}`)).status, 404)
    // A bounded quiet window, not proof that Fluxer can never send a late thread deletion
    await pause(2_000)
    assert.ok(!observed.threadDelete.some((item) => item.id === doomedThread.id))
    assert.equal(overflow, false, "Owned event observation overflow")
    report(stage, { threadDeleteWithin2s: false })
}

try {
    lock = acquireLock()
    const sandbox = loadSandboxEnvironment()
    token = sandbox.token
    guildId = sandbox.guildId
    stage = "sandbox_identity"
    botId = (await verifySandboxIdentity(async (path) => (await api("GET", path)).data, sandbox)).botId
    verified = true
    report(stage)
    if (journalFile.exists()) {
        journal = journalFile.read()
        stage = "recovery_only"
        await cleanup()
        report(stage)
    } else {
        journal = { guildId, botId, marker: `fluxerly-threads-${randomUUID().replaceAll("-", "")}`, threadIds: [] }
        journalFile.create(journal)
        const sdk = await import(mode === "default" ? "@neontechspace/fluxerly" : "@neontechspace/fluxerly/effect")
        await scenario(sdk)
    }
} catch (error) {
    // Do not emit configured IDs, markers, message bodies, raw failures or credentials
    console.error(
        JSON.stringify({
            mode,
            stage,
            passed: false,
            category: error?._tag ?? (error?.code === "ERR_ASSERTION" ? "assertion" : "check"),
            operation: typeof error?.operation === "string" ? error.operation : undefined,
            reason: error?.reason,
            outcome: error?.outcome,
            status: error?.status,
            providerCode: error?.apiError?.providerCode,
            apiCode: error?.apiError?.code,
            safetyCheck: error?.check,
            field: error?._tag === "ConfigurationError" ? error.field : undefined,
            journalRetained: !!journal,
        }),
    )
    process.exitCode = 1
} finally {
    // Keep the journal, lock and deadlines if a failed owned finalizer may have left a writer alive
    const quiescent = await finalizeOwned({
        writers: [
            hook && ["webhook_client_shutdown", () => value(hook.shutdown())],
            bot && ["client_shutdown", () => value(bot.shutdown())],
            scope && ["scope_close", () => Effect.runPromise(Scope.close(scope, Exit.void))],
        ],
        cleanup,
        lock,
        watchdog,
        onFailure: (finalizer) => {
            console.error(JSON.stringify({ mode, finalizer, passed: false, journalRetained: !!journal }))
            process.exitCode = 1
        },
    })
    if (quiescent) clearTimeout(deadlineTimer)
}
