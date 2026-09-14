import { commands, type Client, type MessageCore, type SelectedMessage } from "../src/index.js"
import { commands as nativeCommands, type Client as NativeClient } from "../src/effect.js"
import { Effect } from "effect"

type EmbedsOnly = SelectedMessage<readonly ["embeds"]>

/** Selected routers keep their message fields through parsing, policy, execution and attachment */
export function defaultSelectedCommandTypes(client: Client<EmbedsOnly>, coreClient: Client<MessageCore>) {
    const root = commands
        .create<EmbedsOnly>({
            prefix: (message) => {
                const embeds = message.embeds.length
                // @ts-expect-error Unselected message fields are not available to prefix resolvers
                message.attachments
                return embeds > 0 ? "!" : "?"
            },
            parse: (input) => {
                const embeds = input.message.embeds.length
                void embeds
                // @ts-expect-error Unselected message fields are not available to custom parsers
                input.message.attachments
                return commands.parseQuoted(input)
            },
            onUnmatched: ({ message, client: attached }) => {
                const selected: Client<EmbedsOnly> = attached
                void selected
                void message.embeds
                // @ts-expect-error Unmatched feedback does not receive a full Message
                message.attachments
            },
        })
        ._unsafeUnwrap()
    const grouped = root.registerGroup({ name: "tools" })._unsafeUnwrap()
    const registered = grouped
        .register(
            {
                name: "inspect",
                arguments: { count: { type: "integer" } },
                guard: ({ message }) => {
                    // @ts-expect-error Guards share the attached client's selected projection
                    message.attachments
                    return message.embeds.length > 0
                },
                onReject: ({ message }) => {
                    // @ts-expect-error Rejection feedback shares the selected projection
                    message.attachments
                },
                cooldown: {
                    store: commands.memoryCooldowns()._unsafeUnwrap(),
                    durationMs: 1_000,
                    key: ({ message, values }) => {
                        const count: number = values.count
                        // @ts-expect-error Cooldown keys cannot observe unselected fields
                        message.attachments
                        return `${message.embeds.length}:${count}`
                    },
                },
                execute: async ({ message, values, client: attached }) => {
                    const count: number = values.count
                    const selected: Client<EmbedsOnly> = attached
                    void selected
                    void count
                    // @ts-expect-error Execution context does not widen the selected message
                    message.attachments
                    const fetched = await attached.messages.fetch(message)
                    if (fetched.isOk()) {
                        void fetched.value.embeds
                        // @ts-expect-error Context client operations keep the same selected fields
                        fetched.value.attachments
                    }
                },
            },
            { group: ["tools"] },
        )
        ._unsafeUnwrap()
    const attached = registered.attach(client)
    const full = commands.create({ prefix: "!" })._unsafeUnwrap()
    // @ts-expect-error A router promising full Message cannot attach to a selected client
    full.attach(client)
    // @ts-expect-error A router promising selected embeds cannot attach to a core-only client
    registered.attach(coreClient)
    const core = commands.create<MessageCore>({ prefix: "!" })._unsafeUnwrap()
    return { attached, core: core.attach(coreClient) }
}

/** Native selected routers retain the same field contract without changing earlier E/R/schema generic positions */
export function nativeSelectedCommandTypes(client: NativeClient<EmbedsOnly>, coreClient: NativeClient<MessageCore>) {
    return Effect.gen(function* () {
        const root = yield* nativeCommands.create<never, never, EmbedsOnly>({
            prefix: (message) => {
                // @ts-expect-error Native prefix resolvers cannot observe unselected fields
                message.attachments
                return message.embeds.length > 0 ? "!" : "?"
            },
            parse: (input) => {
                // @ts-expect-error Native parsers cannot observe unselected fields
                input.message.attachments
                return nativeCommands.parseQuoted(input)
            },
            onUnmatched: ({ message }) =>
                Effect.sync(() => {
                    void message.embeds
                    // @ts-expect-error Native unmatched feedback is selected, not full
                    message.attachments
                }),
        })
        const grouped = yield* root.registerGroup({ name: "tools" })
        const registered = yield* grouped.register(
            {
                name: "inspect",
                arguments: { count: { type: "integer" } },
                guard: ({ message }) =>
                    Effect.sync(() => {
                        // @ts-expect-error Native guards retain the selected message
                        message.attachments
                        return message.embeds.length > 0
                    }),
                onReject: ({ message }) =>
                    Effect.sync(() => {
                        // @ts-expect-error Native rejection context remains selected
                        message.attachments
                    }),
                cooldown: {
                    store: yield* nativeCommands.memoryCooldowns(),
                    durationMs: 1_000,
                    key: ({ message, values }) => {
                        const count: number = values.count
                        // @ts-expect-error Native cooldown callbacks cannot observe unselected fields
                        message.attachments
                        return `${message.embeds.length}:${count}`
                    },
                },
                execute: ({ message, values, client: attached }) =>
                    Effect.gen(function* () {
                        const count: number = values.count
                        const selected: NativeClient<EmbedsOnly> = attached
                        void selected
                        void count
                        // @ts-expect-error Native execution context remains selected
                        message.attachments
                        const fetched = yield* attached.messages.fetch(message).pipe(Effect.orDie)
                        void fetched.embeds
                        // @ts-expect-error Native context client operations retain selected fields
                        fetched.attachments
                    }),
            },
            { group: ["tools"] },
        )
        const full = yield* nativeCommands.create({ prefix: "!" })
        // @ts-expect-error A full native router cannot attach to a selected client
        full.attach(client)
        // @ts-expect-error A native router requiring embeds cannot attach to a core-only client
        registered.attach(coreClient)
        const core = yield* nativeCommands.create<never, never, MessageCore>({ prefix: "!" })
        return { selected: registered.attach(client), core: core.attach(coreClient) }
    })
}
