/**
 * Vitest setup that bounds a vi.waitFor poll without its own timeout by the running test's timeout.
 *
 * Vitest otherwise gives such a poll one real second, a deadline unrelated to the awaited work that a slow machine can
 * miss. The test timeout comes from the Vitest config or the test's own override, so it stays the only hang guard. An
 * explicit timeout, and a poll outside a test or its each-hooks, keep Vitest's behavior
 */
import { TestRunner, vi } from "vitest"

const waitFor = vi.waitFor

vi.waitFor = ((callback, options = {}) => {
    const resolved = typeof options === "number" ? { timeout: options } : options
    const timeout = resolved.timeout ?? TestRunner.getCurrentTest()?.timeout
    return waitFor(callback, timeout === undefined ? resolved : { ...resolved, timeout })
}) as typeof vi.waitFor
