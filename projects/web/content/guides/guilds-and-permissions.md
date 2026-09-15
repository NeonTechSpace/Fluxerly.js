---
title: Read guilds and plan permission-aware work
navTitle: Guilds & permissions
description: Read guild resources, calculate permissions and assign an opt-in role deliberately
---

Guild data has separate pieces. A guild fetch does not preload its members or roles, and a permission value does not authorize an action by itself. Build decisions from the smallest evidence your task needs, then let Fluxer enforce the final request

## Read a guild and one member together

Load the two snapshots needed to show a member in a known guild. Add this reusable helper to a module where your bot already has a [`Client`](/docs/{{version}}/api/interfaces/js-ts.Client/)

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

The helper returns a frozen guild and membership snapshot, or preserves the first typed read failure it encounters

[`Guilds.fetch`](/docs/{{version}}/api/interfaces/js-ts.Guilds/#fetch) requires bot membership but does not return a complete roster. The two reads are separate observations, so neither proves a later role action will still be allowed

## Calculate permission bits from snapshots you already own

Check whether a complete local snapshot includes the `ManageRoles` bit. Supply a [`PermissionInput`](/docs/{{version}}/api/interfaces/js-ts.PermissionInput/) containing one guild, one member, every required role, and an optional target channel

```ts
import { Permissions, type Client, type PermissionInput } from "@neontechspace/fluxerly"

export function hasManageRoles(client: Client, input: PermissionInput) {
    const calculated = client.permissions.calculate(input)
    if (calculated.isErr()) return calculated

    return (calculated.value & Permissions.ManageRoles) === Permissions.ManageRoles
}
```

The helper returns `true` or `false` from the supplied snapshots, or a typed input error when the snapshots are inconsistent or incomplete

The [`permissions.calculate`](/docs/{{version}}/api/interfaces/js-ts.PermissionHelpers/#calculate) method makes no request and reads no cache. Its result does not establish channel visibility, hierarchy, multi-factor authentication requirements, application authorization, or the provider's final decision

## Grant a configured opt-in role

Call this helper from a guild command that lets a member opt into a role. Supply `roleId` from trusted application configuration, not arbitrary command text. Only configure a role you intend members to assign to themselves

```ts
import type { Client, Message } from "@neontechspace/fluxerly"

export async function grantOptInRole(
    client: Client,
    message: Message,
    roleId: string,
) {
    if (message.author.isBot || !message.guildId) return
    const member = { guildId: message.guildId, userId: message.author.id }
    const hierarchy = await client.members.fetchHierarchyCheck(member)
    if (hierarchy.isErr()) return hierarchy
    if (!hierarchy.value) return
    return await client.members.addRole(member, roleId)
}
```

The helper assigns the configured role to the command's author. It returns `undefined` when the message is ineligible or the bot does not outrank that member, otherwise a Result from the hierarchy check or role request

Use [`fetchHierarchyCheck`](/docs/{{version}}/api/interfaces/js-ts.Members/#fetchhierarchycheck) to compare member rank. Fluxer enforces the role's hierarchy, management restrictions and the bot's `ManageRoles` permission on [`addRole`](/docs/{{version}}/api/interfaces/js-ts.Members/#addrole). A preflight check can become stale. Your command must still inspect the final Result and apply any additional application access policy

## Voice controls versus a voice connection

Fluxerly supports guild voice-state observations and member move, disconnect, server-mute and server-deafen controls. These act on existing participants and remain subject to Fluxer's permissions and deployment behavior

Bot voice joining and audio/media transport are deferred until after Fluxer's voice update. They will still need an SDK implementation and verification. Neither API currently joins voice channels or sends and receives audio or video. A `Connect` or `Speak` permission bit describes provider permissions, not an implemented SDK media feature

See [member voice controls](/docs/{{version}}/api/interfaces/js-ts.Members/#move) for the current control operations. The bot's gateway `connect()` receives events and is not a voice connection
