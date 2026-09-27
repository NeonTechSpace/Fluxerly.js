// oxlint-disable no-unused-expressions -- compile-only type assertions, checked by tsconfig.test.json and never run
import {
    commands,
    guards,
    runBot,
    type Client,
    type MemberReference,
    type MessageCore,
    type SelectedMessage,
} from "../../../src/index.js"
import {
    commands as nativeCommands,
    guards as nativeGuards,
    runBot as runNativeBot,
    type Client as NativeClient,
} from "../../../src/effect.js"
import { Context, Effect } from "effect"

type EmbedsOnly = SelectedMessage<readonly ["embeds"]>

/** Selected routers keep their message fields through parsing, policy, execution and attachment */
export function defaultSelectedCommandTypes(client: Client<EmbedsOnly>, coreClient: Client<MessageCore>) {
    const root = commands.create<EmbedsOnly>({
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
    const grouped = root.registerGroup({ name: "tools" })
    const batch = grouped.registerMany(
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
    const registered = grouped.register(
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
                store: commands.memoryCooldowns(),
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
    const attached = registered.attach(client)
    const full = commands.create({ prefix: "!" })
    // @ts-expect-error A router promising full Message cannot attach to a selected client
    full.attach(client)
    // @ts-expect-error A router promising selected embeds cannot attach to a core-only client
    registered.attach(coreClient)
    const core = commands.create<MessageCore>({ prefix: "!" })
    return { attached, batch: batch.attach(client), core: core.attach(coreClient) }
}

/** Native selected routers retain the same field contract without changing earlier E/R/schema generic positions */
export function nativeSelectedCommandTypes(client: NativeClient<EmbedsOnly>, coreClient: NativeClient<MessageCore>) {
    const First = Context.Service<{ readonly first: true }>("batch-first")
    const Second = Context.Service<{ readonly second: true }>("batch-second")
    const Guard = Context.Service<{ readonly guard: true }>("batch-guard")
    const Rejection = Context.Service<{ readonly rejection: true }>("batch-rejection")
    const Cooldown = Context.Service<{ readonly cooldown: true }>("batch-cooldown")
    // Native creation and registration are synchronous, and only attachment is an Effect
    const root = nativeCommands.create<never, never, EmbedsOnly>({
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
    const grouped = root.registerGroup({ name: "tools" })
    const batch = grouped.registerMany(
        {
            sum: {
                arguments: { count: { type: "integer" } },
                execute: ({ values, reply }) => {
                    const count: number = values.count
                    // @ts-expect-error Native batch entries retain their own converted value types
                    const invalid: string = values.count
                    void invalid
                    return Effect.service(First).pipe(Effect.andThen(reply({ content: String(count) })), Effect.asVoid)
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
    const registered = grouped.register(
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
                store: nativeCommands.memoryCooldowns(),
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
    const full = nativeCommands.create({ prefix: "!" })
    // @ts-expect-error A full native router cannot attach to a selected client
    full.attach(client)
    // @ts-expect-error A native router requiring embeds cannot attach to a core-only client
    registered.attach(coreClient)
    const core = nativeCommands.create<never, never, MessageCore>({ prefix: "!" })
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
}

/** Argument defaults remove undefined from values, and guards, middleware and replies accept their documented shapes */
export function defaultArgumentAndPolicyTypes() {
    const router = commands
        .create({
            prefix: "!",
            onReject: "reply",
            use: [
                async (context, next) => {
                    const name: string = context.name
                    void name
                    await next()
                },
            ],
        })
        .register({
            name: "roll",
            arguments: {
                sides: { type: "integer", min: 2, default: 6 },
                bonus: { type: "number", optional: true },
                wait: { type: "duration", default: 1_000 },
                target: { type: "member", optional: true },
                color: {
                    type: "custom",
                    parse: (token: string) => (token === "red" ? (0xff0000 as const) : undefined),
                },
            },
            guard: [guards.guildOnly(), guards.requirePermissions(["SendMessages"]), () => ({ deny: "Not today" })],
            onReject: "reply",
            execute: ({ values, reply }) => {
                const sides: number = values.sides
                const wait: number = values.wait
                const target: MemberReference | undefined = values.target
                const color: 0xff0000 = values.color
                // @ts-expect-error An optional argument without a default can be undefined
                const bonus: number = values.bonus
                void [sides, wait, target, color, bonus]
                return reply("Rolled")
            },
        })
    // @ts-expect-error A guard verdict is a boolean or { deny }
    router.register({ name: "bad", guard: () => "yes", execute: () => undefined })
    return runBot({
        token: undefined,
        commands: {
            prefix: "!",
            mentionPrefix: true,
            commands: {
                ping: { execute: ({ reply }) => reply("Pong") },
                roll: {
                    arguments: { sides: { type: "integer", default: 6 } },
                    execute: ({ values }) => {
                        const sides: number = values.sides
                        void sides
                    },
                },
            },
        },
    })
}

/** Native guards, middleware and replies return Effects with the same argument value types */
export function nativeArgumentAndPolicyTypes() {
    const router = nativeCommands.create({ prefix: "!", onReject: "reply", use: [(_context, next) => next] }).register({
        name: "roll",
        arguments: { sides: { type: "integer", default: 6 }, target: { type: "member" } },
        guard: [nativeGuards.guildOnly(), () => Effect.succeed({ deny: "Not today" })],
        execute: ({ values, reply }) => {
            const sides: number = values.sides
            const target: MemberReference = values.target
            void [sides, target]
            return reply("Rolled")
        },
    })
    return {
        router,
        bot: runNativeBot({
            token: undefined,
            commands: { prefix: "!", commands: { ping: { execute: ({ reply }) => reply("Pong") } } },
        }),
    }
}
