import { availableParallelism } from "node:os"

export default {
    ssr: {
        resolve: {
            conditions: ["fluxerly-source", "node", "development|production"],
        },
    },
    test: {
        // Compiler-backed shape checks compete for CPU and memory with deadline-sensitive runtime tests.
        // VITEST_MAX_WORKERS overrides the limit for local investigation
        maxWorkers: Number(process.env.VITEST_MAX_WORKERS) || Math.min(4, availableParallelism()),
        exclude: ["**/node_modules/**", "**/.git/**"],
        // SDK log output is captured per test and printed only when that test fails
        setupFiles: ["tests/support/quiet-output.ts"],
    },
}
