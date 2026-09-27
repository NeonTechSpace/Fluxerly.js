import { nativeCommands } from "#sdk/native-commands"

/**
 * Define text commands, parse their arguments and attach them to an existing client.
 * The simplest route is runBot's commands option. Creation, registration and help return their result directly and
 * throw ConfigurationError for misuse, so a misconfigured router fails at startup.
 * Commands listen through one bounded messageCreate subscription in the caller's Scope when attach executes.
 * The router does not connect the client or create a separate SDK runtime.
 * Guards, cooldown keys, unmatched feedback and handler Effects remain application-owned, with built-in `guards` for common checks.
 * The router does not retry failures, and it replies on its own only when `onReject: "reply"` is selected.
 * Groups optionally organize command paths and help pages.
 * Flat commands remain independent, and each protected command still needs its own guard
 *
 * @example
 * ```ts
 * import { commands, type Client } from "@neontechspace/fluxerly/effect"
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
 * import { Effect } from "effect"
 * import { commands, type Client } from "@neontechspace/fluxerly/effect"
 *
 * export const installPing = (client: Client) =>
 *     commands
 *         .create({
 *             prefix: "!",
 *             parse: commands.parseQuoted,
 *             onUnmatched: ({ reply }, unmatched) => {
 *                 if (unmatched._tag !== "CommandUnknownName") return Effect.void
 *                 const hint = unmatched.suggestion === undefined ? "" : `. Closest known command: ${unmatched.suggestion}`
 *                 return reply(`Unknown command: ${unmatched.name}${hint}`)
 *             },
 *         })
 *         .register({ name: "ping", execute: ({ reply }) => reply("Pong") })
 *         .attach(client)
 * ```
 * Argument schemas are optional definitions of the values a command expects.
 * Guards see raw input first. Conversion failures give rejection feedback without consuming a cooldown.
 * The execute callback receives inferred frozen values alongside unchanged args
 *
 * @example
 * ```ts
 * import { commands, type Client } from "@neontechspace/fluxerly/effect"
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
 * import { Effect } from "effect"
 * import { type Client, type NativePrefixCommandRouter } from "@neontechspace/fluxerly/effect"
 *
 * export function commandHelpExample(client: Client, router: NativePrefixCommandRouter, channelId: string) {
 *     const pages = router.help({ prefix: "!", maxLength: 1_000, include: (command) => command.name !== "admin" })
 *     // Visibility is not authorization. Each command still needs its own policy
 *     return Effect.forEach(pages, (content) => client.messages.send(channelId, { content, allowedMentions: {} }), {
 *         discard: true,
 *     })
 *     // Earlier pages remain sent if a later send fails or is interrupted. No retries occur
 * }
 * ```
 *
 * @category Commands
 */
export const commands = nativeCommands
