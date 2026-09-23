import { availableParallelism } from "node:os"

export default {
    ssr: {
        resolve: {
            conditions: ["fluxerly-source", "node", "development|production"],
        },
    },
    test: {
        // Compiler-backed inventories compete for CPU and memory with deadline-sensitive runtime tests
        maxWorkers: Math.min(4, availableParallelism()),
        exclude: ["**/node_modules/**", "**/.git/**", "tests/experiments/**"],
    },
}
