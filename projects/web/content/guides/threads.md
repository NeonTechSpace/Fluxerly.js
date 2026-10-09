---
title: Create and manage threads
navTitle: Threads
description: Create threads and forum posts, archive, lock and list threads, search them, manage their members and read their state
---

A thread is a channel inside a text, announcement, forum or media channel that holds its own messages. Fluxer has three thread types. Public and private threads start in text channels, and announcement threads start in announcement channels. Every post in a forum or media channel is a public thread

The `client.threads` namespace creates, changes, lists and searches threads and manages their members. A thread is still a channel, so `channels.fetch` reads one, `channels.delete` deletes one and `messages.send` with the thread's ID posts in it. Bots can use threads without a capability setting

The examples use the default API. The Effect entry point exports the same names, and each `client.threads` method returns an Effect there

## Recognize a thread

Channel reads, channel events, message search results and audit-log pages return threads with their own channel shapes. The `isThreadChannel` function tells a thread from any other community channel, and `type` selects one thread type

```ts
import { ChannelType, isThreadChannel, type GuildChannel } from "@neontechspace/fluxerly"

export function describeChannel(channel: GuildChannel) {
    if (!isThreadChannel(channel)) return `channel ${channel.name ?? channel.id}`
    const kind = channel.type === ChannelType.PrivateThread ? "private thread" : "thread"
    return `${kind} ${channel.name} in channel ${channel.parentId}`
}
```

## Read thread state

A thread shape flattens Fluxer's thread metadata into `archived`, `locked`, `autoArchiveMinutes`, `archiveTimestamp` and `createdAt`. Its `parentId` names the channel that holds the thread, never a category. A private thread also has `invitable`, and a forum or media post has `appliedTagIds`

The `membership` field describes the bot's own membership when Fluxer reports it. Some reads leave it out, so its absence does not prove that the bot is not a member. The `memberCount` field is approximate and stops at 50

```ts
import { isThreadChannel, ThreadAutoArchiveMinutes, type Client } from "@neontechspace/fluxerly"

export async function threadState(client: Client, channelId: string) {
    const channel = await client.channels.fetch(channelId)
    if (channel.isErr()) return channel
    const thread = channel.value
    if (!isThreadChannel(thread)) return undefined
    return {
        archived: thread.archived,
        archivesAfterOneDay: thread.autoArchiveMinutes === ThreadAutoArchiveMinutes.OneDay,
        joinedAt: thread.membership?.joinedAt,
    }
}
```

## Create a thread

The `threads.create` method starts a thread in a text or announcement channel. The type defaults to `ChannelType.PublicThread`, and a private thread is possible only in a text channel. Creating a public thread needs `CreatePublicThreads`, and a private one needs `CreatePrivateThreads`. The bot becomes the thread's first member

```ts
import { ChannelType, ThreadAutoArchiveMinutes, type Client } from "@neontechspace/fluxerly"

export async function startPlanning(client: Client, channelId: string) {
    const thread = await client.threads.create(channelId, {
        name: "Release planning",
        type: ChannelType.PrivateThread,
        autoArchiveMinutes: ThreadAutoArchiveMinutes.OneDay,
    })
    if (thread.isErr()) return thread
    return client.messages.send(thread.value.id, "Planning starts here")
}
```

To start a public thread on an existing message instead, use `threads.createFromMessage`. The thread takes the message's ID, and a message can start only one thread. It needs `CreatePublicThreads` and `ReadMessageHistory`

```ts
import type { Client, Message } from "@neontechspace/fluxerly"

export async function discussIn(client: Client, message: Message) {
    return await client.threads.createFromMessage(message, { name: "Discussion" })
}
```

## Create a forum post

In a forum or media channel, `threads.createPost` creates a post: A public thread together with its first message. The message takes the same content, embeds, files and stickers as `messages.send`, and files go in the same request. The `appliedTagIds` setting applies up to 5 of the channel's tags. The [forum channel guide](/docs/{{version}}/forum-channels/) describes the tags and settings a forum channel has

```ts
import type { Client } from "@neontechspace/fluxerly"

export async function reportCrash(client: Client, forumId: string, tagId: string, log: Uint8Array) {
    const post = await client.threads.createPost(forumId, {
        name: "Crash on start",
        appliedTagIds: [tagId],
        message: {
            content: "The log is attached",
            attachments: [{ data: log, filename: "crash.log", contentType: "text/plain" }],
        },
    })
    return post.map(({ thread, message }) => ({ postId: thread.id, messageId: message.id }))
}
```

## Archive, lock and pin threads

The `threads.edit` method changes the supplied settings and returns the updated thread. The thread's creator can rename it, archive it, lock it and change its archive period and tags. Unlocking, slowmode, pinning and moderated tags need `ManageThreads`. A locked thread accepts changes only from members who can manage threads, and an archived thread accepts only a change that also unarchives it

