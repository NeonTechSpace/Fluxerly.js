// Effect scenario scope closure shared by live harnesses that run a whole scenario inside one scope
import { Cause, Effect, Exit, Scope } from "effect"

/**
 * Closes `scope` with the scenario's exit, or a successful exit when the scenario produced none.
 * Returns the exit the harness should assert and whether the scope closed. A failed close is never hidden: it becomes
 * the result, combined with the scenario failure when there was one, so neither cause is lost
 */
export async function closeScenarioScope(scope, exit) {
    const scenarioExit = exit ?? Exit.void
    const scopeExit = await Effect.runPromiseExit(Scope.close(scope, scenarioExit))
    if (Exit.isSuccess(scopeExit)) return { exit: scenarioExit, closed: true }
    return {
        exit: Exit.isFailure(scenarioExit)
            ? Exit.failCause(Cause.combine(scenarioExit.cause, scopeExit.cause))
            : scopeExit,
        closed: false,
    }
}
