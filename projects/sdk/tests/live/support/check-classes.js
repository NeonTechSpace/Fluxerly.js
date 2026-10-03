// The lock class and authorization level of every live harness scenario, declared in one place.
// A scenario is a harness file plus its arguments after the `default` or `effect` mode. The sandbox lock refuses an
// undeclared scenario, and the parallel runner uses the same declarations.
//
// Lock classes:
// - `read-only`: No writes to the sandbox
// - `test-owned`: Creates and touches only its own temporary resources, and reads nothing other checks change
// - `shared-state`: Changes state other checks can observe, such as server settings, the bot's roles, profile or
//   presence, other members or guild-wide positions, or asserts over guild-wide state that concurrent test-owned
//   resources or rate-limit use would change
// Read-only and test-owned scenarios share the sandbox lock. A shared-state scenario holds it exclusively.
//
// Levels: `sdk-work` scenarios may run during authorized SDK work. `manual` scenarios need per-run authorization or
// a present person, and the runner refuses them

const sdkWork = (lockClass) => Object.freeze({ lockClass, level: "sdk-work" })
const manual = (lockClass) => Object.freeze({ lockClass, level: "manual" })

/** Declarations by harness file, then by scenario arguments in sorted order joined with spaces */
export const checkClasses = Object.freeze({
    "administration.js": { "": sdkWork("shared-state") },
    "announcements.js": { "": sdkWork("test-owned") },
    "bot-runner.js": { "": sdkWork("read-only") },
    "command-conveniences.js": {
        waits: sdkWork("test-owned"),
        arguments: sdkWork("test-owned"),
        help: sdkWork("test-owned"),
        groups: sdkWork("test-owned"),
        fields: sdkWork("test-owned"),
    },
    "consumer-features.js": { "": sdkWork("test-owned") },
    // Replaces and asserts the bot's whole role list
    "consumer-operations.js": { "": sdkWork("shared-state") },
    "discovery.js": { "": sdkWork("read-only"), "--mutate": manual("shared-state") },
    // Emoji and sticker updates are checked by owned IDs. Source-guild reads change only under shared-state checks
    "expressions.js": { "": sdkWork("test-owned") },
    "guild-events.js": { "": sdkWork("read-only"), "--voice": sdkWork("read-only") },
    "guild-feature-toggles.js": { "": sdkWork("shared-state") },
    "guild-lifecycle.js": {
        "": sdkWork("read-only"),
        "--leave": manual("shared-state"),
        "--leave --lose-response": manual("shared-state"),
    },
    "invites.js": { "": sdkWork("test-owned") },
    // Compares full member and bot-role snapshots, which change only under shared-state checks
    "member-chunks.js": { "": sdkWork("read-only") },
    // Compares guild-wide role lists and searches the first visible channel, which may be another check's temporary one
    "member-search.js": { "": sdkWork("shared-state") },
    "members.js": { "": manual("shared-state") },
    "messages.js": {
        "": sdkWork("test-owned"),
        "--attachment-sources": sdkWork("test-owned"),
        "--attachments": sdkWork("test-owned"),
        "--attachments-small": sdkWork("test-owned"),
        "--batch-delete": sdkWork("test-owned"),
        "--cache": sdkWork("test-owned"),
        // Compares the whole guild channel list, which other checks' temporary channels change
        "--channels": sdkWork("shared-state"),
        "--cleanup": sdkWork("test-owned"),
        "--collectors": sdkWork("test-owned"),
        "--embeds": sdkWork("test-owned"),
        "--events": sdkWork("test-owned"),
        // Assigns roles to the bot, reorders guild roles and compares whole role lists and positions
        "--guilds": sdkWork("shared-state"),
        "--history": sdkWork("test-owned"),
        "--manage": sdkWork("test-owned"),
        "--moderation": manual("shared-state"),
        "--nonce-only": sdkWork("test-owned"),
        "--optional-tools": sdkWork("test-owned"),
        "--pagination": sdkWork("test-owned"),
        "--pins": sdkWork("test-owned"),
        "--reactions": sdkWork("test-owned"),
        "--recover": sdkWork("test-owned"),
        "--search": sdkWork("test-owned"),
        "--typing": sdkWork("test-owned"),
    },
    "oauth.js": { "": manual("shared-state"), "--no-consent": sdkWork("read-only") },
    "own-history.js": { "": sdkWork("test-owned"), "--guild": manual("shared-state") },
    "presence.js": { "": manual("shared-state") },
    "recovery-window.js": { "": sdkWork("read-only"), "--session-restart": sdkWork("read-only") },
    "role-display-reset.js": { "": manual("shared-state") },
    "sandbox.js": { "": sdkWork("read-only") },
    "sdk.js": {
        "": sdkWork("read-only"),
        "--application": sdkWork("read-only"),
        "--cancel-recovery": sdkWork("read-only"),
        "--diagnostics": sdkWork("read-only"),
        "--instance": sdkWork("read-only"),
        "--quality": manual("read-only"),
        // Exact request counts and timing assume that no other run spends the bot's rate limits
        "--rate-limits": sdkWork("shared-state"),
    },
    "sharding.js": { "": sdkWork("read-only") },
    "supervisor.js": { "": sdkWork("read-only") },
    "text-validation.js": { "": sdkWork("test-owned") },
    "typing-interactive.js": { "": manual("shared-state") },
    "users.js": {
        "": manual("shared-state"),
        "--latest-only": manual("shared-state"),
        "--without-group": manual("shared-state"),
    },
    "vanity-url.js": { "": sdkWork("read-only"), "--mutate": manual("shared-state") },
    "voice-controls.js": {
        "": manual("shared-state"),
        "--flags-only": manual("shared-state"),
        "--no-move": manual("shared-state"),
    },
    "webhooks.js": { "": sdkWork("test-owned") },
})

const classOrder = ["read-only", "test-owned", "shared-state"]

/** The most restrictive of several lock classes */
export function strongestClass(classes) {
    return classOrder[Math.max(...classes.map((lockClass) => classOrder.indexOf(lockClass)))]
}

/**
 * The declaration for a harness file and its process arguments, with `key` naming the scenario's shared lock, or
 * undefined when the scenario is undeclared. A copied harness keeps its declaration under the `.mjs` extension
 */
export function declaredCheck(harness, args) {
    const file = harness.replace(/\.mjs$/, ".js")
    const scenarios = Object.hasOwn(checkClasses, file) ? checkClasses[file] : undefined
    const rest = args.filter((argument) => argument !== "default" && argument !== "effect").sort()
    const scenario = rest.join(" ")
    if (!scenarios || !Object.hasOwn(scenarios, scenario)) return undefined
    const key = [file.replace(/\.js$/, ""), ...rest.map((argument) => argument.replace(/^--/, ""))].join("-")
    return Object.freeze({ ...scenarios[scenario], key })
}
