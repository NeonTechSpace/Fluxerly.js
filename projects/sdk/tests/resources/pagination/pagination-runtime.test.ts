import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { test } from "vitest"
import { requireBuiltSdk } from "../../support/built-sdk.js"

// These tests run the built SDK, so a stale or missing dist fails them before they start
requireBuiltSdk()

test("built pagination releases buffered snapshots on early exit and shutdown in both APIs", async () => {
    // The child asserts every mode and finish path and exits non-zero on any failure, which rejects here
    await promisify(execFile)(process.execPath, ["--expose-gc", "tests/resources/pagination/pagination-runtime.js"], {
        timeout: 15_000,
        windowsHide: true,
    })
}, 20_000)
