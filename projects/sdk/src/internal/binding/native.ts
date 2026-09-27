/**
 * Native binder: Adapts each operation table entry to the Effect API.
 * Invariant: Native operation members return the shared Effect unchanged, so they start nothing until the caller runs them and
 * keep the caller's context, scope and interruption. Cache lookups read a closed client as absent and make misuse a defect,
 * pure calculations return their value directly, and page entries become lazy Streams that release their traversal when
 * consumption ends. Implements [SDK contracts: Public API model](/docs/SDK-CONTRACTS.md#public-api-model)
 */
import * as Effect from "effect/Effect"
import type { MessageCore } from "#sdk/messages"
import type { PaginationError } from "#sdk/pagination"
import type { ClientOwner } from "#sdk/internal/client"
import { paginationStream, type Pagination } from "#sdk/internal/pagination"
import { isClientClosed, localValue } from "./execute.js"
import { eachEntry, operationTable, type OperationTable } from "./operations.js"

type Run<E> = E extends { readonly run: (owner: never, ...args: infer P) => infer R } ? [P, R] : never

/** The native API member built from one table entry */
export type NativeMember<E> = E extends { readonly kind: "op" | "lookup" }
    ? Run<E> extends [infer P extends readonly unknown[], infer R]
        ? (...args: P) => R
        : never
    : E extends { readonly kind: "get" }
      ? Run<E> extends [infer P extends readonly unknown[], Effect.Effect<infer A, unknown>]
          ? (...args: P) => Effect.Effect<A>
          : never
      : E extends { readonly kind: "pure" }
        ? Run<E> extends [infer P extends readonly unknown[], Effect.Effect<infer A, unknown>]
            ? (...args: P) => A
            : never
        : E extends { readonly kind: "page" }
          ? Run<E> extends [
                infer P extends readonly unknown[],
                Effect.Effect<Pagination<infer A, infer F>, PaginationError>,
            ]
              ? (...args: P) => ReturnType<typeof paginationStream<A, F>>
              : never
          : E extends { readonly native: (owner: never) => infer N }
            ? N
            : never

/** The native namespaces derived from the operation table */
export type NativeNamespaces<T> = {
    readonly [NS in keyof T]: { readonly [K in keyof T[NS]]: NativeMember<T[NS][K]> }
}

/** Build every native namespace object for one client from the operation table */
export function bindNative<M extends MessageCore>(owner: ClientOwner<M>): NativeNamespaces<OperationTable<M>> {
    const namespaces = eachEntry(operationTable<M>(), (entry, id) => {
        switch (entry.kind) {
            case "op":
            case "lookup":
                return (...args: readonly unknown[]) => entry.run(owner, ...args)
            case "get":
                // A closed client has no cache, and input misuse is a defect rather than a typed failure
                return (...args: readonly unknown[]) =>
                    entry.run(owner, ...args).pipe(
                        Effect.catchIf(isClientClosed, () => Effect.succeed(undefined)),
                        Effect.orDie,
                    )
            case "pure":
                return (...args: readonly unknown[]) => localValue(entry.run(owner, ...args), id)
            case "page":
                return (...args: readonly unknown[]) => paginationStream(entry.run(owner, ...args))
            case "stream":
            case "custom":
                return entry.native(owner)
        }
    })
    // The table's derived member types are checked against the public interfaces by tests/types/binding-parity.ts
    return namespaces as unknown as NativeNamespaces<OperationTable<M>>
}
