import type * as Effect from "effect/Effect"
import type { InstanceResolveError, InstanceResolveOptions, ResolvedInstance } from "#sdk/instance"

export type { ResolvedInstance }

/**
 * Return the shared resolved-instance value for native callers.
 * Its asset and link helpers already return plain values in both APIs, so no Effect wrapping is needed
 */
export function effectInstance(value: ResolvedInstance): ResolvedInstance {
    return value
}

/**
 * Resolve the service addresses and URL helpers for the instance selected at client creation
 *
 * The resolve method starts when executed and uses the caller's Effect services. Concurrent callers share one document read
 * that runs in the client Scope. Interrupting one caller releases only that caller's wait. A successful immutable
 * result is reused without refresh until client shutdown
 *
 * The resolved assets and links helpers return URLs directly, the same as in the default API.
 * They throw AssetUrlError or HelperError for invalid input, and such a throw inside Effect code becomes a defect
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import type { Client } from "@neontechspace/fluxerly/effect"
 * export const instanceExample = (client: Client) => Effect.gen(function* () {
 *     const resolved = yield* client.instance.resolve({ timeoutMs: 10_000 })
 *     const channel = resolved.links.channel({ id: "1750000000000000000" })
 *     const avatar = resolved.assets.defaultAvatar("1750000000000000000")
 *     return { api: resolved.endpoints.apiPublic, channel, avatar }
 * })
 * ```
 *
 * @category Client and lifecycle
 */
export interface Instance {
    /**
     * Resolve this client's instance endpoints and its pure link and asset URL helpers.
     * The unauthenticated discovery request is shared with other resolves, REST work or gateway startup.
     * The timeoutMs option defaults to 30,000 for this wait only.
     * Cancellation releases only this wait, while other users can keep the shared discovery read alive.
     * Document, rate-limit, timeout, closure and invalid timeout-option failures are expected failures
     *
     * @remarks
     * Cleanup defects remain in the Cause alongside any failure or interruption
     */
    resolve(options?: InstanceResolveOptions): Effect.Effect<ResolvedInstance, InstanceResolveError>
}
