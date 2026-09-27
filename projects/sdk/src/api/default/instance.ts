import type { ResultAsync } from "neverthrow"
import type { OperationOptions } from "#sdk/client"
import type { InstanceResolveError, InstanceResolveOptions, ResolvedInstance } from "#sdk/instance"
import type { CancelledError, ConfigurationError } from "#sdk/errors"

/**
 * Find the selected Fluxer instance's endpoints and build links and asset URLs for it.
 * The resolve method fetches the unauthenticated well-known document only when needed.
 * Concurrent callers share that request.
 * A successful frozen result is retained until client shutdown, without background refresh.
 * Cancelling one caller leaves other callers using the request.
 * The last departing caller waits for discovery cleanup
 *
 * @example
 * ```ts
 * import type { Client } from "@neontechspace/fluxerly"
 * export async function instanceExample(client: Client) {
 *     const resolved = await client.instance.resolve({ timeoutMs: 10_000 })
 *     if (resolved.isErr()) return resolved
 *     const channel = resolved.value.links.channel({ id: "1750000000000000000" })
 *     return { api: resolved.value.endpoints.apiPublic, channel }
 * }
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
     * Unexpected cleanup failures reject with SdkDefect, retaining safe details of any accompanying failure or interruption
     */
    resolve(
        options?: DefaultInstanceResolveOptions,
    ): ResultAsync<ResolvedInstance, InstanceResolveError | CancelledError | ConfigurationError>
}

/**
 * Set the discovery-wait timeout in milliseconds and optionally pass an AbortSignal.
 * The signal cancels only this caller's wait
 *
 * @category Options
 */
export interface DefaultInstanceResolveOptions extends InstanceResolveOptions, OperationOptions {}
