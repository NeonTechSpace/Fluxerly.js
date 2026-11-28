import assert from "node:assert/strict"
import test from "node:test"
import {
    concurrencyOverride,
    cpuBudget,
    goMaxProcsFor,
    parallelLanes,
    parsePositiveInt,
    runBounded,
    vitestWorkerCounts,
} from "../../scripts/concurrency.mjs"

test("parsePositiveInt accepts positive base-10 integers and ignores invalid overrides", () => {
    assert.equal(parsePositiveInt("1"), 1)
    assert.equal(parsePositiveInt(" 12 "), 12)
    for (const invalid of [undefined, "", "0", "-4", "3.5", "abc", "12px", "Infinity"]) {
        assert.equal(parsePositiveInt(invalid), undefined, String(invalid))
    }
})

test("concurrencyOverride prefers tool-specific env vars over FLUXERLY_MAX_CONCURRENCY", () => {
    assert.equal(
        concurrencyOverride({
            env: { FLUXERLY_MAX_CONCURRENCY: "4", VITEST_MAX_WORKERS: "9" },
            envVar: "VITEST_MAX_WORKERS",
        }),
        9,
    )
    assert.equal(
        concurrencyOverride({
            env: { FLUXERLY_MAX_CONCURRENCY: "4", VITEST_MAX_WORKERS: "invalid" },
            envVar: "VITEST_MAX_WORKERS",
        }),
        4,
    )
    assert.equal(concurrencyOverride({ env: {} }), undefined)
})

test("cpuBudget stays gentle on low-core local hosts, caps near 65% on multi-core hosts and uses all CI cores", () => {
    const local = { ci: false, env: {} }
    assert.equal(cpuBudget({ ...local, cores: 1 }), 1)
    assert.equal(cpuBudget({ ...local, cores: 2 }), 1)
    assert.equal(cpuBudget({ ...local, cores: 3 }), 2)
    assert.equal(cpuBudget({ ...local, cores: 4 }), 2)
    assert.equal(cpuBudget({ ...local, cores: 8 }), 5)
    assert.equal(cpuBudget({ ...local, cores: 12 }), 7)
    assert.equal(cpuBudget({ ...local, cores: 16 }), 10)
    assert.equal(cpuBudget({ ...local, cores: 20 }), 13)
    assert.equal(cpuBudget({ ...local, cores: 32 }), 20)

    const ci = { ci: true, env: { CI: "true" } }
    assert.equal(cpuBudget({ ...ci, cores: 2 }), 2)
    assert.equal(cpuBudget({ ...ci, cores: 4 }), 4)
    assert.equal(cpuBudget({ ...ci, cores: 8 }), 8)

    assert.equal(cpuBudget({ cores: 20, ci: false, env: { FLUXERLY_CHECK_SLOTS: "6" }, envVar: "FLUXERLY_CHECK_SLOTS" }), 6)
    assert.equal(cpuBudget({ cores: 20, ci: false, env: {}, max: 8 }), 8)
})

test("parallelLanes keeps 2 to 4 core local hosts at 1 lane and scales cleanly on multi-core and CI", () => {
    const local = { ci: false, env: {} }
    for (const cores of [1, 2, 3, 4]) {
        assert.equal(parallelLanes({ ...local, cores, perLaneCores: 1, max: 8 }), 1, `${cores} local cores`)
    }
    assert.equal(parallelLanes({ ...local, cores: 8, perLaneCores: 2, max: 8 }), 2)
    assert.equal(parallelLanes({ ...local, cores: 16, perLaneCores: 3, max: 4 }), 3)
    assert.equal(parallelLanes({ ...local, cores: 20, perLaneCores: 3, max: 4 }), 4)
    assert.equal(parallelLanes({ ...local, cores: 20, perLaneCores: 2, max: 8 }), 6)

    const ci = { ci: true, env: { CI: "true" } }
    assert.equal(parallelLanes({ ...ci, cores: 4, perLaneCores: 2, max: 4 }), 2)
    assert.equal(parallelLanes({ ...ci, cores: 4, perLaneCores: 1, max: 4 }), 4)

    assert.equal(
        parallelLanes({ cores: 2, ci: false, env: { FLUXERLY_LINT_CONCURRENCY: "3" }, envVar: "FLUXERLY_LINT_CONCURRENCY" }),
        3,
    )
})

test("goMaxProcsFor keeps combined compiler threads within the host CPU budget", () => {
    assert.equal(goMaxProcsFor(1, { cores: 2, ci: false, env: {} }), 1)
    assert.equal(goMaxProcsFor(1, { cores: 4, ci: false, env: {} }), 2)
    assert.equal(goMaxProcsFor(4, { cores: 20, ci: false, env: {} }), 3)
    assert.equal(goMaxProcsFor(2, { cores: 20, ci: false, env: {} }), 6)
    assert.equal(goMaxProcsFor(2, { cores: 4, ci: true, env: { CI: "true" } }), 2)
})

test("vitestWorkerCounts scales smoothly from low-core to high-core hosts and honors overrides", () => {
    const local = { ci: false, env: {} }
    assert.deepEqual(vitestWorkerCounts({ ...local, cores: 2 }), { unit: 1, processes: 1 })
    assert.deepEqual(vitestWorkerCounts({ ...local, cores: 3 }), { unit: 1, processes: 1 })
    assert.deepEqual(vitestWorkerCounts({ ...local, cores: 4 }), { unit: 2, processes: 1 })
    assert.deepEqual(vitestWorkerCounts({ ...local, cores: 8 }), { unit: 5, processes: 4 })
    assert.deepEqual(vitestWorkerCounts({ ...local, cores: 16 }), { unit: 10, processes: 9 })
    assert.deepEqual(vitestWorkerCounts({ ...local, cores: 20 }), { unit: 13, processes: 10 })
    assert.deepEqual(vitestWorkerCounts({ ...local, cores: 32 }), { unit: 16, processes: 10 })

    assert.deepEqual(vitestWorkerCounts({ cores: 4, ci: true, env: { CI: "true" } }), { unit: 4, processes: 3 })
    assert.deepEqual(vitestWorkerCounts({ cores: 20, ci: false, env: { VITEST_MAX_WORKERS: "5" } }), {
        unit: 5,
        processes: 4,
    })
    assert.deepEqual(vitestWorkerCounts({ cores: 20, ci: false, env: { FLUXERLY_MAX_CONCURRENCY: "1" } }), {
        unit: 1,
        processes: 1,
    })
})

test("runBounded enforces the concurrency ceiling and preserves result order", async () => {
    let active = 0
    let peak = 0
    const results = await runBounded([10, 20, 30, 40, 50, 60], 2, async (value, index) => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, (6 - index) * 5))
        active -= 1
        return value * 2
    })
    assert.equal(peak, 2)
    assert.deepEqual(results, [20, 40, 60, 80, 100, 120])
    assert.deepEqual(await runBounded([], 4, async () => 1), [])
})
