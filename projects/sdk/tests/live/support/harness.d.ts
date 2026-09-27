export const snowflake: RegExp

export class HarnessCheckError extends Error {
    constructor(check: string, message?: string)
    readonly check: string
}

export interface SandboxLock {
    readonly path: string | URL
    readonly held: boolean
    release(): boolean
}

export interface CheckDeclaration {
    readonly lockClass: "read-only" | "test-owned" | "shared-state"
    readonly key: string
}

export function acquireLock(options?: { readonly path?: string | URL; readonly check?: CheckDeclaration }): SandboxLock

export interface SandboxEnvironment {
    readonly env: Readonly<Record<string, string | undefined>>
    readonly token: string
    readonly guildId: string
    readonly applicationId: string
}

export function loadSandboxEnvironment(options?: {
    readonly path?: string | URL
    readonly processOverrides?: boolean
    readonly requireApplicationToken?: boolean
}): SandboxEnvironment

export function processValue(name: string, pattern?: RegExp): string
export function processAuthorized(name: string): boolean

export interface SandboxJournal {
    readonly path: URL
    exists(): boolean
    read(): Record<string, unknown>
    create(value: object): void
    save(value: object): void
    remove(): void
}

export function openJournal(name: string, directory?: URL): SandboxJournal

export function checkSandboxIdentity(
    documents: { readonly application: unknown; readonly user: unknown; readonly guild: unknown },
    configured: { readonly applicationId: string; readonly guildId: string },
): string

export function verifySandboxIdentity(
    read: (path: string) => Promise<unknown>,
    options: {
        readonly applicationId: string
        readonly guildId: string
        readonly applicationPath?: string
        readonly concurrent?: boolean
    },
): Promise<Readonly<{ application: unknown; user: unknown; guild: unknown; botId: string }>>

export function shutdownDefaultClient(
    client: { shutdown(): PromiseLike<{ isOk(): boolean }> },
    after?: () => void,
): Promise<boolean>

type FinalizerEntry = readonly [finalizer: string, operation: () => unknown] | false | null | undefined

export function finalizeOwned(options: {
    readonly writers?: readonly FinalizerEntry[]
    readonly checks?: readonly FinalizerEntry[]
    readonly cleanup?: (() => unknown) | undefined
    readonly lock?: SandboxLock | undefined
    readonly watchdog?: ReturnType<typeof setTimeout> | undefined
    readonly onFailure: (finalizer: string, error?: unknown) => void
}): Promise<boolean>
