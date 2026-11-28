export interface ConcurrencyEnvOptions {
    readonly env?: NodeJS.ProcessEnv
    readonly envVar?: string
}

export interface CpuBudgetOptions extends ConcurrencyEnvOptions {
    readonly cores?: number
    readonly ci?: boolean
    readonly max?: number
}

export interface ParallelLanesOptions extends CpuBudgetOptions {
    readonly perLaneCores?: number
}

export interface VitestWorkerOptions {
    readonly cores?: number
    readonly ci?: boolean
    readonly env?: NodeJS.ProcessEnv
}

export function parsePositiveInt(raw: string | undefined): number | undefined
export function concurrencyOverride(options?: ConcurrencyEnvOptions): number | undefined
export function cpuBudget(options?: CpuBudgetOptions): number
export function parallelLanes(options?: ParallelLanesOptions): number
export function goMaxProcsFor(lanes: number, options?: VitestWorkerOptions): number
export function vitestWorkerCounts(options?: VitestWorkerOptions): { readonly unit: number; readonly processes: number }
export function runBounded<T, R>(
    items: readonly T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<R>,
): Promise<R[]>
