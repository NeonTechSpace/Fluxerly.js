// Compile-only check, run by the test typecheck: A supervised child takes its token straight from an environment
// variable, like createClient and runBot, so an unset variable fails at run time with ConfigurationError
import { Effect } from "effect"
import { supervisor } from "../../src/index.js"
import { supervisor as nativeSupervisor } from "../../src/effect.js"

export function defaultChild(token: string | undefined) {
    return supervisor.child.run({ token, configure: () => undefined })
}

export function nativeChild(token: string | undefined) {
    return nativeSupervisor.child.run({ token, configure: () => Effect.void })
}
