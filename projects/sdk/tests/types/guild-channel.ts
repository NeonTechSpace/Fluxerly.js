// Compile-only check, run by the test typecheck: GuildChannel is a union selected by its type.
// A ChannelType comparison narrows to exactly one known shape, and a type this SDK version does not know has
// type "unknown", so it never survives a known-type comparison and a switch on type is exhaustive
import {
    ChannelType,
    isThreadChannel,
    type AnnouncementChannelCreate,
    type ChannelCreate,
    type ChannelEdit,
    type GuildAnnouncementChannel,
    type GuildCategoryChannel,
    type GuildForumChannel,
    type GuildMediaChannel,
    type GuildThreadChannel,
    type GuildTextChannelBase,
    type GuildChannel,
    type GuildLinkChannel,
    type GuildTextChannel,
    type GuildUnknownChannel,
    type GuildVoiceChannel,
} from "../../src/index.js"
import {
    ChannelType as NativeChannelType,
    type AnnouncementChannelCreate as NativeAnnouncementChannelCreate,
    type ChannelEdit as NativeChannelEdit,
    type GuildAnnouncementChannel as NativeGuildAnnouncementChannel,
    type GuildChannel as NativeGuildChannel,
} from "../../src/effect.js"

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
        case ChannelType.Announcement: {
            const announcement: GuildAnnouncementChannel = channel
            return `announcement ${announcement.topic ?? ""}`
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
        case ChannelType.AnnouncementThread:
        case ChannelType.PublicThread:
        case ChannelType.PrivateThread: {
            const thread: GuildThreadChannel = channel
            const parentId: string = thread.parentId
            return `thread ${thread.name} in ${parentId}`
        }
        case ChannelType.Forum: {
            const forum: GuildForumChannel = channel
            return `forum ${forum.defaultForumLayout ?? ""}`
        }
        case ChannelType.Media: {
            const media: GuildMediaChannel = channel
            // @ts-expect-error Only a forum channel has a layout setting
            void media.defaultForumLayout
            return `media ${media.availableTags?.length ?? 0}`
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

/** isThreadChannel narrows to the thread union, whose type-specific fields need a further type comparison */
export function threadFields(channel: GuildChannel) {
    if (!isThreadChannel(channel)) {
        // @ts-expect-error Only a thread has an owner
        void channel.ownerId
        return undefined
    }
    const thread: GuildThreadChannel = channel
    // @ts-expect-error invitable exists only on a private thread
    void thread.invitable
    // @ts-expect-error appliedTagIds exists only on a public thread
    void thread.appliedTagIds
    const invitable = thread.type === ChannelType.PrivateThread ? thread.invitable : undefined
    const tags = thread.type === ChannelType.PublicThread ? thread.appliedTagIds : undefined
    return [thread.archived, thread.autoArchiveMinutes, thread.membership?.joinedAt, invitable, tags] as const
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
export const sameAnnouncementType: Assert<Equal<typeof NativeChannelType.Announcement, 5>> = true
export const sameAnnouncementShape: Assert<Equal<NativeGuildAnnouncementChannel, GuildAnnouncementChannel>> = true
export const sameAnnouncementCreate: Assert<Equal<NativeAnnouncementChannelCreate, AnnouncementChannelCreate>> = true
export const sameChannelEdit: Assert<Equal<NativeChannelEdit, ChannelEdit>> = true
export const conversionTypes: Assert<Equal<ChannelEdit["type"], 0 | 5 | undefined>> = true

export function announcementTopic(channel: GuildChannel): string | null | undefined {
    if (channel.type !== ChannelType.Announcement) return undefined
    const announcement: GuildAnnouncementChannel = channel
    const textLike: GuildTextChannelBase = announcement
    // @ts-expect-error An announcement channel has no voice bitrate
    void announcement.bitrate
    return textLike.topic
}

const announcementCreate: AnnouncementChannelCreate = {
    type: ChannelType.Announcement,
    name: "announcements",
    topic: null,
    rateLimitPerUser: 15,
    permissionOverwrites: [],
}
export const announcementAsCreate: ChannelCreate = announcementCreate
export const announcementConversion: ChannelEdit = { type: ChannelType.Announcement }
export const textConversion: NativeChannelEdit = { type: NativeChannelType.Text }
// @ts-expect-error Only Text and Announcement are channel conversion targets
export const invalidConversion: ChannelEdit = { type: ChannelType.Voice }
