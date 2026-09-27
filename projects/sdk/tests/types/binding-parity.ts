// Compile-only check, run by the test typecheck: Every member type the binders derive from the operation table must be
// identical to the member of the hand-written namespace interface that the public declarations show. It uses the same
// normalization and strict comparator as the default/native parity check in tests/contract/fixtures/public-client-parity.
// The derived default members type their options without the default signal field, which the normalization omits
import type { Client as DefaultClient, Message } from "../../src/index.js"
import type { Client as NativeClient } from "../../src/effect.js"
import type { DefaultNamespaces } from "../../src/internal/binding/default.js"
import type { NativeNamespaces } from "../../src/internal/binding/native.js"
import type { OperationTable } from "../../src/internal/binding/operations.js"
import type { AssertNever, Equal, NormalizeMember } from "../contract/fixtures/public-client-parity/compare.js"

type Table = OperationTable<Message>

/** Names every derived `namespace.member` whose type differs from the public one or has no public counterpart */
type Mismatches<Derived, Public> =
    | Exclude<keyof Derived, keyof Public>
    | {
          [K in keyof Derived & keyof Public]: {
              [M in keyof Derived[K] | keyof Public[K]]: M extends keyof Derived[K]
                  ? M extends keyof Public[K]
                      ? Equal<NormalizeMember<Derived[K][M]>, NormalizeMember<Public[K][M]>> extends true
                          ? never
                          : `${K & string}.${M & string}`
                      : `${K & string}.${M & string}`
                  : `${K & string}.${M & string}`
          }[keyof Derived[K] | keyof Public[K]]
      }[keyof Derived & keyof Public]

export type DefaultBindingParity = AssertNever<Mismatches<DefaultNamespaces<Table>, DefaultClient<Message>>>
export type NativeBindingParity = AssertNever<Mismatches<NativeNamespaces<Table>, NativeClient<Message>>>
