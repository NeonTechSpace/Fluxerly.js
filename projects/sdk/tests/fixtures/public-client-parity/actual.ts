import type * as Default from "../../../src/index.js"
import type * as Native from "../../../src/effect.js"
import type * as Effect from "effect/Effect"
import type * as Stream from "effect/Stream"
import type { Result, ResultAsync } from "neverthrow"

type DefaultFailure<E> = Exclude<E, Default.CancelledError | Default.ConfigurationError>

type Outcome<K extends "operation" | "stream", A, E> = {
    readonly kind: K
    readonly success: A
    readonly failure: E
}

type NormalizeReturn<T> =
    T extends ResultAsync<infer A, infer E>
        ? Outcome<"operation", A, DefaultFailure<E>>
        : T extends Result<infer A, infer E>
          ? Outcome<"operation", A, DefaultFailure<E>>
          : T extends AsyncIterable<Result<infer A, infer E>>
            ? Outcome<"stream", A, DefaultFailure<E>>
            : T extends Effect.Effect<infer A, infer E, infer _R>
              ? Outcome<"operation", A, E>
              : T extends Stream.Stream<infer A, infer E, infer _R>
                ? Outcome<"stream", A, E>
                : T

type NormalizeParameter<T> = T extends unknown ? ("signal" extends keyof T ? Omit<T, "signal"> : T) : never
type NormalizeParameters<T extends readonly unknown[]> = { [K in keyof T]: NormalizeParameter<T[K]> }
type NormalizeMember<T> = T extends (...args: infer P) => infer R
    ? (...args: NormalizeParameters<P>) => NormalizeReturn<R>
    : T
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

type Paired = {
    Client: [Default.Client, Native.Client]
    WebhookClient: [Default.WebhookClient, Native.WebhookClient]
    OAuthClient: [Default.OAuthClient, Native.OAuthClient]
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
}

// These members have deliberately different callback, cancellation or lazy-stream contracts.
// Generic or named-union inference that loses the original relationship is covered by the compiler-signature guard.
type TypeLevelExceptions = {
    Client: "connect" | "events" | "observeState" | "on" | "run" | "waitFor" | "waitForClose"
    Instance: "resolve"
    Messages: "collect" | "collectReactions" | "keepTyping"
    ClientCache: "entries"
}

type CallableKeys<P extends readonly [object, object]> = {
    [K in keyof P[0] & keyof P[1]]: P[0][K] extends (...args: never[]) => unknown
        ? P[1][K] extends (...args: never[]) => unknown
            ? K
            : never
        : never
}[keyof P[0] & keyof P[1]]

type CheckPair<P extends readonly [object, object], X extends PropertyKey = never> = {
    [K in Exclude<CallableKeys<P>, X>]: Equal<NormalizeMember<P[0][K]>, NormalizeMember<P[1][K]>>
}

type Failures = {
    [K in keyof Paired]: {
        [
            M in keyof CheckPair<Paired[K], K extends keyof TypeLevelExceptions ? TypeLevelExceptions[K] : never>
        ]: CheckPair<Paired[K], K extends keyof TypeLevelExceptions ? TypeLevelExceptions[K] : never>[M] extends true
            ? never
            : `${K & string}.${M & string}`
    }[keyof CheckPair<Paired[K], K extends keyof TypeLevelExceptions ? TypeLevelExceptions[K] : never>]
}[keyof Paired]

type AssertNever<T extends never> = T

export type PublicClientParity = AssertNever<Failures>
