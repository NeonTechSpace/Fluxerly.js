// Messages, hints and code catalogue texts follow the repository's rules for text the SDK shows to people: A capital
// letter after a colon and space unless machine syntax follows, no em dash, no semicolon, and no period at the end of a
// message, line or paragraph. The tables and builders below hold most of these texts, so a new entry that breaks a rule
// fails here instead of reaching a log, an error or the website's codes page
import { expect, test } from "vitest"
import {
    apiErrorDetail,
    apiErrorHint,
    apiErrorMappings,
    operationErrorMessage,
    operationFailureHint,
    responseFieldText,
    validationErrorMappings,
    type RequestAction,
    type RequestCredential,
} from "../../src/api-errors.js"
import { CollectorError } from "../../src/collectors.js"
import { ConnectionError, operationHint } from "../../src/errors.js"
import { GatewaySendError } from "../../src/gateway.js"
import { errorCodes, logCodes, operationReasonMeanings, type CodeEntry } from "../../src/internal/code-catalogue.js"
import { CloseCode, closeActionText, closeCodeInfo } from "../../src/internal/protocol/gateway.js"
import { PaginationError } from "../../src/pagination.js"
import { SupervisorError } from "../../src/supervisor.js"

// Plain lowercase words that are exact option values, such as `confirm: true`, may follow a colon
const exactValues = new Set(["true", "false", "null"])
// Written as a code so this file passes the repository's em dash lint
const emDash = String.fromCharCode(0x2014)

/** The rules a text breaks, each with the part that breaks it */
function wordingProblems(text: string): string[] {
    const problems: string[] = []
    if (text.includes(emDash)) problems.push("em dash")
    for (const match of text.matchAll(/\S*;(?=\s|$)/g)) problems.push(`semicolon in ${JSON.stringify(match[0])}`)
    // A wrapped line may end one sentence inside a paragraph, so only the end of a paragraph is checked
    for (const paragraph of text.split(/\n\s*\n/))
        if (/[^.]\.\s*$/.test(paragraph))
            problems.push(`final period in ${JSON.stringify(paragraph.trim().slice(-40))}`)
    // An identifier such as fields.reason or messageCreate continues past the lowercase letters and is kept as written
    for (const match of text.matchAll(/: ([a-z]+)(?=[\s,)]|$)/g))
        if (!exactValues.has(match[1]!)) problems.push(`lowercase after a colon in ${JSON.stringify(match[0])}`)
    return problems
}

/** Every rule a list of labelled texts breaks, keyed by label, so a failure names the entry to fix */
function problemsIn(texts: Iterable<readonly [string, string | undefined]>): Record<string, string[]> {
    const found: Record<string, string[]> = {}
    for (const [label, text] of texts) {
        if (text === undefined) continue
        const problems = wordingProblems(text)
        if (problems.length > 0) found[label] = problems
    }
    return found
}

test("the rules catch each kind of break and keep identifiers and exact values", () => {
    expect(wordingProblems("Fluxer refused the request: missing permission")).toHaveLength(1)
    expect(wordingProblems("Fluxer refused the request.")).toHaveLength(1)
    expect(wordingProblems("The value is invalid; use null")).toHaveLength(1)
    expect(wordingProblems(`Ends here${emDash}then more`)).toHaveLength(1)
    expect(
        wordingProblems(
            "Wrapped text ends one sentence.\nThe next line ends the paragraph\n\nAnother paragraph ends with no period",
        ),
    ).toEqual([])
    expect(
        wordingProblems(
            "fields.reason says why: fields.pause is set. Retry after 1.5 s, pass { confirm: true } or call: messageCreate",
        ),
    ).toEqual([])
})

const operationReasons = [
    ...Object.keys(operationReasonMeanings),
    "tooLarge",
    "untrustedUrl",
    "notConnected",
    "connectionLost",
    "overflow",
    "filter",
    "closed",
]
const outcomes = ["notDispatched", "rejected", "unknown"]
const providerCodes = Object.keys(apiErrorMappings) as (keyof typeof apiErrorMappings)[]
const statuses = [null, 400, 401, 403, 404, 423, 429, 500]
const credentials: RequestCredential[] = ["bot", "webhook", "oauthClient", "oauthUser"]
const actions: RequestAction[] = [
    "message",
    "moderation",
    "memberRole",
    "unban",
    "setOverwrite",
    "removeOverwrite",
    "other",
]
const oauthErrors = [
    "invalid_grant",
    "invalid_client",
    "invalid_request",
    "invalid_scope",
    "unauthorized_client",
    "unsupported_grant_type",
]
const responseFields = ["body", "status", "tooMany", "order", "channelMismatch", "idMismatch", "targetMismatch", "id"]

test("code catalogue meanings and actions follow the wording rules", () => {
    expect(
        problemsIn([
            ...Object.entries(operationReasonMeanings).map(([reason, text]) => [`reason ${reason}`, text] as const),
            ...Object.entries<CodeEntry>({ ...errorCodes, ...logCodes }).flatMap(([code, entry]) => [
                [`${code} meaning`, entry.meaning] as const,
                [`${code} action`, entry.action] as const,
            ]),
        ]),
    ).toEqual({})
})

