// Compile-only check, run by the test typecheck: Forum and media channel inputs accept what a received channel holds,
// each created channel type accepts only the settings it can have, and the webhook thread options exist in both entry points
import {
    ChannelType,
    type ChannelCreate,
    type ChannelEdit,
    type DefaultWebhookMessageOperationOptions,
    type ForumChannelCreate,
    type ForumDefaultReaction,
    type ForumTag,
    type ForumTagInput,
    type MediaChannelCreate,
    type WebhookMessageInput,
    type WebhookMessageOperationOptions,
} from "../../src/index.js"
import type {
    ChannelCreate as NativeChannelCreate,
    ForumTagInput as NativeForumTagInput,
    WebhookMessageInput as NativeWebhookMessageInput,
    WebhookMessageOperationOptions as NativeWebhookMessageOperationOptions,
} from "../../src/effect.js"

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T

// A received tag and a received default reaction are valid input, so a channel edit can send them back unchanged
export function keepTags(tags: readonly ForumTag[], reaction: ForumDefaultReaction | null): ChannelEdit {
    const tag: ForumTagInput = tags[0]!
    void tag
    return { availableTags: tags, defaultReactionEmoji: reaction }
}

export const forum: ForumChannelCreate = {
    type: ChannelType.Forum,
    name: "help",
    availableTags: [{ name: "bug", emojiName: "🐛" }],
    defaultForumLayout: 1,
    defaultTagSetting: "match_all",
    defaultAutoArchiveMinutes: 60,
}

export const media: MediaChannelCreate = { type: ChannelType.Media, name: "gallery", flags: 32784 }

export const creates: ChannelCreate[] = [
    forum,
    media,
    { type: ChannelType.Text, name: "general", defaultThreadRateLimitPerUser: 5 },
    { type: ChannelType.Announcement, name: "news", defaultAutoArchiveMinutes: null },
]

export const mediaLayout: MediaChannelCreate = {
    type: ChannelType.Media,
    name: "gallery",
    // @ts-expect-error a media channel has no layout setting
    defaultForumLayout: 1,
}
export const textTags: ChannelCreate = {
    type: ChannelType.Text,
    name: "general",
    // @ts-expect-error a text channel has no tags
    availableTags: [],
}
// @ts-expect-error a tag needs a name
export const nameless: ForumTagInput = { moderated: true }
export const unknownSetting: ForumChannelCreate = {
    type: ChannelType.Forum,
    name: "help",
    // @ts-expect-error the tag setting has two values
    defaultTagSetting: "match_any",
}

// The webhook options and the default API twin exist in both entry points
export const message: WebhookMessageInput = { content: "Release", threadName: "1.2", appliedTagIds: ["70"] }
export const inThread: WebhookMessageInput = { content: "Reply", threadId: "500" }
export const fetchOptions: WebhookMessageOperationOptions = { threadId: "500", timeoutMs: 1000 }
export const defaultFetchOptions: DefaultWebhookMessageOperationOptions = {
    threadId: "500",
    signal: new AbortController().signal,
}
export function sameInEffect(input: WebhookMessageInput, options: WebhookMessageOperationOptions) {
    const nativeInput: NativeWebhookMessageInput = input
    const nativeOptions: NativeWebhookMessageOperationOptions = options
    return [nativeInput, nativeOptions]
}

export type SameCreate = Assert<Equal<ChannelCreate, NativeChannelCreate>>
export type SameTag = Assert<Equal<ForumTagInput, NativeForumTagInput>>
