// JSON-lines output shared by the live harnesses. Each harness passes its own leading fields, so every printed line
// keeps the keys, values and key order that harness defines. This module has no dependencies, so harnesses that load
// Effect lazily can use it before any package resolution

const fieldsOf = (base) => (typeof base === "function" ? base : () => base)

/**
 * Returns `report(check, details = {})`, which prints `{ ...base, check, ...details }` as one JSON line.
 * With `passed`, that value follows `check` unless `details` replaces it.
 * A function `base` is read on every call, for leading fields that change during a run
 */
export function createReporter(base, { passed } = {}) {
    const fields = fieldsOf(base)
    return passed === undefined
        ? (check, details = {}) => console.log(JSON.stringify({ ...fields(), check, ...details }))
        : (check, details = {}) => console.log(JSON.stringify({ ...fields(), check, passed, ...details }))
}

/** Returns `report(check, passed = true, details = {})`, which prints `{ ...base, check, passed, ...details }` */
export function createOutcomeReporter(base) {
    const fields = fieldsOf(base)
    return (check, passed = true, details = {}) =>
        console.log(JSON.stringify({ ...fields(), check, passed, ...details }))
}

/**
 * Returns `safeFailure(error)`, which projects only allowlisted classifications and never messages, stacks, causes or
 * response bodies. The `category` is a listed `_tag`, `assertion` or `unexpected`, `reason` appears only when listed,
 * and with `httpStatus` a safe-integer `status` appears as `httpStatus`
 */
export function createFailureClassifier({ tags, reasons = [], httpStatus = false }) {
    const knownTags = new Set(tags)
    const knownReasons = new Set(reasons)
    return (error) => ({
        category: knownTags.has(error?._tag)
            ? error._tag
            : error?.code === "ERR_ASSERTION"
              ? "assertion"
              : "unexpected",
        ...(knownReasons.has(error?.reason) ? { reason: error.reason } : {}),
        ...(httpStatus && Number.isSafeInteger(error?.status) ? { httpStatus: error.status } : {}),
    })
}
