import { defaultCommands } from "#sdk/default-commands"

/**
 * Route prefixed messages such as !ping to registered handlers.
 * The simplest route is runBot's commands option. For an existing client, create a router, register commands and
 * attach it
 *
 * @remarks
 * Nothing listens until attach, which uses one bounded messageCreate subscription and does not connect the client.
 * Command handlers send replies and decide access, with optional guards, cooldowns and middleware.
 * The router does not retry failed handlers, and a handler that returns an Err result is reported like a throw
 *
 * Optional groups organize names and help text, but a protected command still needs its own guard.
 * A guard decides whether a matched command may run, and the built-in `guards` cover common checks
 *
 * Optional argument schemas convert raw args into frozen typed values after the guards.
 * Conversion rejection gives rejection feedback without consuming a cooldown.
 * The original args remain available
 *
 * Help pages are strings the application can send.
 * Hiding a command in help is not an access check
 *
 * Creation, registration and help throw ConfigurationError for misuse, so a misconfigured router fails at startup
 *
 * @example
 * ```ts
 * import { commands, type Client } from "@neontechspace/fluxerly"
 * export function commandGroupExample(client: Client) {
 *     return commands
 *         .create({ prefix: "!" })
 *         .registerGroup({ name: "tools", aliases: ["t"] })
 *         .register({ name: "ping", execute: ({ reply }) => reply("Pong") }, { group: ["tools"] })
 *         .attach(client)
 * }
 * ```
 *
 * @example
 * ```ts
 * import { commands, type Client } from "@neontechspace/fluxerly"
 *
 * export function installPing(client: Client) {
 *     return commands
 *         .create({
 *             prefix: "!",
 *             parse: commands.parseQuoted,
 *             onUnmatched: ({ reply }, unmatched) => {
 *                 if (unmatched._tag !== "CommandUnknownName") return undefined
 *                 const hint = unmatched.suggestion === undefined ? "" : `. Closest known command: ${unmatched.suggestion}`
 *                 return reply(`Unknown command: ${unmatched.name}${hint}`)
 *             },
 *         })
 *         .register({ name: "ping", execute: ({ reply }) => reply("Pong") })
 *         .attach(client)
 * }
 * ```
 *
 * @example
 * ```ts
 * import { commands, type Client } from "@neontechspace/fluxerly"
 *
 * export function typedCommandExample(client: Client) {
 *     return commands
 *         .create({ prefix: "!", parse: commands.parseQuoted, onReject: "reply" })
 *         .register({
 *             name: "repeat",
 *             arguments: {
 *                 mode: { type: "choice", choices: ["fast", "slow"] },
 *                 count: { type: "integer", min: 1, max: 5, default: 1 },
 *                 note: { type: "text", optional: true, rest: true },
 *             },
 *             cooldown: { durationMs: 10_000, per: "user" },
 *             execute: ({ reply, values }) => reply(`${values.count} / ${values.mode} / ${values.note ?? "No note"}`),
 *         })
 *         .attach(client)
 * }
 * ```
 *
 * @example
 * ```ts
 * import { orThrow, type Client, type DefaultPrefixCommandRouter } from "@neontechspace/fluxerly"
 *
 * export async function commandHelpExample(client: Client, router: DefaultPrefixCommandRouter, channelId: string) {
 *     const pages = router.help({ prefix: "!", maxLength: 1_000, include: (command) => command.name !== "admin" })
 *     // Visibility is not authorization. Each command still needs its own policy
 *     for (const content of pages) orThrow(await client.messages.send(channelId, { content, allowedMentions: {} }))
 *     // Earlier pages remain sent if a later send fails. This example never retries
 * }
 * ```
 *
 * @category Commands
 */
export const commands = defaultCommands
