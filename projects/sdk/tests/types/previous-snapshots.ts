// Compile-only check, run by the test typecheck: EventContext.previous is typed for the handler's event and message
// selection in both APIs, and a helper that takes a plain EventContext accepts the context of any handler
import { Effect } from "effect"
import type {
    BotEventContext,
    Client,
    EventContext,
    GuildChannel,
    GuildMember,
    GuildRole,
    Message,
    PreviousSnapshot,
    SelectedMessage,
} from "../../src/index.js"
import type { BotEventContext as NativeBotEventContext, Client as NativeClient } from "../../src/effect.js"

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T

type Selected = SelectedMessage<readonly ["content"]>

/** A helper written against the default context, as application code often is */
const receiptOf = (context: EventContext) => context.receipt

export function defaultHandlers(client: Client, selected: Client<Selected>) {
    client.on("messageUpdate", (_message, _signal, context) => {
        const previous: Assert<Equal<typeof context.previous, Message | undefined>> = true
        return [previous, receiptOf(context)]
    })
    client.on("typingStart", (_event, _signal, context) => {
        const previous: Assert<Equal<typeof context.previous, undefined>> = true
        return previous
    })
    selected.on("messageDelete", (_deletion, _signal, context) => {
        const previous: Assert<Equal<typeof context.previous, Selected | undefined>> = true
        return [previous, receiptOf(context)]
    })
    client.use((invocation, next) => {
        if (invocation.event === "guildRoleUpdate") {
            const previous: Assert<Equal<typeof invocation.context.previous, GuildRole | undefined>> = true
            void previous
        }
        return next()
    })
    const receipt: Assert<Equal<typeof client.lastReceipt, number>> = true
    return receipt
}

export function nativeHandlers(client: NativeClient) {
    const member = client.on("guildMemberUpdate", (_member, context) =>
        Effect.sync(() => {
            const previous: Assert<Equal<typeof context.previous, GuildMember | undefined>> = true
            return [previous, receiptOf(context)]
        }),
    )
    const receipt: Assert<Equal<typeof client.lastReceipt, number>> = true
    return [member, receipt]
}

export const botContexts: [
    Assert<Equal<BotEventContext<"guildChannelDelete">["context"]["previous"], GuildChannel | undefined>>,
    Assert<Equal<NativeBotEventContext<"guildUpdate">["context"]["previous"], PreviousSnapshot<"guildUpdate">>>,
    Assert<Equal<PreviousSnapshot<"guildBanAdd">, undefined>>,
] = [true, true, true]
