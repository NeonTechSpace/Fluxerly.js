// In a server that requires two-factor authentication for moderation, Fluxer refuses these commands with
// HTTP 400 unless the account that owns the bot's application has two-factor authentication enabled
import { describeError, format, guards, orThrow, runBot } from "@neontechspace/fluxerly"

// A failure that stops the bot, such as a rejected token, is logged and sets a failing exit code
await runBot({
    token: process.env.FLUXER_BOT_TOKEN,
    processSignals: true,
    onError: (report) => console.error(report.describe()),
    commands: {
        prefix: "!",
        use: [
            // Tell the moderator when a command fails, without showing error details in the channel.
            // The router still reports the full error to onError
            async ({ reply }, next) => {
                try {
                    await next()
                } catch (error) {
                    const sent = await reply("That command failed. The error was reported")
                    if (sent.isErr()) console.error(describeError(sent.error))
                    throw error
                }
            },
        ],
        commands: {
            timeout: {
                description: "Stop a member from talking for a while",
                guard: guards.requirePermissions(["ModerateMembers"]),
                arguments: {
                    member: { type: "member" },
                    duration: { type: "duration", min: 60_000, max: 7 * 24 * 60 * 60_000 },
                    reason: { type: "text", rest: true, optional: true },
                },
                execute: async ({ client, message, values, reply }) => {
                    // The moderator must outrank the member, so the bot never acts above the moderator's own rank
                    const moderator = { actorUserId: message.author.id }
                    if (!orThrow(await client.members.fetchCanManage(values.member, moderator)))
                        return reply("That member ranks at or above the moderator")
                    orThrow(
                        await client.members.timeout(values.member, values.duration, {
                            timeoutReason: values.reason ?? null,
                        }),
                    )
                    return reply(`Timed out ${format.userMention(values.member.userId)}`)
                },
            },
            kick: {
                description: "Remove a member from the server",
                guard: guards.requirePermissions(["KickMembers"]),
                arguments: { member: { type: "member" }, reason: { type: "text", rest: true, optional: true } },
                execute: async ({ client, message, values, reply }) => {
                    // The moderator must outrank the member, so the bot never acts above the moderator's own rank
                    const moderator = { actorUserId: message.author.id }
                    if (!orThrow(await client.members.fetchCanManage(values.member, moderator)))
                        return reply("That member ranks at or above the moderator")
                    const options = values.reason === undefined ? {} : { auditReason: values.reason }
                    orThrow(await client.members.kick(values.member, options))
                    return reply(`Kicked ${format.userMention(values.member.userId)}`)
                },
            },
            ban: {
                description: "Ban a member permanently",
                guard: guards.requirePermissions(["BanMembers"]),
                arguments: { member: { type: "member" }, reason: { type: "text", rest: true, optional: true } },
                execute: async ({ client, message, values, reply }) => {
                    // The moderator must outrank the member, so the bot never acts above the moderator's own rank
                    const moderator = { actorUserId: message.author.id }
                    if (!orThrow(await client.members.fetchCanManage(values.member, moderator)))
                        return reply("That member ranks at or above the moderator")
                    const ban = values.reason === undefined ? {} : { reason: values.reason }
                    orThrow(await client.members.ban(values.member, ban))
                    return reply(`Banned ${format.userMention(values.member.userId)}`)
                },
            },
            // A separate command keeps the duration required, so a reason word is never read as a duration
            tempban: {
                description: "Ban a member for a while, such as 7d",
                guard: guards.requirePermissions(["BanMembers"]),
                arguments: {
                    member: { type: "member" },
                    // Fluxer takes ban durations in whole seconds, from one minute up to two years
                    duration: { type: "duration", wholeSeconds: true, min: 60_000, max: 63_072_000_000 },
                    reason: { type: "text", rest: true, optional: true },
                },
                execute: async ({ client, message, values, reply }) => {
                    const moderator = { actorUserId: message.author.id }
                    if (!orThrow(await client.members.fetchCanManage(values.member, moderator)))
                        return reply("That member ranks at or above the moderator")
                    // Ban durations are milliseconds, so the bounded duration argument passes through unchanged
                    const ban = {
                        durationMs: values.duration,
                        ...(values.reason === undefined ? {} : { reason: values.reason }),
                    }
                    orThrow(await client.members.ban(values.member, ban))
                    return reply(`Banned ${format.userMention(values.member.userId)} for a while`)
                },
            },
            clear: {
                description: "Delete recent messages in this channel",
                guard: guards.requirePermissions(["ManageMessages"]),
                cooldown: { durationMs: 10_000, per: "channel" },
                arguments: { count: { type: "integer", min: 1, max: 100, default: 10 } },
                execute: async ({ client, message, values, reply }) => {
                    // The preview lists the exact messages first, and cleanup deletes only those
                    const plan = orThrow(
                        await client.messages.previewCleanup(message.channelId, {
                            filter: (candidate) => candidate.id !== message.id,
                            maxScanned: values.count + 1,
                            maxSelected: values.count,
                        }),
                    )
                    const report = orThrow(await client.messages.cleanup(plan))
                    return reply(`Requested deletion of ${report.selectedMessageIds.length} messages`)
                },
            },
        },
    },
})
