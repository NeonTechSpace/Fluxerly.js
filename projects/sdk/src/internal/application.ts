import type { BotApplication } from "#sdk/application"
import { identifier, record } from "./message.js"

/** Validated current-application request; shared REST owns admission, retries, and cleanup */
export interface BotApplicationRequest<A> {
    readonly path: string
    readonly method: "GET"
    readonly status: 200
    readonly decode: (value: unknown) => A | undefined
}

const nullableText = (value: unknown): value is string | null => value === null || typeof value === "string"

function decodeApplication(value: unknown): BotApplication | undefined {
    if (
        !record(value) ||
        !identifier(value.id) ||
        typeof value.name !== "string" ||
        !nullableText(value.icon) ||
        !nullableText(value.description) ||
        typeof value.bot_public !== "boolean" ||
        typeof value.bot_require_code_grant !== "boolean"
    )
        return undefined
    return Object.freeze({
        id: value.id,
        name: value.name,
        icon: value.icon,
        description: value.description,
        botPublic: value.bot_public,
        botRequireCodeGrant: value.bot_require_code_grant,
    })
}

/** Fetch only the bot-token response's public application fields, without cache retention or owner/application management */
export function applicationCurrent(): BotApplicationRequest<BotApplication> {
    return {
        path: "/oauth2/applications/@me",
        method: "GET",
        status: 200,
        decode: decodeApplication,
    }
}
