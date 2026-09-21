import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"

// Exercise the deployment worker, not Astro's static meta-refresh fallback
const require = createRequire(import.meta.url)
const cli = join(dirname(require.resolve("wrangler/package.json")), "bin/wrangler.js")
const server = spawn(process.execPath, [cli, "pages", "dev",
    resolve(process.env.DOCS_TEST_OUTPUT_DIR ?? "dist"),
    "--ip", "127.0.0.1", "--port", "4322", "--inspector-port", "0",
    "--compatibility-date", "2026-09-18", "--show-interactive-dev-session=false",
], { stdio: "inherit", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } })
server.once("error", (error) => { console.error(error.message); process.exitCode = 1 })
server.once("exit", (code) => { process.exitCode = code ?? 1 })
for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => server.kill(signal))
}
