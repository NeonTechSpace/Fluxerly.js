import { defineConfig } from "@playwright/test"

export default defineConfig({
    testDir: "./tests/browser",
    testMatch: process.env.DOCS_TEST_VERSIONS ? "**/versions.spec.ts" : ["**/docs.spec.ts", "**/reference-previews.spec.ts", "**/example-languages.spec.ts"],
    outputDir: process.env.DOCS_TEST_VERSIONS ? "./test-results/versions" : "./test-results/reading",
    timeout: 45_000,
    retries: 0,
    workers: 1,
    reporter: "list",
    use: {
        baseURL: "http://127.0.0.1:4322",
        browserName: "chromium",
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
    },
    webServer: {
        command: "node tests/serve.mjs",
        url: "http://127.0.0.1:4322",
        reuseExistingServer: false,
        timeout: 30_000,
    },
})
