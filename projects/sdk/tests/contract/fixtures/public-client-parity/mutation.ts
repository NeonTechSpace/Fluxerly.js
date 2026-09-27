// Starts valid. The public client contract removes each marked line in turn and requires the comparator to reject it
import type * as Effect from "effect/Effect"
import type { ResultAsync } from "neverthrow"
import type { AssertNever, PairFailures } from "./compare.js"

class AuditFailure extends Error {
    readonly _tag = "AuditFailure"
}

interface DefaultAuditOptions {
    readonly includeAutomations?: boolean
    readonly signal?: { readonly aborted: boolean }
}

interface NativeAuditOptions {
    readonly includeAutomations?: boolean // parity-option
}

interface AuditEntry {
    readonly id: string
    readonly actorId: string
}

interface NativeAuditEntry {
    readonly id: string
    readonly actorId: string // parity-projection
}

interface DefaultAudit {
    fetch(input: string, options?: DefaultAuditOptions): ResultAsync<AuditEntry, AuditFailure>
    wait(options?: { readonly signal?: { readonly aborted: boolean } }): ResultAsync<void, never>
}

interface NativeAudit {
    fetch(
        input: string,
        options?: NativeAuditOptions, // parity-parameter
    ): Effect.Effect<NativeAuditEntry, AuditFailure>
    wait(): Effect.Effect<void>
}

export type AuditParity = AssertNever<PairFailures<{ Audit: [DefaultAudit, NativeAudit] }>>
