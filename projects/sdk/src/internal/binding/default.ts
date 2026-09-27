/**
 * Default binder: Adapts each operation table entry to the default API's neverthrow results and async iterators.
 * Invariant: Operations start when called, lookups settle synchronously, and page iterators start when a loop pulls
 * them. Every call provides the client's logger and keeps the options argument's signal ownership rules.
 * Implements [SDK contracts: Public API model](/docs/SDK-CONTRACTS.md#public-api-model)
 */
import * as Effect from "effect/Effect"
import { err, ok, type Result, type ResultAsync } from "neverthrow"
import { ConfigurationError, type CancelledError, type ClientClosedError, type Operation } from "#sdk/errors"
import type { DefaultMessageOperationOptions, MessageCore } from "#sdk/messages"
import { PaginationError, type PaginationOperation } from "#sdk/pagination"
import type { OperationOptions } from "#sdk/client"
import { InputValidationFailure } from "#sdk/input-validation"
import type { ClientOwner } from "#sdk/internal/client"
import { readInput } from "#sdk/internal/defects"
import { operationSignalError } from "#sdk/internal/operation-signal"
import { iterationOptions, type Pagination } from "#sdk/internal/pagination"
import { executeOperation, localValue, lookup, type DefaultContext, type OperationFailure } from "./execute.js"
import { eachEntry, operationTable, type OperationTable } from "./operations.js"

type Run<E> = E extends { readonly run: (owner: never, ...args: infer P) => infer R } ? [P, R] : never

/** The default API member built from one table entry */
export type DefaultMember<E> = E extends { readonly kind: "op" }
    ? Run<E> extends [infer P extends readonly unknown[], Effect.Effect<infer A, infer F>]
        ? (...args: P) => ResultAsync<A, F | CancelledError | ConfigurationError>
        : never
    : E extends { readonly kind: "lookup" }
      ? Run<E> extends [infer P extends readonly unknown[], Effect.Effect<infer A, infer F>]
          ? (...args: P) => Result<A, F>
          : never
      : E extends { readonly kind: "get" | "pure" }
        ? Run<E> extends [infer P extends readonly unknown[], Effect.Effect<infer A, unknown>]
            ? (...args: P) => A
            : never
        : E extends { readonly kind: "page" }
          ? Run<E> extends [
                infer P extends readonly unknown[],
                Effect.Effect<Pagination<infer A, infer F>, PaginationError>,
            ]
              ? (
                    ...args: P
                ) => AsyncIterable<
                    Result<A, F | PaginationError | CancelledError | ConfigurationError | ClientClosedError>
                >
              : never
          : E extends { readonly default: (context: never) => infer D }
            ? D
            : never

/** The default namespaces derived from the operation table */
export type DefaultNamespaces<T> = {
    readonly [NS in keyof T]: { readonly [K in keyof T[NS]]: DefaultMember<T[NS][K]> }
}

/** Create the executors that tie default operations to one client's logger */
export function defaultContext<M extends MessageCore>(owner: ClientOwner<M>): DefaultContext<M> {
    const execute = <A, E extends OperationFailure>(
        effect: Effect.Effect<A, E>,
        operation: Operation,
        options?: OperationOptions,
    ) => executeOperation(owner.logging.provide(effect), operation, options)
    const iterate = <A, E extends OperationFailure>(
        create: (options: DefaultMessageOperationOptions) => Effect.Effect<Pagination<A, E>, PaginationError>,
        operation: PaginationOperation,
        options?: DefaultMessageOperationOptions,
    ): AsyncIterable<Result<A, E | PaginationError | CancelledError | ConfigurationError | ClientClosedError>> =>
        Object.freeze({
            async *[Symbol.asyncIterator]() {
                const opened = await execute(
                    Effect.gen(function* () {
                        // Read the caller options and signal once, where a throw is an application fault
                        const copied = yield* readInput(() => {
                            const signal = (options as { readonly signal?: OperationOptions["signal"] } | undefined)
                                ?.signal
                            return operationSignalError(signal) ?? iterationOptions(options, signal)
                        })
                        if (copied instanceof ConfigurationError) return yield* Effect.fail(copied)
                        if (copied instanceof InputValidationFailure)
                            return yield* Effect.fail(
                                new PaginationError({ operation, reason: "input", inputValidation: copied.detail }),
                            )
                        const source = yield* create(copied.request)
                        return { source, signal: copied.signal }
                    }),
                    operation,
                )
                if (opened.isErr()) {
                    yield err(opened.error)
                    return
                }
                const { source, signal } = opened.value
                try {
                    while (!source.done) {
                        const result = await execute(
                            source.next,
                            operation,
                            signal === undefined ? undefined : { signal },
                        )
                        if (result.isErr()) {
                            source.close()
                            yield err(result.error)
                            return
                        }
                        if (result.value === undefined) return
                        yield ok(result.value)
                    }
                } finally {
                    source.close()
                }
            },
        })
    return Object.freeze({ owner, execute, iterate })
}

/** Build every default namespace object for one client from the operation table */
export function bindDefault<M extends MessageCore>(context: DefaultContext<M>): DefaultNamespaces<OperationTable<M>> {
    const { owner } = context
    const namespaces = eachEntry(operationTable<M>(), (entry, id) => {
        switch (entry.kind) {
            case "op":
                return (...args: readonly unknown[]) =>
                    context.execute(
                        entry.run(owner, ...args) as Effect.Effect<unknown, OperationFailure>,
                        id,
                        args[entry.optionsAt] as OperationOptions | undefined,
                    )
            case "lookup":
                return (...args: readonly unknown[]) => lookup(entry.run(owner, ...args), id)
            case "get":
                return (...args: readonly unknown[]) => localValue(entry.run(owner, ...args), id, true)
            case "pure":
                return (...args: readonly unknown[]) => localValue(entry.run(owner, ...args), id)
            case "page":
                return (...args: readonly unknown[]) =>
                    context.iterate(
                        (request) =>
                            entry.run(
                                owner,
                                // Keep the options position even when the caller omitted earlier optional arguments
                                ...Array.from({ length: entry.optionsAt }, (_, index) => args[index]),
                                request,
                                ...args.slice(entry.optionsAt + 1),
                            ) as Effect.Effect<Pagination<unknown, OperationFailure>, PaginationError>,
                        id as PaginationOperation,
                        args[entry.optionsAt] as DefaultMessageOperationOptions | undefined,
                    )
            case "stream":
            case "custom":
                return entry.default(context)
        }
    })
    // The table's derived member types are checked against the public interfaces by tests/types/binding-parity.ts
    return namespaces as unknown as DefaultNamespaces<OperationTable<M>>
}
