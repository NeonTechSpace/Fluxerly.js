import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, onTestFinished, test } from "vitest"
import { builtSdkProblem } from "../support/built-sdk.js"

test("the built-SDK guard reports a missing dist and a dist older than any source file", () => {
    const root = mkdtempSync(join(tmpdir(), "fluxerly-built-sdk-"))
    onTestFinished(() => rmSync(root, { recursive: true, force: true }))
    mkdirSync(join(root, "src", "internal"), { recursive: true })
    const source = join(root, "src", "internal", "client.ts")
    writeFileSync(source, "")
    expect(builtSdkProblem(root)).toBe("The built SDK is missing")

    mkdirSync(join(root, "dist"))
    const built = join(root, "dist", "index.js")
    writeFileSync(built, "")
    const buildTime = new Date("2026-01-01T00:00:00Z")
    utimesSync(built, buildTime, buildTime)
    utimesSync(source, new Date("2025-12-31T00:00:00Z"), new Date("2025-12-31T00:00:00Z"))
    expect(builtSdkProblem(root)).toBeUndefined()

    // A nested source file edited after the build makes dist stale
    utimesSync(source, new Date("2026-01-02T00:00:00Z"), new Date("2026-01-02T00:00:00Z"))
    expect(builtSdkProblem(root)).toBe("The built SDK is older than src")
})
