import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import { createClient, type Client, type ClientOptions } from "./client.js"

/**
 * Client settings for FluxerClient.layerConfig: The settings of createClient, where the token and any other top-level
 * setting can instead be an Effect Config read when the layer is built.
 * The token can be a Config of a Redacted or plain string, such as `Config.Redacted("FLUXER_BOT_TOKEN")`, or a Redacted
 * or plain string. A Redacted token stays wrapped until it is passed to the client, and the client never logs it.
 * Nested settings are not read from Config individually. Supply a Config of the whole top-level setting instead
 *
 * @category Client and lifecycle
 */
export type FluxerClientConfigOptions<E = never, R = never> = {
    readonly [K in Exclude<keyof ClientOptions<E, R>, "token">]?:
        ClientOptions<E, R>[K] | Config.Config<ClientOptions<E, R>[K]>
} & {
    /** Bot token, usually `Config.Redacted("FLUXER_BOT_TOKEN")`. A Config is read when the layer is built */
    readonly token:
        Config.Config<Redacted.Redacted<string>> | Config.Config<string> | Redacted.Redacted<string> | string
}

/** Read every Config-valued top-level setting in declaration order, keeping other values unchanged */
function resolveOptions<E, R>(
    options: FluxerClientConfigOptions<E, R>,
): Effect.Effect<ClientOptions<E, R>, Config.ConfigError> {
    return Effect.gen(function* () {
        if (typeof options !== "object" || options === null || Array.isArray(options))
            // Misuse reaches createClient unchanged, which dies with its ConfigurationError
            return options as unknown as ClientOptions<E, R>
        const resolved: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(options))
            resolved[key] = Config.isConfig(value) ? yield* value : value
        // The Redacted wrapper is removed only here, as the token is handed to the client, which masks it in every record
        if (Redacted.isRedacted(resolved.token)) resolved.token = Redacted.value(resolved.token)
        return resolved as unknown as ClientOptions<E, R>
    })
}

/**
 * Effect service holding one native client, for applications that assemble their program from Layers.
 * Build it with FluxerClient.layer(options) or FluxerClient.layerConfig(options), and read it with
 * `yield* FluxerClient` or FluxerClient.use.
 * The layer creates the client in the layer's Scope and calls shutdown when that Scope closes, awaiting SDK cleanup.
 * Building the layer does not connect the gateway or make a request. Register handlers first, then call client.connect()
 * or client.run(), so no event arrives before its handler exists. HTTP operations work without connecting.
 * Each build of the layer creates its own client. Provide one layer value to share its client, since Effect reuses a
 * layer value within one provide.
 * The service holds the full Message shape. For a messageFields selection, call createClient directly instead
 * @example
 * ```ts
 * import { Config, Effect } from "effect"
 * import { FluxerClient } from "@neontechspace/fluxerly/effect"
 *
 * const program = Effect.gen(function* () {
 *     const client = yield* FluxerClient
 *     yield* client.on("messageCreate", (message) =>
 *         message.content === "!ping"
 *             ? client.messages.reply(message, { content: "Pong!" }).pipe(Effect.asVoid)
 *             : Effect.void,
 *     )
 *     yield* client.run()
 * })
 *
 * export const main = program.pipe(
 *     Effect.scoped,
 *     Effect.provide(FluxerClient.layerConfig({ token: Config.Redacted("FLUXER_BOT_TOKEN") })),
 * )
 * ```
 *
 * @category Client and lifecycle
 */
export class FluxerClient extends Context.Service<FluxerClient, Client>()("@neontechspace/fluxerly/FluxerClient") {
    /**
     * Build the FluxerClient service from createClient settings.
     * Invalid settings, including a missing or blank token, are misuse and the layer dies with ConfigurationError.
     * Services required by the settings, such as those of an onError hook, become the layer's requirements, and native
     * logging uses the Effect logger in effect where the layer is built.
     * The client is created without connecting and is shut down when the layer's Scope closes
     */
    static layer<E = never, R = never>(options: ClientOptions<E, R>): Layer.Layer<FluxerClient, never, R> {
        return Layer.effect(FluxerClient)(createClient<E, R>(options))
    }

    /**
     * Build the FluxerClient service from settings that may be read from Effect Config, such as
     * `{ token: Config.Redacted("FLUXER_BOT_TOKEN") }`.
     * Config values are read from the current ConfigProvider, by default the process environment, when the layer is built.
     * A missing or unparsable Config value fails the layer with ConfigError before any client exists.
     * A token that is present but blank, or another invalid setting, is misuse and the layer dies with ConfigurationError,
     * as in FluxerClient.layer. The token stays Redacted until the client receives it and is never logged.
     * The client is created without connecting and is shut down when the layer's Scope closes
     */
    static layerConfig<E = never, R = never>(
        options: FluxerClientConfigOptions<E, R>,
    ): Layer.Layer<FluxerClient, Config.ConfigError, R> {
        return Layer.effect(FluxerClient)(
            resolveOptions(options).pipe(Effect.flatMap((resolved) => createClient<E, R>(resolved))),
        )
    }
}
