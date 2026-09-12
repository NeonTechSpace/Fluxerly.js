import type { PrefixCommandMetadata } from "./commands.js"

/** Explicit presentation choices for local help generation, without attaching or connecting a client */
export interface CommandHelpOptions {
    /** Nonempty display prefix. The router never invokes its configured prefix resolver to generate help */
    readonly prefix: string
    /** Positive safe integer UTF-16 code-unit ceiling per page. No default or provider-limit lookup */
    readonly maxLength: number
    /**
     * Optional synchronous visibility predicate, called once per command in registration order until a failure.
     * Defaults to including every registered command. It receives frozen metadata, not messages, candidates or handlers.
     * This is presentation policy, not authorization. Guards and cooldowns are never evaluated.
     * Throws and non-boolean returns fail with fixed ConfigurationError details without the thrown value.
     * Promises are not supported or awaited. Keep this callback short because synchronous work cannot be interrupted
     */
    readonly include?: (command: PrefixCommandMetadata) => boolean
}
