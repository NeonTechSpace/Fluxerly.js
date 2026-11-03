type Fields = Record<string, unknown> | (() => Record<string, unknown>)

export function createReporter(
    base: Fields,
    options?: { readonly passed?: boolean },
): (check: string, details?: Record<string, unknown>) => void

export function createOutcomeReporter(
    base: Fields,
): (check: string, passed?: boolean, details?: Record<string, unknown>) => void

export function createFailureClassifier(options: {
    readonly tags: readonly string[]
    readonly reasons?: readonly string[]
    readonly httpStatus?: boolean
}): (error: unknown) => { readonly category: string; readonly reason?: string; readonly httpStatus?: number }

export const recoveredOnlyExitCode: number

export function recoveredOnly(): void
