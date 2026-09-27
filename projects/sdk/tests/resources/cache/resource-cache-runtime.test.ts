import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { test } from "vitest"
import { requireBuiltSdk } from "../../support/built-sdk.js"

// These tests run the built SDK, so a stale or missing dist fails them before they start
requireBuiltSdk()

test("built resource caches bound dense member pages and release snapshots without lookups", async () => {
    // The child asserts every mode and case and exits non-zero on any failure, which rejects here
    await promisify(execFile)(process.execPath, ["--expose-gc", "tests/resources/cache/resource-cache-runtime.js"], {
        timeout: 25_000,
        windowsHide: true,
    })
}, 30_000)
