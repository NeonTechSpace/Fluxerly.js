---
title: Create and manage forum channels
navTitle: Forum channels
description: Recognize forum and media channels, create them with tags and post settings, change one tag at a time and read their posts
---

A forum channel holds posts instead of messages. Each post is a public thread with its own first message. A media channel is a forum channel that can also hide media download options

The examples use the default API. The Effect entry point exports the same names

## Recognize a forum channel

Compare `type` with `ChannelType.Forum` or `ChannelType.Media`. Both shapes share the post settings below, and only a forum channel has `defaultForumLayout`

```ts
import { ChannelFlags, ChannelType, type GuildChannel } from "@neontechspace/fluxerly"

export function forumSummary(channel: GuildChannel) {
    if (channel.type !== ChannelType.Forum && channel.type !== ChannelType.Media) return undefined
    return {
        guidelines: channel.topic,
        tags: (channel.availableTags ?? []).map((tag) => tag.name),
        requiresTag: ((channel.flags ?? 0) & ChannelFlags.RequireTag) !== 0,
    }
}
```

The `channels.fetchAll` method lists forum and media channels but never their posts. The `channels.fetch` method returns a post as a thread shape when the ID names one, and `channels.get` can return one when the cache holds it, so compare `type` or use `isThreadChannel` before reading fields that only some shapes have

## Read post settings

Fluxer leaves the post settings out of some payloads, such as the `guildChannelDelete` event. Each setting is therefore optional, and its absence means that it is unavailable, not that it has its default

- `availableTags`: The tags a post can carry, at most 20. Only members who can manage threads may apply or remove a `moderated` tag
- `defaultReactionEmoji`: The reaction clients show on each post, or null
- `defaultSortOrder`: A `ForumSortOrder` value, or null
- `defaultForumLayout`: A `ForumLayout` value, on a forum channel only
- `defaultTagSetting`: How a post search matches tags, `"match_some"` or `"match_all"`
- `defaultAutoArchiveMinutes` and `defaultThreadRateLimitPerUser`: Defaults for new posts. Fluxer stores the archive period but does not apply it to a new post
- `flags`: `ChannelFlags.RequireTag`, and `ChannelFlags.HideMediaDownloadOptions` on a media channel

Flag bits, sort orders, layouts and tag settings that this SDK version does not name are kept as Fluxer sent them. Audit-log entries for forum channel changes record `available_tags` as `ForumTag` values and `default_reaction_emoji` as a `ForumDefaultReaction`

## Read posts

Each post is a `GuildPublicThreadChannel` whose `parentId` is the forum or media channel. The `appliedTagIds` field lists the post's tags, and `ChannelFlags.Pinned` in `flags` marks the channel's pinned post. [Read threads](/docs/{{version}}/threads/) covers the fields every thread shares

```ts
import { ChannelType, type GuildForumChannel, type GuildThreadChannel } from "@neontechspace/fluxerly"

export function postTagNames(forum: GuildForumChannel, post: GuildThreadChannel) {
    if (post.type !== ChannelType.PublicThread || post.parentId !== forum.id) return []
    const names = new Map((forum.availableTags ?? []).map((tag) => [tag.id, tag.name]))
    return (post.appliedTagIds ?? []).map((id) => names.get(id) ?? id)
}
```

## Create a forum or media channel

A `channels.create` call takes `ChannelType.Forum` or `ChannelType.Media` together with the channel's tags and post settings. The bot needs `ManageChannels`, and Fluxer rejects forum and media channels in a community where threads are not active, which `threadsActive` on `guilds.fetchPage` reports

```ts
import { ChannelFlags, ChannelType, ForumLayout, ForumSortOrder, type Client } from "@neontechspace/fluxerly"

export async function createHelpForum(client: Client, guildId: string) {
    const result = await client.channels.create(guildId, {
        type: ChannelType.Forum,
        name: "help",
        topic: "Ask one question per post and say what was already tried",
        availableTags: [
            { name: "bug", emojiName: "🐛" },
            { name: "question" },
            { name: "staff", moderated: true },
        ],
        defaultSortOrder: ForumSortOrder.CreationTime,
        defaultForumLayout: ForumLayout.List,
        flags: ChannelFlags.RequireTag,
    })
    return result.map((channel) => channel.id)
}
```

