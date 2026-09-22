import { commands, type Client, type MessageCore, type SelectedMessage } from "../src/index.js"
import { commands as nativeCommands, type Client as NativeClient } from "../src/effect.js"
import { Context, Effect } from "effect"

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
            onUnmatched: ({ message, client: attached, reply }) => {
                const selected: Client<EmbedsOnly> = attached
                void selected
                void message.embeds
                // @ts-expect-error Unmatched feedback does not receive a full Message
                message.attachments
                void reply({ content: "unknown" }).then((result) => {
                    if (result.isOk()) void result.value.embeds
                })
            },
        })
        ._unsafeUnwrap()
    const grouped = root.registerGroup({ name: "tools" })._unsafeUnwrap()
    const batch = grouped
        .registerMany(
            {
                sum: {
                    arguments: { count: { type: "integer" } },
                    execute: async ({ values, reply }) => {
                        const count: number = values.count
                        // @ts-expect-error Batch entries retain their own converted value types
                        const invalid: string = values.count
                        void invalid
                        const result = await reply({ content: String(count) })
                        if (result.isErr()) throw result.error
                        void result.value.embeds
                    },
                },
                echo: {
                    arguments: { text: { type: "text" } },
                    execute: ({ values }) => {
                        const text: string = values.text
                        // @ts-expect-error This entry does not inherit the preceding integer schema
                        values.count
                        void text
                    },
                },
            },
            { group: ["tools"] },
        )
        ._unsafeUnwrap()
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
    return { attached, batch: batch.attach(client), core: core.attach(coreClient) }
}

/** Native selected routers retain the same field contract without changing earlier E/R/schema generic positions */
export function nativeSelectedCommandTypes(client: NativeClient<EmbedsOnly>, coreClient: NativeClient<MessageCore>) {
    const First = Context.Service<{ readonly first: true }>("batch-first")
    const Second = Context.Service<{ readonly second: true }>("batch-second")
    const Guard = Context.Service<{ readonly guard: true }>("batch-guard")
    const Rejection = Context.Service<{ readonly rejection: true }>("batch-rejection")
    const Cooldown = Context.Service<{ readonly cooldown: true }>("batch-cooldown")
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
            onUnmatched: ({ message, reply }) =>
                Effect.sync(() => {
                    void message.embeds
                    // @ts-expect-error Native unmatched feedback is selected, not full
                    message.attachments
                    void reply({ content: "unknown" })
                }),
        })
        const grouped = yield* root.registerGroup({ name: "tools" })
        const batch = yield* grouped.registerMany(
            {
                sum: {
                    arguments: { count: { type: "integer" } },
                    execute: ({ values, reply }) => {
                        const count: number = values.count
                        // @ts-expect-error Native batch entries retain their own converted value types
                        const invalid: string = values.count
                        void invalid
                        return Effect.service(First).pipe(
                            Effect.andThen(reply({ content: String(count) })),
                            Effect.asVoid,
                        )
                    },
                },
                echo: {
                    arguments: { text: { type: "text" } },
                    execute: ({ values }) => {
                        const text: string = values.text
                        // @ts-expect-error This entry does not inherit the preceding integer schema
                        values.count
                        void text
                        return Effect.service(Second).pipe(Effect.asVoid)
                    },
                },
                policy: {
                    arguments: {},
                    guard: () => Effect.service(Guard).pipe(Effect.as(true)),
                    onReject: () => Effect.service(Rejection).pipe(Effect.asVoid),
                    cooldown: {
                        durationMs: 1_000,
                        store: {
                            claim: () =>
                                Effect.service(Cooldown).pipe(
                                    Effect.as({ _tag: "CooldownAcquired" as const, retryAtMs: 1 }),
                                ),
                        },
                    },
                    execute: () => Effect.void,
                },
            },
            { group: ["tools"] },
        )
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
        const batchAttachment = batch.attach(client)
        type InferredServices = typeof batchAttachment extends Effect.Effect<unknown, unknown, infer R> ? R : never
        type ExpectedServices =
            | Context.Service.Identifier<typeof First>
            | Context.Service.Identifier<typeof Second>
            | Context.Service.Identifier<typeof Guard>
            | Context.Service.Identifier<typeof Rejection>
            | Context.Service.Identifier<typeof Cooldown>
            | import("effect").Scope.Scope
        const exactServiceCoverage: [
            Exclude<InferredServices, ExpectedServices>,
            Exclude<ExpectedServices, InferredServices>,
        ] extends [never, never]
            ? true
            : false = true
        void exactServiceCoverage
        return { selected: registered.attach(client), batch: batchAttachment, core: core.attach(coreClient) }
    })
}
