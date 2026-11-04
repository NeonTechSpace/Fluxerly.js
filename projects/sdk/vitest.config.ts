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
    "tests/perf/**/*.test.ts",
]

// A job summary holds one Vitest report per run, so each names the tests it ran. --project picks one of the two stages below
const stages: Record<string, string> = { sdk: "unit tests", processes: "process tests" }
const selected = process.argv.flatMap((argument, index, all) => {
    if (argument === "--project") return all[index + 1] ?? []
    return argument.startsWith("--project=") ? argument.slice("--project=".length) : []
})
const testSet =
    selected.length > 0 ? selected.map((name) => stages[name] ?? name).join(" and ") : "unit and process tests"

export default {
    ssr: {
        resolve: {
            conditions: ["fluxerly-source", "node", "development|production"],
        },
    },
    test: {
        // Outside GitHub Actions, Vitest keeps its own reporter choice. The github-actions reporter writes the job summary
        reporters:
            process.env.GITHUB_ACTIONS === "true"
                ? ["default", ["github-actions", { jobSummary: { title: `SDK ${testSet}: Vitest results` } }]]
                : undefined,
        maxWorkers: workers,
        // The examples' tests use node:test, as a bot project's own tests do, and run in the test:examples script
        exclude: ["**/node_modules/**", "**/.git/**", "examples/**"],
        // SDK log output is captured per test and printed only when that test fails. A vi.waitFor poll without its own
        // timeout is bounded by the test timeout instead of Vitest's one-second default. No test may reach a Fluxer host
        setupFiles: [
            "tests/support/quiet-output.ts",
            "tests/support/wait-deadline.ts",
            "tests/support/no-fluxer-network.ts",
        ],
        projects: [
            {
                extends: true,
                test: { name: "sdk", exclude: ["**/node_modules/**", "**/.git/**", "examples/**", ...processTests] },
            },
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