These settings are specific to forum and media channels, and the SDK rejects a setting that the created channel type cannot have before it sends anything

- `topic`: Posting guidelines of up to 4,096 characters, where other channels allow 1,024
- `availableTags`: Up to 20 tags. A tag has a `name` of 1 to 50 characters that no other tag of the channel uses, an optional `moderated` flag, and at most one of `emojiId`, a custom emoji of the community, and `emojiName`, a single Unicode emoji
- `defaultReactionEmoji`: The reaction on each post, with the same two emoji fields
- `defaultSortOrder`, `defaultForumLayout` and `defaultTagSetting`: The defaults that `ForumSortOrder`, `ForumLayout` and the tag setting names describe. A media channel has no layout
- `flags`: `ChannelFlags.RequireTag` makes every post carry a tag, which needs at least one tag that is not `moderated`. `ChannelFlags.HideMediaDownloadOptions` is valid on a media channel only

## Set thread defaults on any thread parent

Text, announcement, forum and media channels accept `defaultAutoArchiveMinutes`, one of the `ThreadAutoArchiveMinutes` values, and `defaultThreadRateLimitPerUser`, a slowmode in seconds from 0 to 21,600. A new thread copies the slowmode when its creation sets none. Fluxer stores the archive period but does not apply it, so a new thread uses `ThreadAutoArchiveMinutes.ThreeDays` unless its creation sets another period. In a community where threads are not active, Fluxer ignores both settings on text and announcement channels. Pass null to clear a default

## Change a forum channel

A `channels.edit` call accepts the same settings as creation, and it leaves every omitted setting unchanged. Passing null resets `defaultReactionEmoji`, `defaultSortOrder`, `defaultForumLayout` and `defaultTagSetting`. The `flags` value replaces all flags, so include `ChannelFlags.RequireTag` to keep it

The `availableTags` list replaces the whole tag list. An entry with an `id` keeps that tag and replaces its settings, an entry without one adds a tag, and a tag left out is deleted, after which posts stop showing it. A received `ForumTag` is valid input, so passing back `forum.availableTags` keeps every tag. An edit cannot see the channel's type, so Fluxer ignores a setting that does not belong to it, such as `availableTags` sent for a text channel

## Change one tag

Changing a single tag through a full list risks overwriting a concurrent change. The `channels.createForumTag`, `channels.editForumTag` and `channels.deleteForumTag` methods change one tag and return the updated channel. Each needs `ManageChannels` and accepts an `auditReason`

```ts
import type { Client, GuildForumChannel } from "@neontechspace/fluxerly"

export async function addTag(client: Client, forumId: string, name: string) {
    const updated = await client.channels.createForumTag(forumId, { name })
    return updated.map((channel) => channel.availableTags?.find((tag) => tag.name === name)?.id)
}

export async function moderateTag(client: Client, forum: GuildForumChannel, tagName: string) {
    const tag = forum.availableTags?.find((candidate) => candidate.name === tagName)
    if (tag === undefined) return undefined
    // Editing a tag replaces all of its settings, so the received tag supplies the ones that stay
    return await client.channels.editForumTag(forum.id, tag.id, { ...tag, moderated: true })
}

export async function removeTag(client: Client, forumId: string, tagId: string) {
    return await client.channels.deleteForumTag(forumId, tagId)
}
```

Fluxer assigns the ID of a new tag, so read it from the returned channel by name. An edit without `moderated` or an emoji resets them to false or none. Deleting an unknown tag fails, which includes a second delete of the same tag. Fluxer also rejects a change that would leave a channel with `ChannelFlags.RequireTag` without a tag that is not moderated

## Start posts

[Read threads](/docs/{{version}}/threads/) covers posts started with the bot. A webhook that belongs to a forum or media channel can start a post with `threadName`, as the [webhook guide](/docs/{{version}}/webhooks-and-oauth/#post-into-threads-and-forum-channels) shows
