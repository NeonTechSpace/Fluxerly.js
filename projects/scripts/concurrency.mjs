// @ts-check
// Shared dynamic concurrency helpers for offline workspace tooling
// Scales gently on low-core hosts (1 worker or lane on 2 to 4 cores) and caps multi-core local runs near 65% CPU
import { availableParallelism } from "node:os"

/**
 * Parses a positive integer environment variable override
 * @param {string | undefined} raw
 * @returns {number | undefined}
 */
export function parsePositiveInt(raw) {
    if (typeof raw !== "string") return undefined
    const trimmed = raw.trim()
    if (!/^[1-9]\d*$/.test(trimmed)) return undefined
    const value = Number.parseInt(trimmed, 10)
    return Number.isSafeInteger(value) && value >= 1 ? value : undefined
}

/**
 * Resolves an explicit concurrency override from tool-specific or shared environment variables
 * @param {{ env?: NodeJS.ProcessEnv, envVar?: string }} [options]
 * @returns {number | undefined}
 */
export function concurrencyOverride(options = {}) {
    const env = options.env ?? process.env
    if (options.envVar) {
        const specific = parsePositiveInt(env[options.envVar])
        if (specific !== undefined) return specific
    }
    return parsePositiveInt(env.FLUXERLY_MAX_CONCURRENCY)
}

/**
 * Returns the polite CPU thread budget for the current machine
 * Local low-core machines stay gentle (1 on 1 to 2 cores, 2 on 3 to 4 cores) while multi-core hosts cap near 65% CPU
 * Dedicated CI runners use all available threads
 * @param {{ cores?: number, ci?: boolean, env?: NodeJS.ProcessEnv, envVar?: string, max?: number }} [options]
 * @returns {number}
 */
export function cpuBudget(options = {}) {
    const env = options.env ?? process.env
    const override = concurrencyOverride({ env, ...(options.envVar ? { envVar: options.envVar } : {}) })
    if (override !== undefined) return override
    const cores = Math.max(1, Math.floor(options.cores ?? availableParallelism()))
    const ci = options.ci ?? Boolean(env.CI)
    const raw = ci ? cores : cores <= 2 ? 1 : cores <= 4 ? 2 : Math.max(2, Math.floor(cores * 0.65))
    return options.max === undefined ? raw : Math.max(1, Math.min(options.max, raw))
}

/**
 * Returns the bounded parallel lane or worker count for concurrent tasks
 * Local 2 to 4 core machines always stay at 1 lane so heavy tools and worker pools never thrash
 * @param {{ cores?: number, ci?: boolean, env?: NodeJS.ProcessEnv, envVar?: string, perLaneCores?: number, max?: number }} [options]
 * @returns {number}
 */
export function parallelLanes(options = {}) {
    const env = options.env ?? process.env
    const override = concurrencyOverride({ env, ...(options.envVar ? { envVar: options.envVar } : {}) })
    if (override !== undefined) return override
    const cores = Math.max(1, Math.floor(options.cores ?? availableParallelism()))
    const ci = options.ci ?? Boolean(env.CI)
    if (!ci && cores <= 4) return 1
    const budget = cpuBudget({ cores, ci, env })
    const perLane = Math.max(1, options.perLaneCores ?? 1)
    const raw = Math.max(1, Math.floor(budget / perLane))
    return options.max === undefined ? raw : Math.max(1, Math.min(options.max, raw))
}

/**
 * Returns a polite GOMAXPROCS value per concurrent Go-based compiler process (TypeScript 7 or effect-tsgo)
 * Keeps combined compiler threads within the machine CPU budget
 * @param {number} lanes
 * @param {{ cores?: number, ci?: boolean, env?: NodeJS.ProcessEnv }} [options]
 * @returns {number}
 */
export function goMaxProcsFor(lanes, options = {}) {
    const budget = cpuBudget(options)
    const active = Math.max(1, Math.floor(lanes))
    return Math.max(1, Math.floor(budget / active))
}

/**
 * Computes Vitest worker counts for unit tests and process-spawning tests
 * Honors VITEST_MAX_WORKERS and FLUXERLY_MAX_CONCURRENCY overrides
 * @param {{ cores?: number, ci?: boolean, env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ unit: number, processes: number }}
 */
export function vitestWorkerCounts(options = {}) {
    const env = options.env ?? process.env
    const override = concurrencyOverride({ env, envVar: "VITEST_MAX_WORKERS" })
    if (override !== undefined) return { unit: override, processes: Math.max(1, override - 1) }
    const cores = Math.max(1, Math.floor(options.cores ?? availableParallelism()))
    const ci = options.ci ?? Boolean(env.CI)
    if (ci) return { unit: cores, processes: Math.max(1, cores - 1) }
    const unit = cores <= 3 ? 1 : cores === 4 ? 2 : Math.min(16, Math.max(2, Math.floor(cores * 0.65)))
    const processes = unit <= 1 ? 1 : Math.max(1, Math.min(10, unit - 1))
    return { unit, processes }
}

/**
 * Runs async work over items with bounded concurrency while preserving output order
 * @template T, R
 * @param {readonly T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
export async function runBounded(items, concurrency, worker) {
    if (items.length === 0) return []
    const limit = Math.max(1, Math.min(items.length, Math.floor(concurrency)))
    /** @type {R[]} */
    const results = Array.from({ length: items.length })
    let cursor = 0
    let failed = false
    const lane = async () => {
        while (!failed) {
            const index = cursor++
            if (index >= items.length) return
            try {
                results[index] = await worker(items[index], index)
            } catch (error) {
                failed = true
                throw error
            }
        }
    }
    await Promise.all(Array.from({ length: limit }, lane))
    return results
}
