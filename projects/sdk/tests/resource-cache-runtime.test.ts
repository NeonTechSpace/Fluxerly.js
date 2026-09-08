import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { expect, test } from "vitest"

test("built resource caches bound dense member pages and release snapshots without lookups", async () => {
    const { stdout } = await promisify(execFile)(
        process.execPath,
        ["--expose-gc", "tests/resource-cache-runtime.mjs"],
        {
            timeout: 25_000,
            windowsHide: true,
        },
    )
    const reports = stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    expect(reports.filter((report) => report.check === "resource_cache_workload")).toHaveLength(4)
    expect(
        reports.filter((report) => report.check === "resource_cache_active_expiry_and_shutdown" && report.passed),
    ).toHaveLength(2)
}, 30_000)
