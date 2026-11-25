// Browser shims for the small set of Node.js globals that @neontechspace/fluxerly and createTestBot read.
// Runs before any SDK module evaluates inside the isolated playground iframe

declare const __FLUXERLY_SDK_VERSION__: string
declare const __FLUXERLY_SDK_HOMEPAGE__: string

export const sdkMeta = {
    version: typeof __FLUXERLY_SDK_VERSION__ === "string" ? __FLUXERLY_SDK_VERSION__ : "0.0.0",
    homepage: typeof __FLUXERLY_SDK_HOMEPAGE__ === "string" ? __FLUXERLY_SDK_HOMEPAGE__ : "https://fluxerly.neontechspace.com/",
}

type OutputListener = (stream: "stdout" | "stderr", chunk: string) => void
let outputListener: OutputListener | undefined

export function setProcessOutputListener(listener: OutputListener | undefined): void {
    outputListener = listener
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

function toHex(bytes: Uint8Array): string {
    let out = ""
    for (let index = 0; index < bytes.length; index++) out += bytes[index]!.toString(16).padStart(2, "0")
    return out
}

function toBase64(bytes: Uint8Array): string {
    let binary = ""
    for (let index = 0; index < bytes.length; index++) binary += String.fromCharCode(bytes[index]!)
    return btoa(binary)
}

function fromBase64(value: string): Uint8Array {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/")
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4)
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    return bytes
}

function fromHex(value: string): Uint8Array {
    const clean = value.length % 2 === 0 ? value : value.slice(0, -1)
    const bytes = new Uint8Array(clean.length / 2)
    for (let index = 0; index < bytes.length; index++) bytes[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16)
    return bytes
}

const Uint8Base = Uint8Array as unknown as {
    new (input: number | ArrayBuffer | ArrayBufferView | ArrayLike<number> | Iterable<number>): Uint8Array
    readonly prototype: Uint8Array
}

export class BrowserBuffer extends Uint8Base {
    static isBuffer(value: unknown): value is BrowserBuffer {
        return value instanceof BrowserBuffer
    }

    static byteLength(value: string | ArrayBufferView | ArrayBuffer): number {
        if (typeof value === "string") return textEncoder.encode(value).byteLength
        return value.byteLength
    }

    static alloc(size: number, fill?: number | string): BrowserBuffer {
        const buf = new BrowserBuffer(size)
        if (typeof fill === "number") buf.fill(fill)
        else if (typeof fill === "string" && fill.length > 0) {
            const pattern = textEncoder.encode(fill)
            for (let index = 0; index < size; index++) buf[index] = pattern[index % pattern.length]!
        }
        return buf
    }

    static allocUnsafe(size: number): BrowserBuffer {
        return new BrowserBuffer(size)
    }

    static from(input: string | ArrayBufferView | ArrayBuffer | readonly number[], encoding?: string): BrowserBuffer {
        if (typeof input === "string") {
            const enc = (encoding ?? "utf8").toLowerCase()
            const bytes = enc === "hex" ? fromHex(input) : enc === "base64" || enc === "base64url" ? fromBase64(input) : textEncoder.encode(input)
            return new BrowserBuffer(bytes)
        }
        if (input instanceof ArrayBuffer) return new BrowserBuffer(new Uint8Array(input))
        if (ArrayBuffer.isView(input)) return new BrowserBuffer(new Uint8Array(input.buffer, input.byteOffset, input.byteLength))
        return new BrowserBuffer(input)
    }

    static concat(chunks: readonly Uint8Array[], totalLength?: number): BrowserBuffer {
        const length = totalLength ?? chunks.reduce((sum, item) => sum + item.byteLength, 0)
        const out = new BrowserBuffer(length)
        let offset = 0
        for (const chunk of chunks) {
            if (offset >= length) break
            const slice = chunk.byteLength + offset > length ? chunk.subarray(0, length - offset) : chunk
            out.set(slice, offset)
            offset += slice.byteLength
        }
        return out
    }

    override toString(encoding = "utf8", start = 0, end = this.byteLength): string {
        const view = start === 0 && end === this.byteLength ? this : this.subarray(start, end)
        const enc = encoding.toLowerCase()
        if (enc === "hex") return toHex(view)
        if (enc === "base64") return toBase64(view)
        if (enc === "base64url") return toBase64(view).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
        return textDecoder.decode(view)
    }
}

// MessageChannel-backed macrotask queue so TestHarness.idle() settles in sub-millisecond turns without 4ms timer clamping
let nextImmediateId = 1
const immediateQueue = new Map<number, () => void>()
const channel = typeof MessageChannel === "function" ? new MessageChannel() : undefined
if (channel) {
    ;(channel.port1 as unknown as { unref?: () => void }).unref?.()
    ;(channel.port2 as unknown as { unref?: () => void }).unref?.()
    channel.port1.onmessage = (event: MessageEvent<number>) => {
        const id = event.data
        const callback = immediateQueue.get(id)
        if (!callback) return
        immediateQueue.delete(id)
        callback()
    }
}

export function scheduleImmediate(callback: (...args: unknown[]) => void, ...args: unknown[]): number {
    const id = nextImmediateId++
    immediateQueue.set(id, () => callback(...args))
    if (channel) channel.port2.postMessage(id)
    else
        globalThis.setTimeout(() => {
            const pending = immediateQueue.get(id)
            if (!pending) return
            immediateQueue.delete(id)
            pending()
        }, 0)
    return id
}

export function cancelImmediate(id: number): void {
    immediateQueue.delete(id)
}

const g = globalThis as Record<string, unknown>

if (typeof g.Buffer === "undefined") g.Buffer = BrowserBuffer
if (typeof g.setImmediate === "undefined") g.setImmediate = scheduleImmediate
if (typeof g.clearImmediate === "undefined") g.clearImmediate = cancelImmediate

if (typeof g.process === "undefined") {
    const noop = () => g.process
    g.process = {
        env: { FLUXERLY_LOG_COLOR: "false" },
        platform: "linux",
        versions: { node: "26.13.1" },
        exitCode: undefined as number | undefined,
        stdout: {
            isTTY: false,
            write(chunk: unknown) {
                outputListener?.("stdout", String(chunk))
                return true
            },
        },
        stderr: {
            isTTY: false,
            write(chunk: unknown) {
                outputListener?.("stderr", String(chunk))
                return true
            },
        },
        nextTick(fn: (...args: unknown[]) => void, ...args: unknown[]) {
            queueMicrotask(() => fn(...args))
        },
        on: noop,
        once: noop,
        off: noop,
        addListener: noop,
        removeListener: noop,
    }
}
