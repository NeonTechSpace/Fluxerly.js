import { preview } from "astro"

// Use Astro's API so Playwright owns the server, even in an agent-enabled shell
const server = await preview({
    ...(process.env.DOCS_TEST_OUTPUT_DIR ? { outDir: process.env.DOCS_TEST_OUTPUT_DIR } : {}),
    server: { host: "127.0.0.1", port: 4322 },
})
for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, async () => {
        await server.stop()
        process.exit(0)
    })
}
