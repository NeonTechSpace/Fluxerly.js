import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs"
import { join } from "node:path"

function present(value) {
    return typeof value === "string" && value.trim() !== ""
}

function removeInheritedAuthentication(env) {
    const names = new Set(["NPM_TOKEN", "NODE_AUTH_TOKEN", "NPM_CONFIG_USERCONFIG"])
    for (const name of Object.keys(env)) {
        if (names.has(name.toUpperCase())) delete env[name]
    }
}

function cleanup(config, directory) {
    try { unlinkSync(config) } catch (error) { if (error.code !== "ENOENT") throw error }
    rmdirSync(directory)
}

// GitHub OIDC is the only automated publication authentication path
export function withReleaseAuthentication(source, run) {
    const env = { ...source }
    const url = env.ACTIONS_ID_TOKEN_REQUEST_URL
    const token = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
    if (env.GITHUB_ACTIONS !== "true")
        throw new Error("GitHub OIDC is required for automated publication")
    if (!present(url) || !present(token))
        throw new Error("GitHub OIDC configuration is incomplete, refusing token fallback")
    if (!env.RUNNER_TEMP) throw new Error("Release authentication requires RUNNER_TEMP")
    const directory = mkdtempSync(join(env.RUNNER_TEMP, "release-auth-"))
    const config = join(directory, "npmrc")
    const lines = ["registry=https://registry.npmjs.org/"]
    removeInheritedAuthentication(env)
    env.NPM_CONFIG_USERCONFIG = config
    let result
    try {
        writeFileSync(config, lines.join("\n") + "\n", { flag: "wx", mode: 0o600 })
        result = run(env)
        if (result && typeof result.then === "function")
            return Promise.resolve(result).finally(() => cleanup(config, directory))
    } catch (error) {
        cleanup(config, directory)
        throw error
    }
    cleanup(config, directory)
    return result
}
