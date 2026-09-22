// @ts-check

import { commands, createClient, MessageOperationError } from "@neontechspace/fluxerly"

/** @param {import("@neontechspace/fluxerly").Message} message */
function messageContent(message) {
    return message.content
}

/**
 * Narrow the default API's creation Result before using either branch
 *
 * @param {string} token
 */
export function createCheckedClient(token) {
    const created = createClient({ token })
    if (created.isErr()) {
        /** @type {import("@neontechspace/fluxerly").ConfigurationError} */
        const error = created.error
        // @ts-expect-error The failed creation branch contains an error, not a Client
        error.state
        return { error }
    }

    /** @type {import("@neontechspace/fluxerly").Client} */
    const client = created.value
    return { client }
}

/**
 * Preserve inferred message and cancellation types in a checked JavaScript callback
 *
 * @param {import("@neontechspace/fluxerly").Client} client
 */
export function observeMessages(client) {
    return client.on("messageCreate", async (message, signal) => {
        /** @type {string} */
        const content = message.content
        /** @type {import("@neontechspace/fluxerly").OperationSignal} */
        const operationSignal = signal
        const replied = await client.messages.reply(message, { content: `Received: ${content}` }, { signal })
        if (replied.isErr()) throw replied.error

        // @ts-expect-error Received messages are immutable snapshots
        message.content = "changed"
        // @ts-expect-error The default OperationSignal intentionally omits DOM-only signal fields
        operationSignal.reason
    })
}

/** Infer converted command values from the argument schema in ordinary JavaScript */
export function typedCommand() {
    const created = commands.create({ prefix: "!" })
    if (created.isErr()) return created

    return created.value.registerMany({
        repeat: {
            arguments: {
                count: { type: "integer" },
                mode: { type: "choice", choices: ["quiet", "loud"] },
                note: { type: "text", optional: true },
            },
            execute: async ({ values, args, reply }) => {
                /** @type {number} */
                const count = values.count
                /** @type {"quiet" | "loud"} */
                const mode = values.mode
                /** @type {string | undefined} */
                const note = values.note
                /** @type {readonly string[]} */
                const raw = args

                /** @type {string} */
                // @ts-expect-error Integer conversion produces a number
                const wrongCount = values.count
                /** @type {string} */
                // @ts-expect-error Optional trailing command values may be undefined
                const requiredNote = values.note
                // @ts-expect-error Undeclared command arguments are not exposed
                values.missing
                // @ts-expect-error Parsed command arguments are immutable
                args.push("later")
                void [count, mode, note, raw, wrongCount, requiredNote]
                const sent = await reply({ content: String(count) })
                if (sent.isErr()) throw sent.error
                messageContent(sent.value)
            },
        },
        echo: {
            arguments: { text: { type: "text" } },
            execute: ({ values }) => {
                /** @type {string} */
                const text = values.text
                // @ts-expect-error Batch entries do not share another entry's argument schema
                values.count
                void text
            },
        },
    })
}

/**
 * Narrow expected operation failures and retain frozen successful snapshots
 *
 * @param {import("@neontechspace/fluxerly").Client} client
 * @param {import("@neontechspace/fluxerly").OperationSignal} signal
 */
export async function fetchCheckedMessage(client, signal) {
    const result = await client.messages.fetch({ channelId: "20", id: "10" }, { timeoutMs: 2_000, signal })
    if (result.isErr()) {
        /** @type {import("@neontechspace/fluxerly").MessageOperationFailure | import("@neontechspace/fluxerly").CancelledError | import("@neontechspace/fluxerly").ConfigurationError} */
        const expected = result.error
        if (expected instanceof MessageOperationError) {
            /** @type {"notDispatched" | "rejected" | "unknown"} */
            const outcome = expected.outcome
            /** @type {import("@neontechspace/fluxerly").InputValidationDetail | null} */
            const inputValidation = expected.inputValidation
            void [outcome, inputValidation]
        }
        // @ts-expect-error Expected operation failures are not received messages
        messageContent(expected)
        return expected
    }

    /** @type {import("@neontechspace/fluxerly").Message} */
    const snapshot = result.value
    // @ts-expect-error Received message fields are readonly
    snapshot.content = "changed"
    // @ts-expect-error Received attachment collections are readonly
    snapshot.attachments.push({})
    return snapshot
}

/**
 * Keep rejected input shapes observable to the JavaScript checker
 *
 * @param {import("@neontechspace/fluxerly").Client} client
 */
export function rejectedInputs(client) {
    // @ts-expect-error Client creation requires a credential
    createClient({})
    // @ts-expect-error Credentials must be strings
    createClient({ token: 42 })
    // @ts-expect-error Message references require string IDs
    client.messages.fetch({ channelId: 20, id: "10" })
    // @ts-expect-error Event names are a checked public union
    client.on("messageCreated", () => {})
    // @ts-expect-error Operation timeouts are numeric milliseconds
    client.messages.fetch({ channelId: "20", id: "10" }, { timeoutMs: "soon" })
}
