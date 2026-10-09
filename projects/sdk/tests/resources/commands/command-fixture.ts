import { Effect, Exit, Scope } from "effect"
import { expect, onTestFinished, vi } from "vitest"
import {
    commands,
    ConfigurationError,
    type Client,
    type FailureReport,
    type PrefixCommandGroupDefinition,
    type PrefixCommandMetadata,
    type PrefixCommandRegistrationOptions,
} from "../../../src/index.js"
import { commands as nativeCommands, type Client as NativeClient } from "../../../src/effect.js"
import { defaultApi, nativeApi, type FixtureClientOptions, type Mode } from "../../support/both-apis.js"
import { startGatewayServer } from "../../support/gateway-server.js"
import { waitUntil } from "../../support/clock.js"
import { stubFetchWithHostedDiscovery } from "../../support/hosted-discovery.js"
import { captureLogs } from "../../support/log-capture.js"
import { settle } from "../../support/settle.js"

/** One REST request received by the command fixture */
export interface RecordedCall {
    readonly method: string
    /** Path without origin, such as /v1/channels/20/messages */
    readonly path: string
    readonly body: unknown
}

/** Answer a REST request, or return undefined to use the fixture defaults. The init carries the request's signal */
type Route = (call: RecordedCall, init: RequestInit) => Response | Promise<Response> | undefined

/** Where a delivered message comes from. The defaults are a user message in channel 20 outside a guild */
interface Delivery {
    readonly guildId?: string
    readonly channelId?: string
    readonly authorId?: string
    readonly isBot?: boolean
    /** Fluxer's message type, 0 for a regular message when unset */
    readonly type?: number
}

/**
 * Start a gateway fixture and a REST stub for command tests.
 * Replies to channel messages succeed and echo their content. Other unrouted requests receive 404
 */
export async function commandFixture(route?: Route) {
    const gateway = await startGatewayServer({ sessionId: "fixture" })
    const calls: RecordedCall[] = []
    let messageIds = 900
    stubFetchWithHostedDiscovery(async (url, init) => {
        const call: RecordedCall = {
            method: init.method ?? "GET",
            path: new URL(url).pathname,
            body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
        }
        calls.push(call)
        const routed = await route?.(call, init)
        if (routed !== undefined) return routed
        const channel = /^\/v1\/channels\/(\d+)\/messages$/.exec(call.path)?.[1]
        if (call.method === "POST" && channel !== undefined)
            return Response.json({
                id: String(++messageIds),
                channel_id: channel,
                content: (call.body as { content?: string } | undefined)?.content ?? "",
                author: { id: "99", username: "bot", bot: true },
            })
        return Response.json({ message: "Unknown fixture route", code: 0 }, { status: 404 })
    })
    let messages = 100
    return {
        calls,
        /** Content of every reply the SDK sent, in order */
        replies: () =>
            calls
                .filter((call) => call.method === "POST" && /^\/v1\/channels\/\d+\/messages$/.test(call.path))
                .map((call) => (call.body as { content?: string }).content),
        /** Deliver a MESSAGE_CREATE synchronously on the client socket, so consecutive deliveries keep their order */
        deliver(content: string, from: Delivery = {}) {
            gateway.deliverNow("MESSAGE_CREATE", {
                id: String(++messages),
                channel_id: from.channelId ?? "20",
                content,
                type: from.type ?? 0,
                author: { id: from.authorId ?? "30", username: "fixture", bot: from.isBot ?? false },
                ...(from.guildId === undefined ? {} : { guild_id: from.guildId }),
            })
        },
        /** Deliver another gateway event synchronously */
        dispatch: (event: string, data: unknown) => gateway.deliverNow(event, data),
    }
}

/** A connected default client, with command Debug records captured */
interface DefaultConnected {
    readonly mode: "default"
    readonly client: Client
    readonly logs: ReturnType<typeof captureLogs>
}

/** A connected native client with a registration scope closed when the test finishes */
interface NativeConnected {
    readonly mode: "native"
    readonly client: NativeClient
    readonly registration: Scope.Closeable
    readonly logs: ReturnType<typeof captureLogs>
}

/** A connected client of either API style */
type Connected = DefaultConnected | NativeConnected

/** Create and connect a client for one API style. Command records are captured at Debug */
export async function connect(mode: "default", options?: FixtureClientOptions): Promise<DefaultConnected>
export async function connect(mode: "native", options?: FixtureClientOptions): Promise<NativeConnected>
export async function connect(mode: Mode, options?: FixtureClientOptions): Promise<Connected>
export async function connect(mode: Mode, options: FixtureClientOptions = {}): Promise<Connected> {
    const logs = captureLogs()
    const settings = { ...options, logging: { ...logs.logging, debug: ["commands" as const] } }
    if (mode === "default") {
        const client = defaultApi(settings)
        await settle(client.connect())
        return { mode, client, logs }
    }
    const client = await nativeApi(settings)
    const registration = Scope.makeUnsafe()
    onTestFinished(async () => {
        await Effect.runPromise(Scope.close(registration, Exit.void))
    })
    await settle(client.connect())
    return { mode, client, registration, logs }
}

