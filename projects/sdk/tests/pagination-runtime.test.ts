import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { expect, test } from "vitest"

test("built pagination releases buffered snapshots on early exit and shutdown in both APIs", async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ["--expose-gc", "tests/pagination-runtime.js"], {
        timeout: 15_000,
        windowsHide: true,
    })
    const reports = stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    expect(reports.filter((report) => report.check === "pagination_buffer_release" && report.passed)).toHaveLength(4)
}, 20_000)
