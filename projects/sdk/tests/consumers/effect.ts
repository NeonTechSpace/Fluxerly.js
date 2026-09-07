import { Effect, type Scope } from "effect"
import { createClient, type Client, type ConfigurationError } from "@neontechspace/fluxerly/effect"

export function createWithinCallerScope(token: string): Effect.Effect<Client, ConfigurationError, Scope.Scope> {
    return createClient({ token })
}

export const handled = createClient({ token: "" }).pipe(
    Effect.catchTag("ConfigurationError", (error) => Effect.succeed(error.field)),
    Effect.scoped,
)

export function rejectedTypeShapes(): void {
    // @ts-expect-error Creation requires a caller-owned scope
    Effect.runSync(createClient({ token: "fixture-only-not-a-credential" }))
    // @ts-expect-error Only declared expected error tags can be handled here
    createClient({ token: "" }).pipe(Effect.catchTag("UnknownError", () => Effect.void))
}

export const managed = Effect.scoped(
    Effect.gen(function* () {
        const client = yield* createClient({ token: "fixture" })
        yield* client.run()
    }),
).pipe(Effect.catchTag("AuthenticationError", () => Effect.void))
