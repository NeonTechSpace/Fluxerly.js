/**
 * Field-path tracing for rejected provider payloads, used by the malformed-dispatch record.
 * Invariant: Tracing re-runs a pure decoder over a structured clone, records only property names and array indexes,
 * and never exposes or retains payload values.
 * Implements [SDK contracts: Logging](/docs/SDK-CONTRACTS.md#logging)
 */
/** The named check a decoder rejected its value on, set by rejectCheck while failingFieldPath re-runs the decoder */
let rejectedCheck: string | undefined

/** Reject a decoded value on a check across items or fields, such as page order, whose last read field is valid.
 * Return its result from a decoder in place of undefined, so the failure names the check instead of that field
 */
export function rejectCheck(check: string): undefined {
    rejectedCheck = check
    return undefined
}

/** Re-run a pure decoder over a tracing view of a rejected payload and return the last field path it read, or the
 * check it named through rejectCheck.
 * Decoders read fields in order and stop at the first invalid one, so the last read path names the failing field.
 * Only property names and array indexes are recorded, never values. Returns undefined when nothing was read
 */
export function failingFieldPath(decode: (value: unknown) => unknown, value: unknown): string | undefined {
    if (typeof value !== "object" || value === null) return undefined
    let last: readonly (string | number)[] | undefined
    const proxies = new WeakMap<object, object>()
    const wrap = (target: unknown, path: readonly (string | number)[]): unknown => {
        if (typeof target !== "object" || target === null) return target
        const cached = proxies.get(target)
        if (cached) return cached
        const segment = (key: string | symbol) =>
            typeof key === "symbol" ? undefined : Array.isArray(target) && /^\d+$/.test(key) ? Number(key) : key
        const proxy = new Proxy(target, {
            get(object, key, receiver) {
                const name = segment(key)
                const result: unknown = Reflect.get(object, key, receiver)
                if (name === undefined || (Array.isArray(object) && name === "length") || typeof result === "function")
                    return result
                last = [...path, name]
                return wrap(result, last)
            },
            has(object, key) {
                const name = segment(key)
                if (name !== undefined) last = [...path, name]
                return Reflect.has(object, key)
            },
            getOwnPropertyDescriptor(object, key) {
                const name = segment(key)
                if (name !== undefined) last = [...path, name]
                return Reflect.getOwnPropertyDescriptor(object, key)
            },
        })
        proxies.set(target, proxy)
        return proxy
    }
    rejectedCheck = undefined
    try {
        decode(wrap(structuredClone(value), []))
    } catch {
        // allow-silent: A decoder that throws on the tracing view still leaves the last read path
    }
    const check = rejectedCheck
    rejectedCheck = undefined
    return check ?? last?.map(String).join(".")
}
