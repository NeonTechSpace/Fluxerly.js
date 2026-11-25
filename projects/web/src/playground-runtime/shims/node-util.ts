// Browser shim for node:util (isDeepStrictEqual, inspect and types)

function deepEqual(left: unknown, right: unknown, seen: WeakMap<object, object>): boolean {
    if (Object.is(left, right)) return true
    if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false
    if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) return false

    if (seen.get(left) === right) return true
    seen.set(left, right)

    if (left instanceof Date && right instanceof Date) return Object.is(left.getTime(), right.getTime())
    if (left instanceof RegExp && right instanceof RegExp) return left.source === right.source && left.flags === right.flags
    if (ArrayBuffer.isView(left) && ArrayBuffer.isView(right)) {
        if (left.byteLength !== right.byteLength) return false
        const a = new Uint8Array(left.buffer, left.byteOffset, left.byteLength)
        const b = new Uint8Array(right.buffer, right.byteOffset, right.byteLength)
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
        return true
    }
    if (Array.isArray(left) && Array.isArray(right)) {
        if (left.length !== right.length) return false
        for (let i = 0; i < left.length; i++) if (!deepEqual(left[i], right[i], seen)) return false
        return true
    }
    if (left instanceof Map && right instanceof Map) {
        if (left.size !== right.size) return false
        for (const [k, v] of left) if (!right.has(k) || !deepEqual(v, right.get(k), seen)) return false
        return true
    }
    if (left instanceof Set && right instanceof Set) {
        if (left.size !== right.size) return false
        for (const v of left) if (!right.has(v)) return false
        return true
    }

    const keysA = Reflect.ownKeys(left).filter((k) => Object.prototype.propertyIsEnumerable.call(left, k))
    const keysB = Reflect.ownKeys(right).filter((k) => Object.prototype.propertyIsEnumerable.call(right, k))
    if (keysA.length !== keysB.length) return false
    const recordA = left as Record<PropertyKey, unknown>
    const recordB = right as Record<PropertyKey, unknown>
    for (const key of keysA) {
        if (!Object.prototype.hasOwnProperty.call(right, key)) return false
        if (!deepEqual(recordA[key], recordB[key], seen)) return false
    }
    return true
}

export function isDeepStrictEqual(left: unknown, right: unknown): boolean {
    return deepEqual(left, right, new WeakMap())
}

export function inspect(value: unknown, options?: { readonly depth?: number }): string {
    const maxDepth = options?.depth ?? 4
    const seen = new WeakSet<object>()
    const format = (item: unknown, depth: number): string => {
        if (item === null) return "null"
        if (item === undefined) return "undefined"
        if (typeof item === "string") return JSON.stringify(item)
        if (typeof item === "bigint") return `${item}n`
        if (typeof item === "number" || typeof item === "boolean") return String(item)
        if (typeof item === "symbol") return item.toString()
        if (typeof item === "function") return `[Function${item.name ? `: ${item.name}` : ""}]`
        if (typeof item !== "object") return ""
        if (item instanceof Error) return `${item.name}: ${item.message}`
        if (item instanceof Date) return item.toISOString()
        if (item instanceof RegExp) return item.toString()
        if (seen.has(item)) return "[Circular]"
        if (depth >= maxDepth) return Array.isArray(item) ? "[Array]" : "[Object]"
        seen.add(item)
        if (Array.isArray(item)) return `[ ${item.map((entry) => format(entry, depth + 1)).join(", ")} ]`
        if (item instanceof Set) return `Set(${item.size}) { ${[...item].map((entry) => format(entry, depth + 1)).join(", ")} }`
        if (item instanceof Map) return `Map(${item.size}) { ${[...item].map(([k, v]) => `${format(k, depth + 1)} => ${format(v, depth + 1)}`).join(", ")} }`
        const entries = Object.entries(item as Record<string, unknown>)
        if (entries.length === 0) return "{}"
        return `{ ${entries.map(([k, v]) => `${k}: ${format(v, depth + 1)}`).join(", ")} }`
    }
    return format(value, 0)
}

export const types = {
    isPromise: (value: unknown): value is Promise<unknown> => value instanceof Promise,
    isNativeError: (value: unknown): value is Error => value instanceof Error,
    isDate: (value: unknown): value is Date => value instanceof Date,
    isRegExp: (value: unknown): value is RegExp => value instanceof RegExp,
    isMap: (value: unknown): value is Map<unknown, unknown> => value instanceof Map,
    isSet: (value: unknown): value is Set<unknown> => value instanceof Set,
    isUint8Array: (value: unknown): value is Uint8Array => value instanceof Uint8Array,
    isArrayBufferView: (value: unknown): value is ArrayBufferView => ArrayBuffer.isView(value),
    isAnyArrayBuffer: (value: unknown): value is ArrayBuffer => value instanceof ArrayBuffer,
    isProxy: (_value: unknown): boolean => false,
}

export default { isDeepStrictEqual, inspect, types }