```ts
import type { Client } from "@neontechspace/fluxerly"

export async function closeThread(client: Client, threadId: string) {
    return await client.threads.edit(threadId, { archived: true, locked: true }, { auditReason: "Resolved" })
}
```

Setting `pinned` to `true` pins a forum or media post at the top of its channel, which holds at most one pinned post. Delete a thread with `channels.delete`

## List threads

The `threads.fetchActive` method returns every active thread the bot can view in a community, newest first. A private thread appears only when the bot joined it or can manage threads in its parent channel

The `threads.fetchArchived` method returns one page of archived threads of a channel. Its `scope` selects public threads, private threads or the private threads the bot joined. Reading them needs `ReadMessageHistory`, and the `private` scope also needs `ManageThreads`. The `public` and `private` scopes list the most recently archived threads first, so pass the last thread's `archiveTimestamp` as `before` to read the next page. The `joinedPrivate` scope lists the newest threads first, so pass the last thread's `id` as `before` instead

```ts
import type { Client, GuildThreadChannel } from "@neontechspace/fluxerly"

export async function archivedThreads(client: Client, channelId: string, maxPages = 5) {
    const threads: GuildThreadChannel[] = []
    let before: string | undefined
    for (let page = 0; page < maxPages; page++) {
        const result = await client.threads.fetchArchived(channelId, before === undefined ? {} : { before })
        if (result.isErr()) return result
        threads.push(...result.value.threads)
        before = result.value.threads.at(-1)?.archiveTimestamp
        if (!result.value.hasMore || before === undefined) break
    }
    return threads
}
```

In every list, a thread the bot joined has `membership` set

## Search threads

The `threads.search` method finds threads of a text, announcement, forum or media channel by name, tags and archive state, and returns one page. In a forum or media channel, the page's `firstMessages` holds the first message of each post. Searching needs `ReadMessageHistory`

When a community has no thread search index yet, Fluxer starts building one and the result has `indexing` set to `true` and no threads. The SDK does not retry, so search again later

```ts
import type { Client } from "@neontechspace/fluxerly"

export async function findCrashReports(client: Client, forumId: string) {
    const result = await client.threads.search(forumId, { name: "crash", archived: false, limit: 10 })
    if (result.isErr()) return result
    if (result.value.indexing) return "The search index is still being built"
    return result.value.threads.map((thread) => thread.name)
}
```

## Manage thread members

The bot joins and leaves a thread with `threads.join` and `threads.leave`. Adding a community member who can view the parent channel with `threads.addMember` needs `SendMessagesInThreads`, and removing one with `threads.removeMember` needs `ManageThreads`, unless the bot created the private thread. An archived thread accepts no membership changes

The `threads.fetchMembers` method reads one page of members in user ID order, and `threads.iterateMembers` reads every page up to `maxItems`. With `withMember`, each `ThreadMember` also holds the user's community membership. Fluxer's thread member data does not name the community, so the SDK takes it from the cached thread, or reads the thread once when it is not cached

```ts
import type { Client } from "@neontechspace/fluxerly"

export async function memberNames(client: Client, threadId: string) {
    const names: string[] = []
    for await (const result of client.threads.iterateMembers(threadId, { maxItems: 500, withMember: true })) {
        if (result.isErr()) return result
        names.push(result.value.member?.nickname ?? result.value.member?.username ?? result.value.userId)
    }
    return names
}
```

## Find the thread a message started

A message that started a thread has the `MessageFlags.HasThread` bit, and its `thread` field holds that thread while it exists. When someone starts a public or announcement thread, Fluxer also posts a `MessageType.ThreadCreated` notice in the parent channel. The notice's content is the thread name and its `messageReference` names the thread. Prefix commands never run for such a notice

```ts
import { MessageFlags, type Message } from "@neontechspace/fluxerly"

export function startedThread(message: Message) {
    return ((message.flags ?? 0) & MessageFlags.HasThread) !== 0 ? message.thread : undefined
}
```

## Find where threads are available

The `guilds.fetchPage` method reports `threadsActive` for each community. It is true where the bot can use threads, forum channels and media channels

```ts
import type { Client } from "@neontechspace/fluxerly"

export async function communitiesWithThreads(client: Client) {
    const page = await client.guilds.fetchPage()
    return page.map((guilds) => guilds.filter((guild) => guild.threadsActive).map((guild) => guild.id))
}
```

## Thread permissions

`Permissions` includes `ManageThreads`, `CreatePublicThreads`, `CreatePrivateThreads` and `SendMessagesInThreads`. A thread has no permission overwrites of its own. Fluxer computes its permissions in the parent channel and uses `SendMessagesInThreads` in place of `SendMessages`. The `permissions.calculate` method does the same when it receives the parent as `parentChannel`, and `permissions.fetch` and the `requirePermissions` guard read the parent themselves. See [communities and permissions](/docs/{{version}}/guilds-and-permissions/#check-permissions-using-available-data)
