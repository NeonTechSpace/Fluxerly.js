/**
 * Vitest setup that bounds a vi.waitFor poll without its own timeout by the running test's timeout.
 *
 * Vitest otherwise gives such a poll one real second, a deadline unrelated to the awaited work that a slow machine can
 * miss. The test timeout comes from the Vitest config or the test's own override, so it stays the only hang guard. An
 * explicit timeout, and a poll outside a test or its each-hooks, keep Vitest's behavior.
 *
 * Such a poll starts after its test, so the test timeout fires first. The poll then ends with its test instead of
 * polling on, and advancing faked timers, during later tests. A failed test reports the poll's last failure as well as
 * its own failure
 */
import { beforeEach, TestRunner, vi } from "vitest"

type Poll = { readonly test: object; end(failed: boolean): unknown[] }

const waitFor = vi.waitFor
// Captured before any test fakes timers, so a poll keeps real time like Vitest's own
const { setTimeout, clearTimeout, setInterval, clearInterval } = globalThis
const polls = new Set<Poll>()

function thenable<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
    return value !== null && typeof value === "object" && typeof (value as { then?: unknown }).then === "function"
}

// Vitest's poll logic, except for the deadline and the end with its test
vi.waitFor = (<T>(callback: () => T | Promise<T>, options: Parameters<typeof waitFor>[1] = {}) => {
    const resolved = typeof options === "number" ? { timeout: options } : options
    const test = TestRunner.getCurrentTest()
    if (resolved.timeout !== undefined || test === undefined) return waitFor(callback, resolved)
    const interval = resolved.interval ?? 50
    return new Promise<T>((resolve, reject) => {
        let deadline: ReturnType<typeof setTimeout> | undefined
        let repeat: ReturnType<typeof setInterval> | undefined
        let failure: { readonly error: unknown } | undefined
        let checking = false
        let rejected = false
        const stop = () => {
            clearTimeout(deadline)
            clearInterval(repeat)
        }
        // A failed poll stays tracked until its test's finished hook has read the failure, because its deadline can
        // pass during teardown after the test timed out, and then nothing else reports it
        const fail = () => {
            stop()
            rejected = true
            reject(failure ? failure.error : new Error("Timed out in waitFor!"))
        }
        // An attempt that settles after the poll failed must not untrack it before its failure is reported
        const succeed = (value: T) => {
            if (rejected) return
            stop()
            polls.delete(poll)
            resolve(value)
        }
        const poll: Poll = {
            test,
            end(failed) {
                polls.delete(poll)
                // A passed test no longer awaits the poll, so it only stops
                if (failed) fail()
                else stop()
                return failure ? [failure.error] : []
            },
        }
        const check = () => {
            if (vi.isFakeTimers()) vi.advanceTimersByTime(interval)
            if (checking) return false
            try {
                const result = callback()
                if (thenable(result)) {
                    checking = true
                    result.then(succeed, (error: unknown) => {
                        checking = false
                        failure = { error }
                    })
                    return false
                }
                succeed(result)
                return true
            } catch (error) {
                failure = { error }
                return false
            }
        }
        if (check()) return
        polls.add(poll)
        deadline = setTimeout(fail, test.timeout)
        repeat = setInterval(check, interval)
    })
}) as typeof vi.waitFor

// Vitest runs every finished-test hook even when the test, an afterEach hook or another such hook fails, so the polls
// always end. A failure thrown here is added to the test's errors without skipping the remaining hooks
beforeEach(({ task, onTestFinished }) =>
    onTestFinished(() => {
        const failed = task.result?.state === "fail"
        const failures = [...polls].filter((poll) => poll.test === task).flatMap((poll) => poll.end(failed))
        if (failed && failures.length > 0) throw new AggregateError(failures)
    }),
)
