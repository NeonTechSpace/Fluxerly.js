// Browser shims for node:fs, node:url, node:os and ws used only by metadata lookups or real-socket fallbacks
import { sdkMeta } from "./install-globals"

export function readFileSync(path: string | URL): string {
    const target = typeof path === "string" ? path : path.href
    if (target.endsWith("package.json")) {
        return JSON.stringify({ version: sdkMeta.version, homepage: sdkMeta.homepage })
    }
    throw new Error(`Filesystem access is unavailable in the browser sandbox (${target})`)
}

export function fileURLToPath(url: string | URL): string {
    const raw = typeof url === "string" ? url : url.href
    return raw.replace(/^file:\/\//, "")
}

export function platform(): string {
    return "linux"
}

const unavailable = (name: string) => () => {
    throw new Error(`${name} is unavailable in the offline browser sandbox`)
}

export const fork = unavailable("child_process.fork")
export const mkdir = unavailable("fs/promises.mkdir")
export const open = unavailable("fs/promises.open")
export const readFile = unavailable("fs/promises.readFile")
export const rename = unavailable("fs/promises.rename")
export const rm = unavailable("fs/promises.rm")

export function isAbsolute(value: string): boolean {
    return value.startsWith("/")
}

export function join(...parts: string[]): string {
    return parts.filter(Boolean).join("/").replace(/\/+/g, "/")
}

export function resolve(...parts: string[]): string {
    return join("/", ...parts)
}

export default class BrowserWebSocketStub {
    constructor() {
        throw new Error("Live external WebSocket connections are disabled in the offline browser sandbox. Use createTestBot or export a defineBot config instead")
    }
}