/**
 * A router of either API style. Tests write each callback in the style of the router they create, using act,
 * so one untyped view covers the registration methods both styles share
 */
export interface EitherRouter {
    readonly commands: readonly PrefixCommandMetadata[]
    register(command: object, options?: PrefixCommandRegistrationOptions): EitherRouter
    registerMany(commands: object, options?: PrefixCommandRegistrationOptions): EitherRouter
    registerGroup(group: PrefixCommandGroupDefinition, options?: PrefixCommandRegistrationOptions): EitherRouter
}

/** Create a router of one API style from options written for that style */
export function createRouter(mode: Mode, options: object): EitherRouter {
    return (mode === "default" ? commands.create(options as never) : nativeCommands.create(options as never)) as never
}

/** Run a callback body in the callback convention of one API style: directly, or as an Effect */
export function act<A>(mode: Mode, body: () => A | PromiseLike<A>): unknown {
    return mode === "default" ? body() : Effect.promise(async () => body())
}

/** Attach a router to a connected client, collecting failure reports through the router's onError hook */
export async function attach(connected: Connected, router: EitherRouter, options: object = {}) {
    const reports: FailureReport[] = []
    const onError = (report: FailureReport) => act(connected.mode, () => void reports.push(report))
    if (connected.mode === "default")
        (router as unknown as ReturnType<typeof commands.create>).attach(connected.client, {
            ...options,
            onError: onError as never,
        })
    else
        await Effect.runPromise(
            (router as unknown as ReturnType<typeof nativeCommands.create>)
                .attach(connected.client, { ...options, onError: onError as never })
                .pipe(Scope.provide(connected.registration)) as Effect.Effect<unknown>,
        )
    return reports
}

/** Run local command setup that must throw ConfigurationError, returning it for field and privacy checks */
export function configurationError(run: () => unknown): ConfigurationError {
    try {
        run()
    } catch (error) {
        expect(error).toBeInstanceOf(ConfigurationError)
        return error as ConfigurationError
    }
    return expect.fail("Expected command setup to throw ConfigurationError")
}

/** Anything that delivers a command message to the connected client */
interface Deliverer {
    deliver(content: string): void
}

/**
 * Wait until the client runs no handler beyond the ones a test deliberately holds. The barrier command started after
 * every earlier delivery, so its end leaves only the tested subscriptions' own invocations to finish
 */
async function handlersSettled(client: Client | NativeClient, held: number) {
    await vi.waitFor(() => expect(client.diagnostics().events.activeHandlers).toBe(held))
}

/**
 * Deliver a command to a separate default router on the same client, wait until it executes, then wait until every
 * other running handler except the held ones has finished. An effect earlier deliveries must not cause would then
 * already be visible. This replaces fixed negative waits with completion signals
 */
export async function defaultBarrier(remote: Deliverer, client: Client, held = 0) {
    let passed = false
    const subscription = commands
        .create({ prefix: "#" })
        .register({
            name: "barrier",
            execute: () => {
                passed = true
            },
        })
        .attach(client)
    remote.deliver("#barrier")
    await waitUntil(() => passed, { message: "The barrier command did not execute" })
    subscription.close()
    await handlersSettled(client, held)
}

/** Native counterpart of defaultBarrier, attached in its own scope so it also works after a registration closed */
export async function nativeBarrier(remote: Deliverer, client: NativeClient, held = 0) {
    let passed = false
    const scope = Scope.makeUnsafe()
    onTestFinished(async () => {
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    const router = nativeCommands.create({ prefix: "#" }).register({
        name: "barrier",
        execute: () =>
            Effect.sync(() => {
                passed = true
            }),
    })
    await Effect.runPromise(router.attach(client).pipe(Scope.provide(scope)))
    remote.deliver("#barrier")
    await waitUntil(() => passed, { message: "The barrier command did not execute" })
    await handlersSettled(client, held)
}

/** Run the barrier matching a connected client's API style, leaving `held` deliberately blocked handlers running */
export function barrier(remote: Deliverer, connected: Connected, held = 0): Promise<void> {
    return connected.mode === "default"
        ? defaultBarrier(remote, connected.client, held)
        : nativeBarrier(remote, connected.client, held)
}
