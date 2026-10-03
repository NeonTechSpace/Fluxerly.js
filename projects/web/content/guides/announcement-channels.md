---
title: Publish and follow announcement channels
navTitle: Announcement channels
description: Create announcement channels, publish messages, follow them in the same community or another one and handle published copies
---

An announcement channel publishes messages to the text channels that follow it, in the same community or another one. Sending a message to the announcement channel does not publish it

These helpers take the existing `client` from the [first bot](/docs/{{version}}/quick-start/) or [first Effect bot](/docs/{{version}}/effect-first-bot/). Pass decimal IDs from trusted application configuration. The default API returns a [Result](/docs/{{version}}/glossary/#result). Native Effect helpers return an [Effect](/docs/{{version}}/glossary/#effect), run with `yield*` inside the application program

## Create an announcement channel

Creating a channel needs `ManageChannels` in its community. Set `type` to `ChannelType.Announcement`, whose protocol value is 5

```ts
import { ChannelType, type Client } from "@neontechspace/fluxerly"

export async function createAnnouncements(client: Client, guildId: string) {
    return await client.channels.create(guildId, {
        type: ChannelType.Announcement,
        name: "announcements",
        topic: "Published community updates",
    })
}
```

The returned announcement channel has the `GuildAnnouncementChannel` shape. It has the same message and topic fields as a text channel

With the native Effect API:

```ts
import { ChannelType, type Client } from "@neontechspace/fluxerly/effect"

export function createAnnouncementsWithEffect(client: Client, guildId: string) {
    return client.channels.create(guildId, {
        type: ChannelType.Announcement,
        name: "announcements",
        topic: "Published community updates",
    })
}
```

## Convert an existing channel

Use `channels.edit` with a new type to convert a text channel into an announcement channel. The same helper can convert it back to `ChannelType.Text`. Both directions need `ManageChannels`

```ts
import { ChannelType, type Client } from "@neontechspace/fluxerly"

export async function setAnnouncementChannel(client: Client, channelId: string, enabled: boolean) {
    return await client.channels.edit(channelId, {
        type: enabled ? ChannelType.Announcement : ChannelType.Text,
    })
}
```

A text channel that follows an announcement channel cannot become one. Delete its follower webhooks first. Converting an announcement channel back to text removes its follower webhooks asynchronously. A successful edit does not wait for that removal

Fluxer sends a `channelUpdate` event with the new type. Code that handles channel updates must check the new `type` rather than retaining the old channel shape

With the native Effect API:

```ts
import { ChannelType, type Client } from "@neontechspace/fluxerly/effect"

export function setAnnouncementChannelWithEffect(client: Client, channelId: string, enabled: boolean) {
    return client.channels.edit(channelId, {
        type: enabled ? ChannelType.Announcement : ChannelType.Text,
    })
}
```

## Send a message, then publish it

Publishing sends copies to every following channel. First send a new message, not a reply, to the announcement channel, then pass the returned message to `messages.publish`

```ts
import type { Client } from "@neontechspace/fluxerly"

export async function publishUpdate(client: Client, channelId: string, content: string) {
    const sent = await client.messages.send(channelId, content)
    if (sent.isErr()) return sent

    return await client.messages.publish(sent.value)
}
```

Fluxer's API and flags call publishing crossposting: `MessageFlags.Crossposted` marks the source and `MessageFlags.IsCrosspost` marks each copy. Completion means Fluxer accepted publication, not that every copy has arrived. A bot that can see a following channel receives each copy as a `messageCreate` event

With the native Effect API, a failed send skips publication:

```ts
import { Effect } from "effect"
import type { Client } from "@neontechspace/fluxerly/effect"

export function publishUpdateWithEffect(client: Client, channelId: string, content: string) {
    return Effect.gen(function* () {
        const sent = yield* client.messages.send(channelId, content)
        return yield* client.messages.publish(sent)
    })
}
```

<details>
<summary>Publication limits and later changes</summary>

Only a message that is not a reply, forward, system notice or published copy can be published, and only once. It must be in an announcement channel. Publishing someone else's message needs `ManageMessages`. Fluxer limits publication to 10 messages per channel per hour

Editing the source message updates its published copies later. Deleting the source does not delete the copies. Fluxer marks them with `MessageFlags.SourceMessageDeleted`, changes their text to `[Original message deleted]` and removes their attachments

The [messages guide](/docs/{{version}}/messages/#reply-to-a-message-and-check-what-happened) explains which flags sends and edits accept

If sending succeeds but publication fails, the source message stays posted, but these helpers return only the failure and lose the sent ID. When the caller may retry, change the helper to return `sent.value.id` with the failure in the default API, or `sent.id` in the Effect API. Before publishing again, fetch that message and check `MessageFlags.Crossposted`. Do not rerun the whole helper after an [uncertain write](/docs/{{version}}/reliability/), because that can send another source message

</details>

## Follow an announcement channel from a text channel

The source is an announcement channel. The target is a text channel in the same community or another one. The bot needs `ManageWebhooks` in the target's community, plus `ViewChannel` and `ManageWebhooks` on the target channel. The bot must also be able to view the source channel

```ts
import type { Client } from "@neontechspace/fluxerly"

export async function followAnnouncements(client: Client, sourceChannelId: string, targetChannelId: string) {
    return await client.channels.follow(sourceChannelId, { targetChannelId })
}
```

Following creates a follower webhook in the target channel. The result contains `channelId` for the followed announcement channel and `webhookId` for the new follower webhook in the target. Keep that webhook ID to unfollow later. Fluxer usually posts a `MessageType.ChannelFollowAdd` notice in the target, but the notice is not guaranteed. Do not wait for it to decide whether following succeeded

With the native Effect API:

```ts
import type { Client } from "@neontechspace/fluxerly/effect"

export function followAnnouncementsWithEffect(client: Client, sourceChannelId: string, targetChannelId: string) {
    return client.channels.follow(sourceChannelId, { targetChannelId })
}
```

An application cannot send messages through a follower webhook. It has no token, so `createWebhookClient` cannot use it. The normal `client.webhooks.edit` method can rename it or move it to another text channel in the same community, but cannot change its avatar

## See follower counts and unfollow

Fetch the number of following channels and distinct receiving communities with `channels.fetchFollowerStats`. Fluxer can cache these counts for up to a minute, so a new follow or unfollow need not appear immediately

```ts
import type { Client } from "@neontechspace/fluxerly"

export async function readFollowerCounts(client: Client, channelId: string) {
    const result = await client.channels.fetchFollowerStats(channelId)
    if (result.isErr()) return result
    return { channels: result.value.channelCount, communities: result.value.guildCount }
}

export async function unfollowAnnouncements(client: Client, webhookId: string) {
    return await client.webhooks.delete(webhookId)
}
```

Deleting the follower webhook stops that target channel following the source. Use the `webhookId` from the follow result, or find the follower webhook through `client.webhooks.fetchForChannel`. Check `webhook.type === WebhookType.ChannelFollower` before treating an existing webhook as a follow. Deleting webhooks needs `ManageWebhooks`

With the native Effect API:

```ts
import { Effect } from "effect"
import type { Client } from "@neontechspace/fluxerly/effect"

export function readFollowerCountsWithEffect(client: Client, channelId: string) {
    return client.channels.fetchFollowerStats(channelId).pipe(
        Effect.map(stats => ({ channels: stats.channelCount, communities: stats.guildCount })),
    )
}

export function unfollowAnnouncementsWithEffect(client: Client, webhookId: string) {
    return client.webhooks.delete(webhookId)
}
```

## React to copies and follow notices

Published copies have `MessageFlags.IsCrosspost`. Follow notices have `MessageType.ChannelFollowAdd`. Register a `messageCreate` handler before connecting, and check these values before any check that skips bot or webhook authors so webhook-delivered copies are not skipped

```ts
import { MessageFlags, MessageType, type Client, type Message } from "@neontechspace/fluxerly"

export function observeAnnouncements(client: Client, observe: (message: Message) => void) {
    return client.on("messageCreate", message => {
        const isCopy = ((message.flags ?? 0) & MessageFlags.IsCrosspost) !== 0
        const isFollowNotice = message.type === MessageType.ChannelFollowAdd
        if (isCopy || isFollowNotice) observe(message)
    })
}
```

The returned subscription stops with the client. Call its `close()` method to stop it earlier. The [events guide](/docs/{{version}}/events-and-collectors/) covers registration and delivery limits

With the native Effect API, registration belongs to the scope that runs it. Keep that scope open while the handler is needed:

```ts
import { Effect } from "effect"
import { MessageFlags, MessageType, type Client, type Message } from "@neontechspace/fluxerly/effect"

export function observeAnnouncementsWithEffect(client: Client, observe: (message: Message) => void) {
    return client.on("messageCreate", message => Effect.sync(() => {
        const isCopy = ((message.flags ?? 0) & MessageFlags.IsCrosspost) !== 0
        const isFollowNotice = message.type === MessageType.ChannelFollowAdd
        if (isCopy || isFollowNotice) observe(message)
    }))
}
```

## Find where a copy came from

A published copy or follow notice can carry `message.messageReference`. This received `MessageContextReference` always has a source `channelId`, but its `id` is optional. A follow notice points only at the source channel. Check `id` before using the reference to fetch or reply to a specific message

The `messages.fetchCrosspostSource` method takes the copy or notice itself, not its source reference. It returns `{ guild }`, a public snapshot of the source community. When the reference has an ID, the helper below also fetches the source message. If the bot cannot read it, the helper returns that failure

```ts
import type { Client, Message } from "@neontechspace/fluxerly"

export async function readAnnouncementSource(client: Client, message: Message) {
    const source = await client.messages.fetchCrosspostSource(message)
    if (source.isErr()) return source

    const reference = message.messageReference
    if (!reference?.id) return { guild: source.value.guild }

    const original = await client.messages.fetch({ channelId: reference.channelId, id: reference.id })
    if (original.isErr()) return original
    return { guild: source.value.guild, message: original.value }
}
```

The public community snapshot includes its ID, name, description, icon, banner, public features and whether it is discoverable. Member and presence counts can be `null`. This read does not join the community or grant access to its channels. Fetching the original message can fail even when the public community read succeeds

With the native Effect API:

```ts
import { Effect } from "effect"
import type { Client, Message } from "@neontechspace/fluxerly/effect"

export function readAnnouncementSourceWithEffect(client: Client, message: Message) {
    return Effect.gen(function* () {
        const source = yield* client.messages.fetchCrosspostSource(message)
        const reference = message.messageReference
        if (!reference?.id) return { guild: source.guild }

        const original = yield* client.messages.fetch({ channelId: reference.channelId, id: reference.id })
        return { guild: source.guild, message: original }
    })
}
```

Follower webhook metadata can also include `sourceGuild` and `sourceChannel`. Those fields appear only while the source exists and is visible to the webhook's creator. Their absence alone does not prove the source was deleted

## Handle permission and delivery failures

Fluxer checks permissions on the final request. Local [permission checks](/docs/{{version}}/guilds-and-permissions/) can help explain a failure, but cannot authorize an action. Creating or converting channels needs `ManageChannels`. Following and managing follower webhooks needs `ManageWebhooks`. Publishing another author's message needs `ManageMessages`. Following also fails for a duplicate follow, incompatible age-restriction or content-warning settings, a full webhook limit, or a community with announcements disabled through the `ANNOUNCEMENT_CHANNELS_DISABLED` feature

The default API returns expected failures in a Result. Check `isErr()` before reading `value`, and use `describeError` to report a failure without logging credentials. Native Effects carry expected failures in their error channel. Use `Effect.match` as shown in [Effect workflows](/docs/{{version}}/effect-workflows/) when the application needs to turn success or failure into a value

A connected gateway is needed to observe conversions, copies and follow notices, not to make these HTTP requests. A successful request does not wait for later gateway delivery. Identify each copy by its own message ID, because a replayed event can deliver the same copy again
