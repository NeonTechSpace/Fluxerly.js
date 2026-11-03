/**
 * Cleanup owners: Which application code a cleanup fault came from, such as a named scheduled task or an onError hook.
 * Invariant: The owner is kept beside the fault's own Cause reason, never in it, so the defect and its Cause stay exactly
 * as raised, and shutdown's cleanup record names the owner. Implements [SDK contracts: User-handler failures](/docs/SDK-CONTRACTS.md#user-handler-failures)
 */
import type * as Cause from "effect/Cause"

/** The application code whose cleanup failed during shutdown */
export interface CleanupOwner {
    /** Words that name it in the cleanup record's message, such as the scheduled task "daily report" */
    readonly subject: string
    /** The scheduled task's name, for the record's task field */
    readonly task?: string | undefined
}

const owners = new WeakMap<Cause.Reason<unknown>, CleanupOwner>()

/** Remember the owner of a cleanup fault's reason, and return the same reason */
export function ownCleanup<R extends Cause.Reason<unknown>>(reason: R, owner: CleanupOwner): R {
    owners.set(reason, owner)
    return reason
}

/** The owner of a cleanup fault's reason, when one was remembered */
export function cleanupOwner(reason: Cause.Reason<unknown>): CleanupOwner | undefined {
    return owners.get(reason)
}
