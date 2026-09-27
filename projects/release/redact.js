// @ts-check

// Values of these variables are replaced wherever they appear in surfaced provider output
const secretVariables = [
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "ACTIONS_RUNTIME_TOKEN",
    "CLOUDFLARE_API_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "NODE_AUTH_TOKEN",
    "NPM_TOKEN",
]

/** @type {Array<[RegExp, string]>} */
const tokenPatterns = [
    [/\bnpm_[A-Za-z0-9]{20,}/g, "[redacted]"],
    [/\bgh[opsur]_[A-Za-z0-9]{20,}/g, "[redacted]"],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[redacted]"],
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted]"],
    [/\b(authorization:\s*(?:bearer|token|basic)\s+)\S+/gi, "$1[redacted]"],
    [/(_auth(?:Token)?\s*=\s*)\S+/gi, "$1[redacted]"],
    [/(\/\/[^\s/@:]+:[^\s/@]+@)/g, "//[redacted]@"],
]

/**
 * Removes token-like values and known secret variable values from provider output before it is logged
 * @param {unknown} text
 * @param {NodeJS.ProcessEnv} [env]
 */
export function redact(text, env = process.env) {
    let result = String(text)
    for (const name of secretVariables) {
        const value = env[name]
        if (typeof value === "string" && value.length >= 8) result = result.split(value).join("[redacted]")
    }
    for (const [pattern, replacement] of tokenPatterns) result = result.replace(pattern, replacement)
    return result
}

/**
 * Forwards a child stream to a writable line by line so that a token is never split across redaction calls
 * @param {NodeJS.ReadableStream | null | undefined} source
 * @param {{ write(text: string): unknown }} target
 * @param {NodeJS.ProcessEnv} [env]
 */
export function forwardRedacted(source, target, env = process.env) {
    if (!source) return
    let pending = ""
    source.setEncoding("utf8")
    source.on("data", (chunk) => {
        pending += chunk
        const lines = pending.split("\n")
        pending = lines.pop() ?? ""
        for (const line of lines) target.write(redact(line, env) + "\n")
    })
    source.on("end", () => {
        if (pending) target.write(redact(pending, env) + "\n")
        pending = ""
    })
}
