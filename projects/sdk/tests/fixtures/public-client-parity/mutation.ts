interface DefaultAuditOptions {
    readonly includeAutomations?: boolean
    readonly signal?: { readonly aborted: boolean }
}

interface NativeAuditOptions {
    readonly includeAutomations?: boolean // parity-option
}

interface DefaultAuditEntry {
    readonly id: string
    readonly actorId: string
}

interface NativeAuditEntry {
    readonly id: string
    readonly actorId: string // parity-projection
}

type WithoutSignal<T> = Omit<T, "signal">
type Equal<A, B> =
    (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
        ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
            ? true
            : false
        : false
type AssertTrue<T extends true> = T

export type AuditOptionParity = AssertTrue<Equal<WithoutSignal<DefaultAuditOptions>, NativeAuditOptions>>
export type AuditProjectionParity = AssertTrue<Equal<DefaultAuditEntry, NativeAuditEntry>>
