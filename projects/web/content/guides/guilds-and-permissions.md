---
title: Read communities and plan permission-aware work
navTitle: Communities & permissions
description: Read communities, members and channels, calculate permissions, grant roles and moderate members deliberately
---

A [community](/docs/{{version}}/glossary/#guild), called a guild in the API, has its own [members](/docs/{{version}}/glossary/#member), [roles](/docs/{{version}}/glossary/#role) and channels. Each kind of community data comes from its own request: Fetching a community does not load its members or roles. Fetch the data a decision needs, then let Fluxer check the final request, because a permission calculated locally does not authorize anything by itself

## Read a community and one member together

Fetch the community and one member to show their details. Add this helper to a module that already has a bot [`Client`](/docs/{{version}}/api/interfaces/js-ts.Client/)

```ts
import type { Client } from "@neontechspace/fluxerly"

export async function readGuildMember(client: Client, guildId: string, userId: string) {
    const [guild, member] = await Promise.all([
        client.guilds.fetch(guildId),
        client.members.fetch({ guildId, userId }),
    ])

    if (guild.isErr()) return guild
    if (member.isErr()) return member

    return { guild: guild.value, member: member.value }
}
```

The helper returns the community and the member, or the first failed [Result](/docs/{{version}}/glossary/#result) if either request fails. The returned objects are [frozen snapshots](/docs/{{version}}/glossary/#frozen-snapshot) that do not change afterward

The bot must be a member of the community for [`Guilds.fetch`](/docs/{{version}}/api/interfaces/js-ts.Guilds/#fetch) to succeed, and the result does not include the member list. The two reads are separate observations, so neither proves that a later role action will still be allowed

The `guildHealthUpdate` event reports lag and recovery of a community's server through `guildId` and `degraded`. A degraded server is lagging, not disconnected or unavailable. The notice does not reconnect the client or invalidate community caches

## List channels by type

Each channel has a `type`. Comparing it with a `ChannelType` constant tells TypeScript which fields that channel has, such as `topic` for text channels or `bitrate` for voice channels

```ts
import { ChannelType, type Client, type GuildChannel } from "@neontechspace/fluxerly"

function describeChannel(channel: GuildChannel): string {
    const name = channel.name ?? channel.id
    switch (channel.type) {
        case ChannelType.Text:
            return `#${name}: ${channel.topic ?? "no topic"}`
        case ChannelType.Announcement:
            return `#${name}: announcements, ${channel.topic ?? "no topic"}`
        case ChannelType.Voice:
            return `${name}: voice at ${channel.bitrate ?? "unknown"} bps`
        case ChannelType.Category:
            return `${name}: category`
        case ChannelType.Link:
            return `${name}: link to ${channel.url ?? "an unknown address"}`
        case "unknown":
            console.warn(`Channel ${channel.id} has type ${channel.rawType}, which this SDK version does not know`)
            return `${name}: unsupported type ${channel.rawType}`
    }
}

export async function listChannels(client: Client, guildId: string) {
    const channels = await client.channels.fetchAll(guildId)
    return channels.map((list) => list.map(describeChannel))
}
```

The helper returns a Result with one line for each channel the bot can see. A channel type that Fluxer adds later, which this SDK version does not know yet, arrives with `type` set to `"unknown"` and the number Fluxer sent in `rawType`. Handling the `"unknown"` case makes the `switch` complete, so TypeScript can check that every case returns a value

Announcement channels have the same topic and message fields as text channels. See [announcement channels](/docs/{{version}}/announcement-channels/) to create or convert one, publish a message and follow it from a text channel in the same community or another one

## Read the member verification level

The community's `verificationLevel` describes its member verification policy. The `GuildVerificationLevels` constants range from `None` through `High`. Fluxer retired its phone-verification level, so there is no `VeryHigh` constant. This policy is separate from the [two-factor requirement for moderation](/docs/{{version}}/guilds-and-permissions/#communities-that-require-two-factor-authentication)

## Check permissions using available data

Check whether a member has the `ManageRoles` permission from data the application already holds. Supply a [`PermissionInput`](/docs/{{version}}/api/interfaces/js-ts.PermissionInput/) with the community, the member, every role the member has and, optionally, the target channel

```ts
import { Permissions, type Client, type PermissionInput } from "@neontechspace/fluxerly"

export function hasManageRoles(client: Client, input: PermissionInput) {
    const calculated = client.permissions.calculate(input)
    return (calculated & Permissions.ManageRoles) === Permissions.ManageRoles
}
```

The helper returns `true` or `false` from the supplied data. It throws `GuildOperationError` with reason `input` if that data is inconsistent or incomplete

<details>
<summary>What does a calculated permission not cover?</summary>

The [`permissions.calculate`](/docs/{{version}}/api/interfaces/js-ts.PermissionHelpers/#calculate) method makes no request and reads no cache. Its result does not establish channel visibility, role hierarchy, multi-factor authentication requirements, application authorization or Fluxer's final decision.
For prefix commands, the `guards.requirePermissions` guard in the [commands guide](/docs/{{version}}/commands/) performs this check from cached or fetched data

</details>

## Grant a configured opt-in role

Call this helper from a command in a community that lets a member opt into a role. Take `roleId` from trusted application configuration, not from command text, and configure only roles that members may assign to themselves. Before the request, `fetchCanManage` checks the [role hierarchy](/docs/{{version}}/glossary/#role-hierarchy): The bot can manage a member only when its highest role ranks above theirs

```ts
import type { Client, Message } from "@neontechspace/fluxerly"

export async function grantOptInRole(
    client: Client,
    message: Message,
    roleId: string,
) {
    if (message.author.isBot || !message.guildId) return
    const member = { guildId: message.guildId, userId: message.author.id }
    const canManage = await client.members.fetchCanManage(member)
    if (canManage.isErr()) return canManage
    if (!canManage.value) return
    return await client.members.addRole(member, roleId)
}
```

The helper gives the configured role to the command's author. It returns `undefined` when the message is not from a person in a community or the bot's highest role does not rank above that member's, and otherwise the Result of the rank check or the role request

<details>
<summary>Why check rank and still inspect the result?</summary>

Use [`fetchCanManage`](/docs/{{version}}/api/interfaces/js-ts.Members/#fetchcanmanage) to compare the bot's role rank with the member's. Fluxer itself enforces the role hierarchy, management restrictions and the bot's `ManageRoles` permission on [`addRole`](/docs/{{version}}/api/interfaces/js-ts.Members/#addrole).
An earlier check can become stale before the request, so the command must still inspect the final Result and apply any additional access policy of the application

</details>

## Moderate members

Moderation actions follow the same pattern as roles. A moderation command should also check the moderator who typed it, so a member cannot use the bot against someone who ranks above them. The `actorUserId` option of `fetchCanManage` checks that person instead of the bot. This helper bans a member for one day and deletes their messages from the last hour

```ts
import type { Client, MemberReference } from "@neontechspace/fluxerly"

export async function banForOneDay(client: Client, target: MemberReference, moderatorId: string) {
    const [bot, moderator] = await Promise.all([
        client.members.fetchCanManage(target),
        client.members.fetchCanManage(target, { actorUserId: moderatorId }),
    ])
    if (bot.isErr()) return bot
    if (moderator.isErr()) return moderator
    if (!bot.value || !moderator.value) return

    return await client.members.ban(target, {
        durationMs: 24 * 60 * 60 * 1000,
        deleteMessagesMs: 60 * 60 * 1000,
    })
}
```

The helper returns `undefined` when the bot or the moderator does not rank above the target, and otherwise the Result of a rank check or the ban. Omit `durationMs` for a permanent ban. Both durations are in milliseconds and must be whole seconds. Fluxer checks the bot's permissions, such as Ban Members, and the role hierarchy for each request

The SDK checks ban options before sending anything. An invalid option fails with a `GuildOperationError` whose `reason` is `input`, and its `inputValidation.path` names the field, such as `input.durationMs`. A [`duration` command argument](/docs/{{version}}/commands/#convert-arguments-before-execution) can be passed to `durationMs` unchanged when it sets `wholeSeconds: true`, `min: 60_000` and `max: 63_072_000_000`

The [`members.kick`](/docs/{{version}}/api/interfaces/js-ts.Members/#kick) and `members.timeout` methods take the same member reference. Use `members.unban` and `members.fetchBans` to review and lift bans. In a prefix command, `guards.requirePermissions(["BanMembers"])` makes sure the person who typed the command also has that permission

<details>
<summary>Compare ranks from data already held</summary>

The `fetchCanManage` method fetches fresh community, member and role data for each check. When the application already holds that data, the `hierarchy` helpers compare it without a request: `hierarchy.canManage({ guild, actor, target, roles })` checks one member against another, and `hierarchy.compare` and `hierarchy.isAbove` order two roles. Like `fetchCanManage`, they check rank only, not permissions

</details>

## Communities that require two-factor authentication

A community owner can require two-factor authentication ([MFA](/docs/{{version}}/glossary/#mfa)) for moderation. In such a community, only the owner and accounts with two-factor authentication enabled can use `Administrator`, `BanMembers`, `KickMembers`, `ManageChannels`, `ManageGuild`, `ManageMessages`, `ManageRoles`, `ManageWebhooks` and `ModerateMembers`. That covers kicks, bans, timeouts, role changes, deleting other people's messages and changes to channels, webhooks and community settings

A bot cannot enable two-factor authentication itself. Its account follows the account that owns its application, so the bot can act in these communities only when that owner account has two-factor authentication enabled, or when the bot owns the community

Otherwise Fluxer refuses the request with HTTP 400 after confirming that the bot holds the permission. To tell this failure apart from other rejections, check `errors.apiCode(result.error) === "twoFactorRequired"`. The `errors.apiCode` function, imported with `errors` from the SDK, returns the name of Fluxer's error code, or `undefined` when the error carries no code that the SDK recognizes. Repeating the request fails the same way until the application owner enables two-factor authentication. A calculated permission from `permissions.calculate` or a passing `guards.requirePermissions` guard does not rule this out, because both read role permissions and not the community's requirement

To check a community in advance, read the [`mfaLevel`](/docs/{{version}}/api/interfaces/js-ts.Guild/#mfalevel) of the community from `guilds.fetch` or a `guildCreate` event. The value `GuildMfaLevels.Elevated` means the community has this requirement, and `GuildMfaLevels.None` means it does not. The SDK cannot see whether the application owner has two-factor authentication enabled, so an elevated level means a moderation request can fail, not that it will. Fluxer's API reference describes [MFA levels](https://docs.fluxer.app/http-api/guilds/#mfa-levels) and [elevated permissions](https://docs.fluxer.app/http-api/permissions/#elevated-permissions)

## Read audit records

Use `auditLogs.fetchPage` or the bounded `auditLogs.iterate` scan with `ViewAuditLog` permission. Recorded message-deletion durations are exposed in `options.deleteMessagesMs`, rounded to whole milliseconds. A duration that would overflow the safe integer range fails the REST page rather than returning partial entries. The same invalid duration in a gateway audit event follows the configured malformed-dispatch policy

## Voice controls versus a voice connection

Fluxerly supports observing voice states in communities and moving, disconnecting, community muting and community deafening members who are already in a voice channel. These controls remain subject to Fluxer's permissions

Bots cannot join voice channels or send and receive audio or video yet. That feature waits for Fluxer's voice update and an SDK implementation after it. A `Connect` or `Speak` permission describes what Fluxer allows, not an SDK feature, and the bot's gateway `connect()` receives events rather than opening a voice connection. See [member voice controls](/docs/{{version}}/api/interfaces/js-ts.Members/#move) for the current operations

## Wire it up

In a `runBot` bot, the command context provides the `client` and the incoming message. This bot answers `!notify` by granting the role configured in `OPT_IN_ROLE_ID`

```ts
import { guards, runBot } from "@neontechspace/fluxerly"

const optInRoleId = process.env.OPT_IN_ROLE_ID

await runBot({
    token: process.env.FLUXER_BOT_TOKEN,
    processSignals: true,
    commands: {
        prefix: "!",
        commands: {
            notify: {
                description: "Join the announcements role",
                guard: guards.guildOnly(),
                execute: async ({ client, message, reply }) => {
                    if (!optInRoleId || !message.guildId) return reply("The opt-in role is not configured")
                    const member = { guildId: message.guildId, userId: message.author.id }
                    const canManage = await client.members.fetchCanManage(member)
                    if (canManage.isErr()) return canManage
                    if (!canManage.value) return reply("The bot's role must rank above yours")
                    const added = await client.members.addRole(member, optInRoleId)
                    return added.isErr() ? added : reply("Role added")
                },
            },
        },
    },
})
```

Returning a failed Result from `execute` reports it with the command name, without stopping the bot. In a direct message, `guards.guildOnly()` denies `!notify`, and the router explains why, as `runBot` answers rejected commands by default
