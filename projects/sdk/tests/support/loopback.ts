import { once } from "node:events"
import { createServer } from "node:net"

let supported: Promise<boolean> | undefined

/** Whether this host routes all of 127.0.0.0/8 to loopback, as Linux and Windows do and macOS does not by default */
function wholeRange(): Promise<boolean> {
    supported ??= (async () => {
        const probe = createServer()
        try {
            probe.listen(0, "127.0.0.2")
            await once(probe, "listening")
            return true
        } catch {
            // allow-silent: Without the range, every fixture shares 127.0.0.1
            return false
        } finally {
            probe.close()
        }
    })()
    return supported
}

/**
 * A loopback address for one fixture server. Each server gets its own address in 127.0.0.0/8 where the host routes it,
 * so a request still in flight from another test or worker cannot reach a newer fixture that got the same port
 */
export async function fixtureHost(): Promise<string> {
    if (!(await wholeRange())) return "127.0.0.1"
    const octet = (low: number) => low + Math.floor(Math.random() * (255 - low))
    return `127.${octet(1)}.${octet(0)}.${octet(1)}`
}

/** Whether a URL's host is a loopback address, which fixture redirects accept */
export function isLoopbackHost(hostname: string): boolean {
    return hostname === "localhost" || hostname === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
}
