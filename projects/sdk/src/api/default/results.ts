import type { Result } from "neverthrow"

/**
 * Return the value of an Ok result, or throw the error of an Err result.
 * Use it where a failure should end the surrounding function, such as a command handler whose thrown error is
 * reported with the command name, or a startup script that should stop with the SDK's message and hint.
 * The thrown value is the operation's own error, so its message, hint, code and cause remain available
 *
 * @remarks
 * A ResultAsync, or any promise of a Result, returns a Promise that resolves with the value or rejects with the error.
 * Keep checking isErr() where the application must recover from a particular failure instead
 *
 * @example
 * ```ts
 * import { orThrow, type Client } from "@neontechspace/fluxerly"
 *
 * export async function greet(client: Client, channelId: string) {
 *     const message = orThrow(await client.messages.send(channelId, { content: "Hello" }))
 *     return orThrow(client.messages.edit(message, { content: "Hello again" }))
 * }
 * ```
 *
 * @category Errors
 */
export function orThrow<T, E>(result: Result<T, E>): T
/**
 * Wait for a ResultAsync, or any promise of a Result, and resolve with its value or reject with its error
 *
 * @category Errors
 */
export function orThrow<T, E>(result: PromiseLike<Result<T, E>>): Promise<T>
export function orThrow<T, E>(result: Result<T, E> | PromiseLike<Result<T, E>>): T | Promise<T> {
    if (isPromiseLike(result)) return Promise.resolve(result).then(unwrap)
    return unwrap(result)
}

function unwrap<T, E>(result: Result<T, E>): T {
    if (result.isErr()) throw result.error
    return result.value
}

function isPromiseLike<A>(value: A | PromiseLike<A>): value is PromiseLike<A> {
    return typeof (value as { then?: unknown }).then === "function"
}
