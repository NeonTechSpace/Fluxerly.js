import { Data, Effect, Semaphore } from "effect"
import { defineBot, hierarchy, runBot, type Client } from "@neontechspace/fluxerly/effect"

// A missing or wrong setting fails setup, which stops the bot at startup with this message
class SettingError extends Data.TaggedError("SettingError")<{ readonly message: string }> {}

const requiredEnv = (name: string) =>
    Effect.suspend(() => {
        const value = process.env[name]
        return value ? Effect.succeed(value) : new SettingError({ message: `Set the ${name} environment variable` })
    })

const emoji = process.env.ROLE_EMOJI || "✅"
// Setup reads the required settings, so a test can import this file without them
let target = { channelId: "", id: "" }
let roleId = ""
let guildId = ""
let botUserId = ""

// Adds and removals reach separate handlers, which can run out of order when many members react at once. So each
// member's newest reaction event decides, by its receipt, and role changes go out one at a time
const newest = new Map<string, number>()
const oneAtATime = Semaphore.makeUnsafe(1)

const setRole = (client: Client, userId: string, granted: boolean, receipt: number) =>
    Effect.gen(function* () {
        if (userId === botUserId || receipt < (newest.get(userId) ?? 0)) return
        newest.set(userId, receipt)
        yield* oneAtATime.withPermit(
            Effect.suspend(() => {
                // A newer reaction event from this member arrived while this one waited
                if (newest.get(userId) !== receipt) return Effect.void
                const member = { guildId, userId }
                return granted ? client.members.addRole(member, roleId) : client.members.removeRole(member, roleId)
            }),
        )
    })

export const bot = defineBot({
    onError: (report) => Effect.logError(report.describe()),
    // Check the configuration once before connecting, so a missing setting or a role the bot cannot assign stops it
    // at startup
    setup: (client) =>
        Effect.gen(function* () {
            // Each client numbers its events from 1 again
            newest.clear()
            target = { channelId: yield* requiredEnv("ROLE_CHANNEL_ID"), id: yield* requiredEnv("ROLE_MESSAGE_ID") }
            roleId = yield* requiredEnv("ROLE_ID")
            guildId = (yield* client.channels.fetch(target.channelId)).guildId
            const self = yield* client.members.fetchSelf(guildId)
            botUserId = self.userId
            const roles = yield* client.roles.fetchAll(guildId)
            const role = roles.find((candidate) => candidate.id === roleId)
            const botRoles = roles.filter((candidate) => self.roleIds.includes(candidate.id))
            if (!role || !botRoles.some((botRole) => hierarchy.isAbove(botRole, role)))
                return yield* new SettingError({ message: "ROLE_ID must name a role below the bot's highest role" })
            // The bot's own reaction shows members which emoji to use
            yield* client.messages.addReaction(target, emoji)
        }),
    events: {
        messageReactionAdd: ({ event, client, context }) =>
            event.id === target.id && event.emoji.name === emoji
                ? setRole(client, event.userId, true, context.receipt)
                : Effect.void,
        messageReactionRemove: ({ event, client, context }) =>
            event.id === target.id && event.emoji.name === emoji
                ? setRole(client, event.userId, false, context.receipt)
                : Effect.void,
    },
})

// Running this file starts the bot, while importing it from a test does not.
// A failure that stops the bot, such as a rejected token, is logged and sets a failing exit code
if (import.meta.main)
    await Effect.runPromiseExit(runBot({ token: process.env.FLUXER_BOT_TOKEN, processSignals: true, ...bot }))
