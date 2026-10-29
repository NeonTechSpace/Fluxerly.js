import { expect, test } from "vitest"
import { InputValidationFailure } from "../../src/input-validation.js"
import { channelCreate } from "../../src/internal/channels.js"
import {
    checkedField,
    checkFields,
    distinct,
    idField,
    listField,
    nullable,
    textField,
} from "../../src/internal/field-rules.js"
import { guildEdit } from "../../src/internal/guild-settings.js"
import { encodeMemberSearchQuery } from "../../src/internal/member-search.js"
import { encodeMessageSearch } from "../../src/internal/message-search.js"
import { threadSearch } from "../../src/internal/threads.js"

const detail = (result: unknown) => (result instanceof InputValidationFailure ? result.detail : result)

test("field rules check supplied fields in table order, read each once and keep list copies", () => {
    let reads = 0
    const input = {
        get name() {
            reads++
            return "n"
        },
        ids: ["1", "2"],
        skipped: undefined,
    }
    const rules = {
        name: textField(1, 2, "Name must contain 1 through 2 UTF-16 code units"),
        ids: listField(2, (value) => value === "1" || value === "2", "format", "IDs must be at most 2 known IDs"),
        skipped: idField("Skipped must be a decimal string"),
    }
    const kept = checkFields(input, rules, "query.")
    expect(kept).toEqual({ name: "n", ids: ["1", "2"] })
    expect(reads).toBe(1)
    expect(Object.isFrozen((kept as Record<string, unknown>).ids)).toBe(true)
    expect((kept as Record<string, unknown>).ids).not.toBe(input.ids)
    expect(detail(checkFields({ name: "", ids: [3] }, rules, "query."))).toEqual({
        path: "query.name",
        constraint: "length",
        explanation: "Name must contain 1 through 2 UTF-16 code units",
    })
    expect(detail(checkFields({ ids: ["1", "2", "1"] }, rules, ""))).toMatchObject({
        path: "ids[]",
        constraint: "format",
    })
})

test("field rule modifiers accept null, reject repeated items and pass a checked field's own failure", () => {
    const own = new InputValidationFailure({ path: "query.tags", constraint: "type", explanation: "Own failure" })
    const rules = {
        id: nullable(idField("ID must be null or a decimal string")),
        tags: distinct(listField(3, (value) => typeof value === "string", "unique", "Tags must be unique strings")),
        custom: checkedField((value) => (value === 1 ? value : own)),
    }
    expect(checkFields({ id: null, tags: ["a", "b"], custom: 1 }, rules, "")).toEqual({
        id: null,
        tags: ["a", "b"],
        custom: 1,
    })
    expect(detail(checkFields({ tags: ["a", "a"] }, rules, ""))).toEqual({
        path: "tags[]",
        constraint: "unique",
        explanation: "Tags must be unique strings",
    })
    expect(checkFields({ custom: 2 }, rules, "")).toBe(own)
})

// Fields whose failure detail no resource test asserted before these validators moved to rule tables
const run = {
    "message search": (input: object) => encodeMessageSearch({ channelId: "2" }, input),
    "member search": (input: object) => encodeMemberSearchQuery(input),
    "guild settings": (input: object) => guildEdit("1", input),
    "thread search": (input: object) => threadSearch("1", input, () => undefined),
    "channel create": (input: object) => channelCreate("1", { type: 2, name: "n", ...input }),
}

