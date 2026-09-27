import type { Exit, Scope } from "effect"

export function closeScenarioScope<A, E>(
    scope: Scope.Closeable,
    exit: Exit.Exit<A, E> | undefined,
): Promise<{ readonly exit: Exit.Exit<unknown, unknown>; readonly closed: boolean }>