test("Fluxer rejection explanations and hints follow the wording rules", () => {
    const texts: [string, string | undefined][] = [
        ...providerCodes.map((code): [string, string] => [code, apiErrorMappings[code].explanation]),
        ...Object.entries(validationErrorMappings),
        ...responseFields.map((field): [string, string] => [`responseField ${field}`, responseFieldText(field)]),
    ]
    for (const providerCode of [...providerCodes, null])
        for (const status of statuses)
            for (const credential of credentials)
                for (const action of actions)
                    texts.push([
                        `apiErrorHint ${providerCode} ${status} ${credential} ${action}`,
                        apiErrorHint(
                            providerCode === null ? null : apiErrorDetail({ code: providerCode }),
                            status,
                            credential,
                            action,
                        ),
                    ])
    expect(problemsIn(texts)).toEqual({})
})

test("operation error messages and hints follow the wording rules", () => {
    const texts: [string, string | undefined][] = []
    for (const reason of operationReasons)
        for (const outcome of outcomes) {
            for (const retryAfterMs of [null, 1500])
                for (const read of [false, true])
                    for (const streamUsed of [false, true])
                        texts.push([
                            `operationHint ${reason} ${outcome} ${retryAfterMs} ${read} ${streamUsed}`,
                            operationHint(reason, outcome, retryAfterMs, { read, streamUsed }),
                        ])
            for (const providerCode of [...providerCodes, null])
                for (const status of statuses) {
                    const apiError = providerCode === null ? null : apiErrorDetail({ code: providerCode })
                    const label = `${reason} ${outcome} ${providerCode} ${status}`
                    texts.push(
                        [
                            `operationErrorMessage ${label}`,
                            operationErrorMessage({
                                subject: "Message",
                                operation: "messages.send",
                                reason,
                                outcome,
                                status,
                                apiError,
                                retryAfterMs: status === 429 ? 1500 : null,
                            }),
                        ],
                        [
                            `operationFailureHint ${label}`,
                            operationFailureHint({ reason, outcome, status, apiError, inputPath: "content" }),
                        ],
                    )
                }
            for (const oauthError of oauthErrors)
                texts.push([
                    `oauth ${reason} ${outcome} ${oauthError}`,
                    operationFailureHint({ reason, outcome, oauthError }),
                ])
            for (const responseField of responseFields)
                texts.push([
                    `operationErrorMessage ${reason} ${outcome} responseField ${responseField}`,
                    operationErrorMessage({
                        subject: "Message",
                        operation: "send",
                        reason,
                        outcome,
                        facts: { responseField, providerCode: "NEW_CODE" },
                    }),
                ])
        }
    expect(problemsIn(texts)).toEqual({})
})

test("connection, gateway command, collector, pagination and supervisor errors follow the wording rules", () => {
    const errors: Error[] = []
    for (const phase of ["discovery", "gateway"] as const)
        for (const reason of ["network", "protocol", "closed"] as const)
            for (const status of [null, 302, 503, 1006, ...Object.values(CloseCode)])
                for (const detail of [undefined, "received a dispatch before READY"])
                    errors.push(
                        new ConnectionError(
                            phase,
                            reason,
                            status,
                            detail === undefined ? undefined : { details: { detail } },
                        ),
                    )
    for (const reason of ["input", "reserved", "notOwned", "notReady", "busy"] as const)
        for (const opcode of [null, 1]) errors.push(new GatewaySendError({ reason, shardId: 0, opcode }))
    for (const reason of ["notConnected", "connectionLost", "filter", "handler", "overflow"] as const)
        for (const limit of [null, "maxBytes", "maxPendingMessages", "maxPendingBytes"] as const)
            for (const capacity of [null, 1, 2]) errors.push(new CollectorError(reason, limit, capacity))
    for (const reason of ["input", "cursorStalled", "pageLimit", "indexing"] as const)
        errors.push(new PaginationError({ operation: "iterateHistory", reason }))
    for (const childId of [null, "worker"])
        for (const reason of ["closed", "spawn", "protocol", "restartLimit", "startupTimeout", "shardCount"] as const)
            errors.push(new SupervisorError(childId, reason))
    const texts: [string, string | undefined][] = errors.flatMap((error, index) => [
        [`${index} ${error.name} message`, error.message],
        [`${index} ${error.name} hint`, (error as { hint?: string }).hint],
    ])
    for (const code of [...Object.values(CloseCode), 4999])
        texts.push([`close code ${code}`, closeCodeInfo(code).meaning])
    for (const rateLimited of [false, true])
        for (const resume of [false, true])
            for (const established of [false, true])
                texts.push([
                    `close action ${rateLimited} ${resume} ${established}`,
                    closeActionText(rateLimited, resume, "1.5 s", established),
                ])
    expect(problemsIn(texts)).toEqual({})
})