test.each([
    ["message search", "maxId", "query.maxId", "format", "Maximum message ID must be a decimal string"],
    ["message search", "minId", "query.minId", "format", "Minimum message ID must be a decimal string"],
    [
        "message search",
        "contents",
        "query.contents[]",
        "format",
        "Message search contents must be an array of at most 100 strings containing 1 through 1,024 UTF-16 code units",
    ],
    [
        "message search",
        "excludeChannelIds",
        "query.excludeChannelIds[]",
        "format",
        "Message search excludeChannelIds must be an array of at most 500 decimal ID strings",
    ],
    [
        "message search",
        "authorTypes",
        "query.authorTypes[]",
        "allowedValue",
        "Message search authorTypes must be an array of at most 20 supported values",
    ],
    [
        "message search",
        "excludeAuthorTypes",
        "query.excludeAuthorTypes[]",
        "allowedValue",
        "Message search excludeAuthorTypes must be an array of at most 20 supported values",
    ],
    [
        "message search",
        "authorIds",
        "query.authorIds[]",
        "format",
        "Message search authorIds must be an array of at most 100 decimal ID strings",
    ],
    [
        "message search",
        "excludeAuthorIds",
        "query.excludeAuthorIds[]",
        "format",
        "Message search excludeAuthorIds must be an array of at most 100 decimal ID strings",
    ],
    [
        "message search",
        "excludeMentions",
        "query.excludeMentions[]",
        "format",
        "Message search excludeMentions must be an array of at most 100 decimal ID strings",
    ],
    [
        "message search",
        "has",
        "query.has[]",
        "allowedValue",
        "Message search has must be an array of at most 20 supported values",
    ],
    [
        "message search",
        "excludeHas",
        "query.excludeHas[]",
        "allowedValue",
        "Message search excludeHas must be an array of at most 20 supported values",
    ],
    [
        "message search",
        "embedTypes",
        "query.embedTypes[]",
        "allowedValue",
        "Message search embedTypes must be an array of at most 20 supported values",
    ],
    [
        "message search",
        "excludeEmbedTypes",
        "query.excludeEmbedTypes[]",
        "allowedValue",
        "Message search excludeEmbedTypes must be an array of at most 20 supported values",
    ],
    [
        "message search",
        "embedProviders",
        "query.embedProviders[]",
        "format",
        "Message search embedProviders must be an array of at most 50 strings containing 1 through 256 UTF-16 code units",
    ],
    [
        "message search",
        "excludeEmbedProviders",
        "query.excludeEmbedProviders[]",
        "format",
        "Message search excludeEmbedProviders must be an array of at most 50 strings containing 1 through 256 UTF-16 code units",
    ],
    [
        "message search",
        "linkHostnames",
        "query.linkHostnames[]",
        "format",
        "Message search linkHostnames must be an array of at most 100 strings containing 1 through 255 UTF-16 code units",
    ],
    [
        "message search",
        "excludeLinkHostnames",
        "query.excludeLinkHostnames[]",
        "format",
        "Message search excludeLinkHostnames must be an array of at most 100 strings containing 1 through 255 UTF-16 code units",
    ],
    [
        "message search",
        "attachmentFilenames",
        "query.attachmentFilenames[]",
        "format",
        "Message search attachmentFilenames must be an array of at most 100 strings containing 1 through 1,024 UTF-16 code units",
    ],
    [
        "message search",
        "excludeAttachmentFilenames",
        "query.excludeAttachmentFilenames[]",
        "format",
        "Message search excludeAttachmentFilenames must be an array of at most 100 strings containing 1 through 1,024 UTF-16 code units",
    ],
    [
        "message search",
        "attachmentExtensions",
        "query.attachmentExtensions[]",
        "format",
        "Message search attachmentExtensions must be an array of at most 50 strings containing 1 through 32 UTF-16 code units",
    ],
    [
        "message search",
        "excludeAttachmentExtensions",
        "query.excludeAttachmentExtensions[]",
        "format",
        "Message search excludeAttachmentExtensions must be an array of at most 50 strings containing 1 through 32 UTF-16 code units",
    ],
    ["message search", "sortOrder", "query.sortOrder", "allowedValue", "Message search sortOrder must be asc or desc"],
    ["message search", "includeNsfw", "query.includeNsfw", "type", "Message search includeNsfw must be a boolean"],
    [
        "member search",
        "joinedAtAfterSeconds",
        "query.joinedAtAfterSeconds",
        "range",
        "Joined-after time must be a nonnegative safe integer in Unix seconds",
    ],
    [
        "member search",
        "joinedAtBeforeSeconds",
        "query.joinedAtBeforeSeconds",
        "range",
        "Joined-before time must be a nonnegative safe integer in Unix seconds",
    ],
    [
        "member search",
        "userCreatedAtAfterSeconds",
        "query.userCreatedAtAfterSeconds",
        "range",
        "User-created-after time must be a nonnegative safe integer in Unix seconds",
    ],
    [
        "member search",
        "userCreatedAtBeforeSeconds",
        "query.userCreatedAtBeforeSeconds",
        "range",
        "User-created-before time must be a nonnegative safe integer in Unix seconds",
    ],
    [
        "member search",
        "joinSourceTypes",
        "query.joinSourceTypes[]",
        "allowedValue",
        "Join source types must be an array of at most 10 unique supported values",
    ],
    [
        "member search",
        "sourceInviteCodes",
        "query.sourceInviteCodes[]",
        "unique",
        "Source invite codes must be an array of at most 10 unique strings",
    ],
    ["member search", "sortOrder", "query.sortOrder", "allowedValue", "Member search sortOrder must be asc or desc"],
    [
        "guild settings",
        "systemChannelId",
        "systemChannelId",
        "format",
        "System channel ID must be null or a decimal string",
    ],
    [
        "guild settings",
        "systemChannelFlags",
        "systemChannelFlags",
        "allowedValue",
        "System channel flags must be 0 or 1",
    ],
    ["guild settings", "afkChannelId", "afkChannelId", "format", "AFK channel ID must be null or a decimal string"],
    [
        "guild settings",
        "afkTimeoutSeconds",
        "afkTimeoutSeconds",
        "range",
        "AFK timeout must be an integer from 60 through 3,600 seconds",
    ],
    [
        "guild settings",
        "defaultMessageNotifications",
        "defaultMessageNotifications",
        "allowedValue",
        "Default message notifications must be 0 or 1",
    ],
    [
        "guild settings",
        "contentWarningLevel",
        "contentWarningLevel",
        "allowedValue",
        "Content warning level must be 0 or 1",
    ],
    [
        "guild settings",
        "explicitContentFilter",
        "explicitContentFilter",
        "allowedValue",
        "Explicit content filter must be 0, 1, or 2",
    ],
    [
        "guild settings",
        "splashCardAlignment",
        "splashCardAlignment",
        "allowedValue",
        "Splash card alignment must be 0, 1, or 2",
    ],
    [
        "guild settings",
        "featureToggles",
        "featureToggles[]",
        "allowedValue",
        "Feature toggles must be unique supported values",
    ],
    [
        "guild settings",
        "messageHistoryCutoff",
        "messageHistoryCutoff",
        "format",
        "Message history cutoff must be null or an ISO 8601 timestamp with seconds and a Z or ±hh:mm offset",
    ],
    ["thread search", "tagIds", "query.tagIds", "type", "Forum tag IDs must be an array"],
    [
        "thread search",
        "tagSetting",
        "query.tagSetting",
        "allowedValue",
        'Thread search tagSetting must be "match_some" or "match_all"',
    ],
    [
        "thread search",
        "sortOrder",
        "query.sortOrder",
        "allowedValue",
        'Thread search sortOrder must be "asc" or "desc"',
    ],
    ["thread search", "maxId", "query.maxId", "format", "Thread search cursor IDs must be decimal strings"],
    ["thread search", "minId", "query.minId", "format", "Thread search cursor IDs must be decimal strings"],
    ["channel create", "parentId", "parentId", "format", "Channel parentId must be null or a decimal string"],
    [
        "channel create",
        "userLimit",
        "userLimit",
        "range",
        "Channel userLimit must be null or an integer from 0 through 99",
    ],
    [
        "channel create",
        "voiceConnectionLimit",
        "voiceConnectionLimit",
        "range",
        "Channel voiceConnectionLimit must be null or an integer from 1 through 100",
    ],
    ["channel create", "nsfwOverride", "nsfwOverride", "type", "Channel nsfwOverride must be boolean or null"],
    [
        "channel create",
        "contentWarningLevel",
        "contentWarningLevel",
        "allowedValue",
        "Channel contentWarningLevel must be 0 or 1",
    ],
    [
        "channel create",
        "rateLimitPerUser",
        "rateLimitPerUser",
        "range",
        "Channel rateLimitPerUser must be null or an integer from 0 through 21,600 seconds",
    ],
] as const)("%s reports its fixed %s failure", (operation, key, path, constraint, explanation) => {
    expect(detail(run[operation]({ [key]: {} }))).toEqual({ path, constraint, explanation })
})

test("thread search treats a null limit as the default and sends it", () => {
    const request = threadSearch("1", { limit: null } as never, () => undefined)
    expect(request).not.toBeInstanceOf(InputValidationFailure)
    expect((request as { path: string }).path).toBe("/channels/1/threads/search?limit=25")
    expect((threadSearch("1", {}, () => undefined) as { path: string }).path).toBe("/channels/1/threads/search")
})
