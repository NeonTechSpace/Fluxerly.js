import { availableParallelism } from "node:os"

// Local runs share the machine with other work, so they use half the threads, at most four. CI runners are dedicated.
// VITEST_MAX_WORKERS overrides the limit for local investigation
const workers =
    Number(process.env.VITEST_MAX_WORKERS) ||
    (process.env.CI ? availableParallelism() : Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2))))

// These files start child processes, so each worker can occupy several threads. They run as a second stage with one
// worker fewer, which keeps the host from saturating without slowing the rest of the suite
const processTests = [
    "tests/client/supervisor/**/*.test.ts",
    "tests/client/transport-process.test.ts",
    "tests/live/**/*.test.{ts,js}",
    "tests/resources/cache/resource-cache-runtime.test.ts",
    "tests/resources/pagination/pagination-runtime.test.ts",
]

export default {
    ssr: {
        resolve: {
            conditions: ["fluxerly-source", "node", "development|production"],
        },
    },
    test: {
        maxWorkers: workers,
        exclude: ["**/node_modules/**", "**/.git/**"],
        // SDK log output is captured per test and printed only when that test fails. A vi.waitFor poll without its own
        // timeout is bounded by the test timeout instead of Vitest's one-second default
        setupFiles: ["tests/support/quiet-output.ts", "tests/support/wait-deadline.ts"],
        projects: [
            { extends: true, test: { name: "sdk", exclude: ["**/node_modules/**", "**/.git/**", ...processTests] } },
            {
                extends: true,
                test: {
                    name: "processes",
                    include: processTests,
                    maxWorkers: Math.max(1, workers - 1),
                    // Worker limits differ from the first stage, so Vitest requires a separate group
                    sequence: { groupOrder: 1 },
                },
            },
        ],
    },
}
