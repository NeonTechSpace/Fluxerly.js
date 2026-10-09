/**
 * Namespace-object members exposed by both Client entry points
 *
 * The compiler-backed public client contract checks both Client entry points against this list.
 * The `typeArguments` field records the displayed generic parameter list of a namespace whose Client member is generic
 */
export const clientNamespaces = Object.freeze(
    [
        { type: "Instance", member: "instance" },
        { type: "Discovery", member: "discovery" },
        { type: "Presence", member: "presence" },
        { type: "CurrentBotApplication", member: "application" },
        { type: "Users", member: "users" },
        { type: "DirectMessages", member: "directMessages", typeArguments: "<M>" },
        { type: "Webhooks", member: "webhooks" },
        { type: "Roles", member: "roles" },
        { type: "PermissionHelpers", member: "permissions" },
        { type: "Guilds", member: "guilds" },
        { type: "Invites", member: "invites" },
        { type: "AuditLogs", member: "auditLogs" },
        { type: "Emojis", member: "emojis" },
        { type: "Stickers", member: "stickers" },
        { type: "Channels", member: "channels" },
        { type: "Threads", member: "threads", typeArguments: "<M>" },
        { type: "Members", member: "members" },
        { type: "Attachments", member: "attachments" },
        { type: "Messages", member: "messages", typeArguments: "<M>" },
        { type: "ClientCache", member: "cache", typeArguments: "<M>" },
        { type: "RestRequests", member: "rest" },
        { type: "GatewayCommands", member: "gateway" },
        { type: "ClientLogging", member: "logging" },
    ].map((namespace) =>
        Object.freeze({ ...namespace, signature: `${namespace.type}${namespace.typeArguments ?? ""}` }),
    ),
)
