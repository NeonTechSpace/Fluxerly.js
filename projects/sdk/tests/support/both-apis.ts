import { Effect, Exit, Scope } from "effect"
import { describe, onTestFinished } from "vitest"
import {
    createClient,
    type Client,
    type ClientOptions,
    type MessageFields,
    type SelectedMessage,
} from "../../src/index.js"
import { createClient as createNative, type Client as NativeClient } from "../../src/effect.js"
import { fixtureToken } from "../../src/internal/testing/fixtures.js"

/** The two public API styles that share one implementation and must stay behaviourally equivalent */
export const modes = ["default", "native"] as const
export type Mode = (typeof modes)[number]

/** A token-shaped value that is never a credential, shared with the public testing entry points */
export { fixtureToken }

/** Client options with an optional token, which defaults to fixtureToken. F selects message fields as in createClient */
export type FixtureClientOptions<F extends MessageFields | undefined = undefined> = Omit<ClientOptions<F>, "token"> & {
    readonly token?: string
}

/**
 * Create a default client that shuts down when the current test finishes.
 * A failed shutdown fails the test, so a migrated test keeps checking that cleanup succeeds
 */
export function defaultApi<const F extends MessageFields | undefined = undefined>(
    options: FixtureClientOptions<F> = {} as FixtureClientOptions<F>,
): Client<SelectedMessage<F>> {
    const client = createClient<F>({ token: fixtureToken, ...options } as ClientOptions<F>)
    onTestFinished(async () => {
        const closed = await client.shutdown()
        if (closed.isErr()) throw closed.error
    })
    return client
}

/**
 * Create a native client in a test-owned Scope that shuts down and closes when the current test finishes.
 * A failed shutdown or scope close fails the test
 */
export async function nativeApi<const F extends MessageFields | undefined = undefined>(
    options: FixtureClientOptions<F> = {} as FixtureClientOptions<F>,
): Promise<NativeClient<SelectedMessage<F>>> {
    const scope = Scope.makeUnsafe()
    const client = await Effect.runPromise(
        createNative<never, never, F>({ token: fixtureToken, ...options } as never).pipe(Scope.provide(scope)),
    )
    onTestFinished(async () => {
        await Effect.runPromise(client.shutdown())
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    return client
}

/** Create a client for one API style. Pair its operations with settle() to run either style */
export async function setup<const F extends MessageFields | undefined = undefined>(
    mode: Mode,
    options: FixtureClientOptions<F> = {} as FixtureClientOptions<F>,
): Promise<Client<SelectedMessage<F>> | NativeClient<SelectedMessage<F>>> {
    return mode === "default" ? defaultApi<F>(options) : nativeApi<F>(options)
}

/** Declare the same tests once for each API style */
export function describeBothApis(name: string, body: (mode: Mode) => void) {
    describe.each(modes)(`%s ${name}`, body)
}
