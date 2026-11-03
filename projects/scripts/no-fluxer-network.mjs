// Loaded by every offline test suite, so no test can reach Fluxer: a request to a Fluxer host throws before it connects,
// and the process ends with an error even when the code under test catches it. The live tests, which talk to Fluxer on
// purpose, don't load it. Fetch is checked by its URL and every other client by the socket it opens, which covers
// http, https, WebSocket clients and anything else built on node:net or node:tls
import http from "node:http"
import https from "node:https"
import net from "node:net"
import tls from "node:tls"
import { syncBuiltinESMExports } from "node:module"

const fluxerDomains = ["fluxer.app", "fluxer.com", "fluxer.gg", "fluxerusercontent.com", "fluxerstatic.com"]

/** Whether a host name is Fluxer's or one of its subdomains */
export function isFluxerHost(host) {
    const name = String(host ?? "").toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "")
    return fluxerDomains.some((domain) => name === domain || name.endsWith(`.${domain}`))
}

/** Every request this process tried to send to Fluxer, for a test runner hook to fail on */
export const blockedFluxerRequests = []

function refuse(target) {
    const message = `Offline tests must not reach Fluxer, but this test tried to connect to ${target}. Give it a fake transport or a local server`
    blockedFluxerRequests.push(target)
    process.exitCode = 1
    console.error(message)
    return new Error(message)
}

const hostOf = (args) => {
    const [first, second] = args
    if (typeof first === "string" || first instanceof URL) {
        // A URL for http and https, a port or a socket path for net
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(String(first))) return new URL(String(first)).hostname
        return typeof second === "string" ? second : undefined
    }
    if (typeof first === "number") return typeof second === "string" ? second : undefined
    return first?.hostname ?? first?.host ?? first?.servername
}

function guard(module, name) {
    const original = module[name]
    module[name] = function (...args) {
        const host = hostOf(args)
        if (isFluxerHost(host)) throw refuse(host)
        return original.apply(this, args)
    }
}

for (const [module, names] of [
    [net, ["connect", "createConnection"]],
    [tls, ["connect"]],
    [http, ["request", "get"]],
    [https, ["request", "get"]],
])
    for (const name of names) guard(module, name)
syncBuiltinESMExports()

const realFetch = globalThis.fetch
globalThis.fetch = function (input, init) {
    const url = input instanceof Request ? input.url : String(input)
    let host
    try {
        host = new URL(url).hostname
    } catch {
        host = undefined
    }
    if (isFluxerHost(host)) return Promise.reject(refuse(url))
    return realFetch.call(this, input, init)
}
