// Compile-only check, run by the test typecheck: The raw event narrows by t to the payload Fluxer's documentation
// describes, under Fluxer's own field names, once documented is true, and an undocumented dispatch keeps an unknown
// body. The gatewayError event carries the documented Gateway Error data. Both APIs
import { Effect } from "effect"
import type {
    Client,
    GatewayDispatchPayloads,
    GatewayErrorEvent,
    GatewayPayloadObjects,
    RawDispatch,
    RawDispatchEvent,
} from "../../src/index.js"
import type { Client as NativeClient } from "../../src/effect.js"

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T

/** Without documented, an undocumented type can carry any name, so comparing t alone does not narrow d */
export function unnarrowed(dispatch: RawDispatchEvent): string | undefined {
    // @ts-expect-error d stays unknown
    if (dispatch.t === "MESSAGE_CREATE") return dispatch.d.channel_id
    return undefined
}

/** Reads the official fields of a narrowed dispatch, and rejects SDK and misspelled names */
function readDispatch(dispatch: RawDispatchEvent): string | undefined {
    if (!dispatch.documented) {
        const body: Assert<Equal<typeof dispatch.d, unknown>> = true
        void body
        return dispatch.t
    }
    if (dispatch.t === "MESSAGE_CREATE") {
        const channel: string = dispatch.d.channel_id
        const author: string = dispatch.d.author.id
        const reply: string | undefined = dispatch.d.referenced_message?.content
        const member: readonly string[] | undefined = dispatch.d.member?.roles
        // Fluxer removes user from the member on message events (guild_dispatch_decorate.erl at the pin)
        // @ts-expect-error A message event's member has no user
        void dispatch.d.member?.user
        // @ts-expect-error The SDK's camelCase name is not Fluxer's field name
        void dispatch.d.channelId
        // @ts-expect-error A misspelled official field is rejected
        void dispatch.d.chanel_id
        return `${channel} ${author} ${reply ?? ""} ${member?.length ?? 0}`
    }
    if (dispatch.t === "MESSAGE_UPDATE" || dispatch.t === "MESSAGE_DELETE")
        // @ts-expect-error A message event's member has no user, also when the prose adds it as in Message Create
        return dispatch.d.member?.user.id
    // Typing and reactions keep the member's user
    if (dispatch.t === "TYPING_START") return dispatch.d.member?.user.id
    if (dispatch.t === "VOICE_SERVER_UPDATE") return dispatch.d.connection_id
    // The thread member object with the guild_id the prose adds
    if (dispatch.t === "THREAD_MEMBER_UPDATE") return `${dispatch.d.id} ${dispatch.d.guild_id}`
    if (dispatch.t === "USER_PINNED_DMS_UPDATE") return dispatch.d.join(",")
    return undefined
}

// The payload map is keyed by Fluxer's dispatch names, and objects by the address of their documentation
type MessageCreate = GatewayDispatchPayloads["MESSAGE_CREATE"]
export type MessageCreateIsAMessage = Assert<
    MessageCreate extends GatewayPayloadObjects["/http-api/messages/#message-object"] ? true : false
>
export type CallUpdateLeavesOutCreateFields = Assert<
    Equal<"recipients" extends keyof GatewayDispatchPayloads["CALL_UPDATE"] ? true : false, false>
>
export type SessionsReplaceIsAnArray = Assert<
    Equal<
        GatewayDispatchPayloads["SESSIONS_REPLACE"],
        readonly GatewayPayloadObjects["/gateway/events/#session-presence-object"][]
    >
>
// Every raw event is still a RawDispatch, so existing handlers typed with it keep compiling
export type RawEventsAreRawDispatches = Assert<RawDispatchEvent extends RawDispatch ? true : false>

export function defaultApi(client: Client) {
    const raw = client.on("raw", (dispatch) => void readDispatch(dispatch))
    const errors = client.on("gatewayError", (frame) => {
        const code: string = frame.d.code
        const message: string = frame.d.message
        const shard: number = frame.shardId
        // @ts-expect-error A Gateway Error frame is no dispatch and has no type
        void frame.t
        return void `${code} ${message} ${shard}`
    })
    const waited = client.waitFor("raw", { filter: (dispatch) => dispatch.documented && dispatch.t === "READY" })
    return { raw, errors, waited }
}

export function nativeApi(client: NativeClient) {
    return Effect.gen(function* () {
        yield* client.on("raw", (dispatch) => Effect.sync(() => void readDispatch(dispatch)))
        yield* client.on("gatewayError", (frame: GatewayErrorEvent) =>
            Effect.sync(() => {
                const code: string = frame.d.code
                return void code
            }),
        )
    })
}
