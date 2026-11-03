// Compile-only check, run by the test typecheck: The services of router-level command callbacks reach the requirements
// of a standalone router and of runBot, defineBot and createTestBot, even when callbacks need different services, fail
// with different errors or the options are an annotated union whose members have different callbacks. tests/types/tsconfig.starter.json compiles it
// again without exactOptionalPropertyTypes, as projects created by the starter do
import { Context, Data, Effect, type Scope } from "effect"
import {
    commands,
    defineBot,
    runBot,
    type CommandRequirements,
    type CooldownStore,
    type Message,
    type MessageCore,
    type PrefixCommandGuard,
    type PrefixCommandRejectionFeedback,
    type PrefixCommandRouter,
} from "../../src/effect.js"
import { createTestBot } from "../../src/effect-testing.js"

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T
type Requirements<T> = T extends Effect.Effect<unknown, unknown, infer R> ? Exclude<R, Scope.Scope> : never
type RouterServices<T> = T extends PrefixCommandRouter<infer R, MessageCore> ? R : never

class Database extends Context.Service<Database, { readonly prefix: Effect.Effect<string> }>()("Database") {}
class Metrics extends Context.Service<Metrics, { readonly count: Effect.Effect<void> }>()("Metrics") {}
class Audit extends Context.Service<Audit, { readonly note: Effect.Effect<void> }>()("Audit") {}

// A prefix resolver and onUnmatched that need different services make a router that requires both
export const mixed = commands.create({
    prefix: () => Database.use((database) => database.prefix),
    onUnmatched: () => Metrics.use((metrics) => metrics.count),
})
export const mixedRequires: Assert<Equal<RouterServices<typeof mixed>, Database | Metrics>> = true

// Every router-level callback adds its services, and registered commands add theirs on top
export const everyCallback = commands
    .create({
        prefix: "!",
        onReject: () => Database.use((database) => database.prefix),
        use: [
            (_context, next) =>
                Effect.andThen(
                    Metrics.use((metrics) => metrics.count),
                    next,
                ),
        ],
        onUnmatched: () => Effect.void,
    })
    .register({ name: "note", execute: () => Audit.use((audit) => audit.note) })
export const everyCallbackRequires: Assert<Equal<RouterServices<typeof everyCallback>, Database | Metrics | Audit>> =
    true

// Callbacks without services and a text prefix require nothing, so the router attaches without providing services
export const plain = commands.create({ prefix: "!", onReject: "reply", onUnmatched: () => Effect.void })
export const plainRequires: Assert<Equal<RouterServices<typeof plain>, never>> = true

// Explicit type arguments keep compiling and still name what the router requires
export const explicitUnion = commands.create<never, Database | Metrics>({
    prefix: () => Database.use((database) => database.prefix),
    onUnmatched: () => Metrics.use((metrics) => metrics.count),
})
export const explicitUnionRequires: Assert<Equal<RouterServices<typeof explicitUnion>, Database | Metrics>> = true
export const explicitMessage = commands.create<never, never, MessageCore>({
    prefix: (message) => (message.content.startsWith("?") ? "?" : "!"),
})
export const explicitMessageType: Assert<Equal<typeof explicitMessage, PrefixCommandRouter<never, MessageCore>>> = true
export const defaultMessageType: Assert<Equal<typeof plain, PrefixCommandRouter<never, Message>>> = true

// An explicit R limits every callback to its services, so one that needs more is rejected
export const tooNarrow = commands.create<never, Database>({
    prefix: () => Database.use((database) => database.prefix),
    // @ts-expect-error Metrics is not in the explicit services
    // @effect-diagnostics-next-line missingEffectContext:off
    onUnmatched: () => Metrics.use((metrics) => metrics.count),
})

// A misspelled option is still rejected
// @ts-expect-error onUnmatchd is not an option of commands.create
export const misspelled = commands.create({ prefix: "!", onUnmatchd: () => Effect.void })

// An annotated union of options, where only some members have a callback, keeps every member's services
const definitions = { ping: { execute: () => Effect.void } }
type UnionOptions =
    | {
          readonly prefix: string
          readonly commands: typeof definitions
          readonly onError: () => Effect.Effect<void, never, Database>
      }
    | {
          readonly prefix: string
          readonly commands: typeof definitions
          readonly onUnmatched: () => Effect.Effect<void, never, Metrics>
      }
declare const unionOptions: UnionOptions

export const direct = runBot({ token: undefined, commands: unionOptions })
export const directRequires: Assert<Equal<Requirements<typeof direct>, Database | Metrics>> = true
export const tested = createTestBot({ commands: unionOptions })
export const testedRequires: Assert<Equal<Requirements<typeof tested>, Database | Metrics>> = true
const defined = defineBot({ commands: unionOptions })
export const definedRun = runBot({ token: undefined, ...defined })
export const definedRequires: Assert<Equal<Requirements<typeof definedRun>, Database | Metrics>> = true

