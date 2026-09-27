import type * as Default from "../../../../src/index.js"
import type * as Native from "../../../../src/effect.js"
import type { AssertNever, PairFailures } from "./compare.js"

// Public-client-contract.js checks these keys against its paired surface list
export type Paired = {
    Client: [Default.Client, Native.Client]
    WebhookClient: [Default.WebhookClient, Native.WebhookClient]
    OAuthClient: [Default.OAuthClient, Native.OAuthClient]
    Subscription: [Default.Subscription, Native.Subscription]
    Collector: [Default.Collector, Native.Collector]
    ReactionCollector: [Default.ReactionCollector, Native.ReactionCollector]
    Instance: [Default.Instance, Native.Instance]
    Discovery: [Default.Discovery, Native.Discovery]
    Presence: [Default.Presence, Native.Presence]
    CurrentBotApplication: [Default.CurrentBotApplication, Native.CurrentBotApplication]
    Users: [Default.Users, Native.Users]
    DirectMessages: [Default.DirectMessages, Native.DirectMessages]
    Webhooks: [Default.Webhooks, Native.Webhooks]
    Roles: [Default.Roles, Native.Roles]
    PermissionHelpers: [Default.PermissionHelpers, Native.PermissionHelpers]
    Guilds: [Default.Guilds, Native.Guilds]
    Invites: [Default.Invites, Native.Invites]
    AuditLogs: [Default.AuditLogs, Native.AuditLogs]
    Emojis: [Default.Emojis, Native.Emojis]
    Stickers: [Default.Stickers, Native.Stickers]
    Channels: [Default.Channels, Native.Channels]
    Members: [Default.Members, Native.Members]
    Attachments: [Default.Attachments, Native.Attachments]
    Messages: [Default.Messages, Native.Messages]
    ClientCache: [Default.ClientCache, Native.ClientCache]
    RestRequests: [Default.RestRequests, Native.RestRequests]
    GatewayCommands: [Default.GatewayCommands, Native.GatewayCommands]
    format: [typeof Default.format, typeof Native.format]
    snowflakes: [typeof Default.snowflakes, typeof Native.snowflakes]
    display: [typeof Default.display, typeof Native.display]
    permissionBits: [typeof Default.permissionBits, typeof Native.permissionBits]
    colors: [typeof Default.colors, typeof Native.colors]
    text: [typeof Default.text, typeof Native.text]
    links: [typeof Default.links, typeof Native.links]
    assets: [typeof Default.assets, typeof Native.assets]
}

// These members have deliberately different callback, cancellation or lazy-stream contracts
type Exceptions = {
    Client: "observeState" | "on" | "subscribe" | "use"
    ClientCache: "onChange"
    Collector: "close"
    Messages: "collect" | "collectReactions" | "keepTyping"
    ReactionCollector: "close"
    Subscription: "close"
}

// Cache lookups and enumeration return the value directly in the default API and a never-failing Effect in the native API
type Lookups = {
    Channels: "get"
    ClientCache: "entries"
    DirectMessages: "get"
    Emojis: "get"
    Guilds: "get"
    Members: "get"
    Messages: "get"
    Roles: "get"
    Stickers: "get"
    Users: "get"
}

// Default operations report cancellation and invalid signals as failures, while native programs use interruption
type IgnoredFailures = Default.CancelledError | Default.ConfigurationError

export type PublicClientParity = AssertNever<PairFailures<Paired, Exceptions, Lookups, IgnoredFailures>>
