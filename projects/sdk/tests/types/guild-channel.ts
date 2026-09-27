// Compile-only check, run by the test typecheck: GuildChannel is a union selected by its type.
// A ChannelType comparison narrows to exactly one known shape, and a type this SDK version does not know has
// type "unknown", so it never survives a known-type comparison and a switch on type is exhaustive
import {
    ChannelType,
    type GuildCategoryChannel,
    type GuildChannel,
    type GuildLinkChannel,
    type GuildTextChannel,
    type GuildUnknownChannel,
    type GuildVoiceChannel,
} from "../../src/index.js"
import { ChannelType as NativeChannelType, type GuildChannel as NativeGuildChannel } from "../../src/effect.js"

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T

export function voiceBitrate(channel: GuildChannel): number | null | undefined {
    // @ts-expect-error bitrate exists only after narrowing to a voice (or unknown) channel
    void channel.bitrate
    if (channel.type === ChannelType.Voice) {
        const voice: GuildVoiceChannel = channel
        return voice.bitrate
    }
    return undefined
}

export function textTopic(channel: GuildChannel): string | null | undefined {
    if (channel.type !== ChannelType.Text) return undefined
    const text: GuildTextChannel = channel
    // @ts-expect-error A text channel has no voice bitrate
    void text.bitrate
    return text.topic
}

export function linkUrl(channel: GuildChannel): string | null | undefined {
    // @ts-expect-error url exists only after narrowing to a link (or unknown) channel
    void channel.url
    if (channel.type === ChannelType.Link) {
        const link: GuildLinkChannel = channel
        return link.url
    }
    return undefined
}

/** A switch on type narrows every case, and the default case is unreachable once "unknown" is handled */
export function describeChannel(channel: GuildChannel): string {
    switch (channel.type) {
        case ChannelType.Text: {
            const text: GuildTextChannel = channel
            return `text ${text.topic ?? ""}`
        }
        case ChannelType.Voice: {
            const voice: GuildVoiceChannel = channel
            return `voice ${voice.bitrate ?? 0}`
        }
        case ChannelType.Category: {
            const category: GuildCategoryChannel = channel
            // @ts-expect-error A category exposes no voice settings
            void category.userLimit
            // Shared base fields stay readable without narrowing further
            return `category ${category.name ?? ""} ${category.parentId ?? ""}`
        }
        case ChannelType.Link: {
            const link: GuildLinkChannel = channel
            return `link ${link.url ?? ""}`
        }
        case "unknown": {
            const unknown: GuildUnknownChannel = channel
            return `unknown ${unknown.rawType}`
        }
        default: {
            const exhausted: never = channel
            return exhausted
        }
    }
}

/** A channel type outside the known constants keeps its Fluxer number in rawType and every optional field */
export function unknownFields(channel: GuildUnknownChannel) {
    const asUnion: GuildChannel = channel
    void asUnion
    const rawType: number = channel.rawType
    return [
        rawType,
        channel.topic,
        channel.lastMessageId,
        channel.lastPinTimestamp,
        channel.rateLimitPerUser,
        channel.bitrate,
        channel.userLimit,
        channel.voiceConnectionLimit,
        channel.rtcRegion,
        channel.url,
    ] as const
}

/** Only unknown channels carry rawType; a known shape rejects it */
export function rawTypeOnlyOnUnknown(channel: GuildVoiceChannel) {
    // @ts-expect-error A known channel type has no rawType
    return channel.rawType
}

// An unknown channel literal needs only the base fields and its Fluxer number, and may carry any optional field
export const futureChannel: GuildChannel = {
    id: "1",
    guildId: "2",
    type: "unknown",
    rawType: 13,
    bitrate: 64_000,
    topic: null,
    url: null,
}

// @ts-expect-error A numeric type outside the known constants is not a GuildChannel type
export const numericFutureChannel: GuildChannel = { id: "1", guildId: "2", type: 13 }

// The native entry exposes the same union and constants
export const sameUnion: Assert<Equal<NativeGuildChannel, GuildChannel>> = true
export const sameVoiceType: Assert<Equal<typeof NativeChannelType.Voice, 2>> = true
