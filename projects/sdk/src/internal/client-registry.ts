/**
 * Registry from public client objects to their owner's logging and failure reporting.
 * Invariant: Optional tools find owner services only for clients the SDK created, and a foreign object resolves to undefined.
 * Implements [SDK contracts: User-handler failures](/docs/SDK-CONTRACTS.md#user-handler-failures)
 */
import type * as Effect from "effect/Effect"
import type { ClientLogger } from "./logging.js"
import type { FailureReporter } from "./failures.js"

/** The owner services that optional tools built on the public client need for logging and failure reports */
export interface ClientServices {
    readonly logging: ClientLogger
    readonly failures: FailureReporter
    /** The bot account ID for command mention prefixes, or undefined when it cannot be read yet */
    selfUserId(): Effect.Effect<string | undefined>
}

const owners = new WeakMap<object, ClientServices>()

/** Associate a public client object with its owner's logging and failure reporting */
export function registerClientOwner<T extends object>(client: T, owner: ClientServices): T {
    owners.set(client, owner)
    return client
}

/** Owner services for a public client, or undefined for a foreign object */
export function clientServices(client: unknown): ClientServices | undefined {
    return typeof client === "object" && client !== null ? owners.get(client) : undefined
}