// One registered command whose guard, onReject, cooldown store and execute need different services makes a router that
// requires all of them, without type arguments
class Auth extends Context.Service<Auth, { readonly allowed: Effect.Effect<boolean> }>()("Auth") {}
const auditStore = {
    claim: () => Audit.use((audit) => audit.note).pipe(Effect.as({ _tag: "CooldownAcquired" as const, retryAtMs: 0 })),
}
export const mixedCommand = commands.create({ prefix: "!" }).register({
    name: "ban",
    guard: () => Auth.use((auth) => auth.allowed),
    onReject: () => Metrics.use((metrics) => metrics.count),
    cooldown: { durationMs: 1_000, store: auditStore },
    execute: () => Database.use((database) => database.prefix),
})
export const mixedCommandRequires: Assert<
    Equal<RouterServices<typeof mixedCommand>, Auth | Database | Metrics | Audit>
> = true

// Explicit type arguments keep limiting every callback of the command to the named services
export const explicitCommand = commands.create({ prefix: "!" }).register<never, Auth | Database>({
    name: "ban",
    guard: () => Auth.use((auth) => auth.allowed),
    execute: () => Database.use((database) => database.prefix),
})
export const explicitCommandRequires: Assert<Equal<RouterServices<typeof explicitCommand>, Auth | Database>> = true
export const explicitCommandTooNarrow = commands.create({ prefix: "!" }).register<never, Database>({
    name: "ban",
    // @ts-expect-error Auth is not in the explicit services
    // @effect-diagnostics-next-line missingEffectContext:off
    guard: () => Auth.use((auth) => auth.allowed),
    execute: () => Database.use((database) => database.prefix),
})

// A guard in an optional property, such as one a factory spreads in conditionally, still adds its services
function guardedCommand(guard?: PrefixCommandGuard<never, Auth>) {
    return { execute: () => Effect.void, ...(guard === undefined ? {} : { guard }) }
}
const spreadGuard = guardedCommand(() => Auth.use((auth) => auth.allowed))
export const spreadGuardRequires: Assert<Equal<CommandRequirements<typeof spreadGuard>, Auth>> = true
export const spreadGuardBot = runBot({ token: undefined, commands: { prefix: "!", commands: { ban: spreadGuard } } })
export const spreadGuardBotRequires: Assert<Equal<Requirements<typeof spreadGuardBot>, Auth>> = true
export const spreadGuardTest = createTestBot({ commands: { prefix: "!", commands: { ban: spreadGuard } } })
export const spreadGuardTestRequires: Assert<Equal<Requirements<typeof spreadGuardTest>, Auth>> = true

// An interface that declares the callbacks as optional properties counts each one's services
interface DeclaredCommand {
    readonly guard?: PrefixCommandGuard<never, Auth>
    readonly onReject?: PrefixCommandRejectionFeedback<never, Metrics>
    readonly cooldown?: { readonly durationMs: number; readonly store?: CooldownStore<never, Audit> }
    readonly execute: () => Effect.Effect<void>
}
export const declaredRequires: Assert<Equal<CommandRequirements<DeclaredCommand>, Auth | Metrics | Audit>> = true

// Callbacks that fail with different errors compile without type arguments, in register and in commands.create
class AuthError extends Data.TaggedError("AuthError")<{}> {}
class DbError extends Data.TaggedError("DbError")<{}> {}
class ReplyError extends Data.TaggedError("ReplyError")<{}> {}
class StoreError extends Data.TaggedError("StoreError")<{}> {}
const failingStore = { claim: () => Effect.fail(new StoreError()) }
export const mixedErrors = commands.create({ prefix: "!" }).register({
    name: "note",
    guard: () => Effect.fail(new AuthError()),
    onReject: () => Effect.fail(new ReplyError()),
    cooldown: { durationMs: 1_000, store: failingStore },
    execute: () => Effect.fail(new DbError()),
})
export const mixedErrorsRequires: Assert<Equal<RouterServices<typeof mixedErrors>, never>> = true
export const mixedRouterErrors = commands.create({
    prefix: "!",
    onReject: () => Effect.fail(new ReplyError()),
    use: [(_context, next) => Effect.andThen(Effect.fail(new AuthError()), next)],
    onUnmatched: () => Effect.fail(new DbError()),
})
export const mixedRouterErrorsRequires: Assert<Equal<RouterServices<typeof mixedRouterErrors>, never>> = true

// Explicit errors keep compiling, and they limit every callback to the named errors
export const explicitErrors = commands.create({ prefix: "!" }).register<AuthError | DbError, never>({
    name: "note",
    guard: () => Effect.fail(new AuthError()),
    execute: () => Effect.fail(new DbError()),
})
export const explicitErrorsTooNarrow = commands.create({ prefix: "!" }).register<DbError, never>({
    name: "note",
    // @ts-expect-error AuthError is not in the explicit errors
    // @effect-diagnostics-next-line missingEffectError:off
    guard: () => Effect.fail(new AuthError()),
    execute: () => Effect.fail(new DbError()),
})
export const explicitRouterErrors = commands.create<ReplyError | DbError>({
    prefix: "!",
    onReject: () => Effect.fail(new ReplyError()),
    onUnmatched: () => Effect.fail(new DbError()),
})
export const explicitRouterErrorsTooNarrow = commands.create<ReplyError>({
    prefix: "!",
    onReject: () => Effect.fail(new ReplyError()),
    // @ts-expect-error DbError is not in the explicit errors
    // @effect-diagnostics-next-line missingEffectError:off
    onUnmatched: () => Effect.fail(new DbError()),
})
