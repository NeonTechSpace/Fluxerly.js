/**
 * Thread gateway events: Decoders for the THREAD_* dispatches a bot receives and for the threads of a community snapshot.
 * Invariant: A thread event decodes whole or not at all, like every dispatch. Only a community snapshot's thread list is
 * decoded entry by entry, so one malformed thread costs only itself and the caller logs each skipped entry.
 * Payload shapes follow gateway/threads.md and fluxer_gateway guild_thread_dispatch.erl, guild_thread_view.erl and
 * fluxer_api ThreadDispatch.ts at fluxerapp/fluxer commit 4749eb7f866ceba0c9622014a9824900d5be8172.
 * Implements [SDK contracts: Validation requirements](/docs/SDK-CONTRACTS.md#validation-requirements)
 */
import { ChannelType, type GuildThreadChannel, type ThreadMember } from "#sdk/channels"
import type { ThreadCreateEvent, ThreadDeletion, ThreadListSync, ThreadMembersUpdate } from "#sdk/events"
import { decodeThread, decodeThreadList, decodeThreadMember } from "./channel-decode.js"
import { count, identifier, record } from "./decode/primitives.js"

const threadTypes: ReadonlySet<unknown> = new Set([
    ChannelType.AnnouncementThread,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
])

/**
 * Channel types that can hold threads. Fluxer deletes such a channel's threads with it and sends no THREAD_DELETE for
 * them (ChannelOperationsService.deleteChannel and the deleteChannelThreads worker task at the commit above)
 */
export const threadParentTypes: ReadonlySet<unknown> = new Set([
    ChannelType.Text,
    ChannelType.Announcement,
    ChannelType.Forum,
    ChannelType.Media,
])

const identifiers = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every(identifier)

/** A thread, plus newly_created, which Fluxer sends only as true and only for a thread that was just created */
export function decodeThreadCreate(value: unknown): ThreadCreateEvent | undefined {
    const thread = decodeThread(value)
    if (!thread || !record(value) || (value.newly_created !== undefined && typeof value.newly_created !== "boolean"))
        return undefined
    return Object.freeze({ ...thread, isNewlyCreated: value.newly_created === true })
}

/** A deleted thread's identity, the only fields Fluxer keeps in THREAD_DELETE */
export function decodeThreadDeletion(value: unknown): ThreadDeletion | undefined {
    if (
        !record(value) ||
        !identifier(value.id) ||
        !identifier(value.guild_id) ||
        !identifier(value.parent_id) ||
        !threadTypes.has(value.type)
    )
        return undefined
    return Object.freeze({
        id: value.id,
        guildId: value.guild_id,
        parentId: value.parent_id,
        type: value.type as ThreadDeletion["type"],
    })
}

/** A replaced thread set, with the bot's memberships folded into their threads. channel_ids becomes parentIds */
export function decodeThreadListSync(value: unknown): ThreadListSync | undefined {
    if (!record(value) || !identifier(value.guild_id)) return undefined
    if (value.channel_ids !== undefined && !identifiers(value.channel_ids)) return undefined
    const guildId = value.guild_id
    const threads = decodeThreadList(value.threads, value.members)
    if (!threads || threads.some((thread) => thread.guildId !== guildId)) return undefined
    return Object.freeze({
        guildId,
        ...(value.channel_ids === undefined ? {} : { parentIds: Object.freeze([...value.channel_ids]) }),
        threads,
    })
}

/**
 * Joined and departed thread members. Fluxer leaves out an empty added_members or removed_member_ids, and adds a
 * presence to each added member, which is not projected
 */
export function decodeThreadMembersUpdate(value: unknown): ThreadMembersUpdate | undefined {
    if (
        !record(value) ||
        !identifier(value.id) ||
        !identifier(value.guild_id) ||
        !count(value.member_count) ||
        (value.added_members !== undefined && !Array.isArray(value.added_members)) ||
        (value.removed_member_ids !== undefined && !identifiers(value.removed_member_ids))
    )
        return undefined
    const added: ThreadMember[] = []
    for (const item of (value.added_members as readonly unknown[] | undefined) ?? []) {
        const member = decodeThreadMember(item, value.guild_id, value.id)
        if (!member) return undefined
        added.push(member)
    }
    return Object.freeze({
        threadId: value.id,
        guildId: value.guild_id,
        memberCount: value.member_count,
        added: Object.freeze(added),
        removedUserIds: Object.freeze([...((value.removed_member_ids as readonly string[] | undefined) ?? [])]),
    })
}

/** The thread whose own membership THREAD_MEMBER_UPDATE reports. The payload is the bot's thread member with guild_id */
export function decodeOwnThreadMemberUpdate(value: unknown): { readonly threadId: string } | undefined {
    if (!record(value) || !identifier(value.guild_id)) return undefined
    const member = decodeThreadMember(value, value.guild_id)
    return member && Object.freeze({ threadId: member.threadId })
}

/**
 * Decode the threads of a community snapshot one at a time. Returns the threads in this community and the field path,
 * such as threads[2], of each entry that is malformed or names another community. A threads value that is present but
 * not an array skips the whole list, reported as threads
 */
export function decodeSnapshotThreads(
    value: Record<string, unknown>,
    guildId: string,
): { readonly threads: readonly GuildThreadChannel[]; readonly skipped: readonly string[] } {
    if (value.threads === undefined) return { threads: [], skipped: [] }
    if (!Array.isArray(value.threads)) return { threads: [], skipped: ["threads"] }
    const threads: GuildThreadChannel[] = []
    const skipped: string[] = []
    value.threads.forEach((item: unknown, index) => {
        const thread = decodeThread(item)
        if (thread && thread.guildId === guildId) threads.push(thread)
        else skipped.push(`threads[${index}]`)
    })
    return { threads, skipped }
}
