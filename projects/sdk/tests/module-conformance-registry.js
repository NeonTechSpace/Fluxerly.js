const shared = {
    "local helper namespaces": [
        "assets",
        "colors",
        "display",
        "format",
        "links",
        "permissionBits",
        "snowflakes",
        "text",
    ],
    "local helper functions": ["canManageHierarchy", "compareHierarchy", "isAboveInHierarchy"],
    "local builders": ["builders", "EmbedBuilder", "MessageBuilder"],
    "local constants": [
        "AssetFormats",
        "AuditLogActions",
        "ChannelType",
        "DiscoveryCategories",
        "GuildContentWarningLevels",
        "GuildDefaultMessageNotifications",
        "GuildExplicitContentFilters",
        "GuildFeatureToggles",
        "GuildMemberJoinSourceTypes",
        "GuildMemberProfileFlags",
        "GuildSplashCardAlignments",
        "GuildSystemChannelFlags",
        "GuildVerificationLevels",
        "MemberMentionPreferences",
        "MessageFlags",
        "OAuthScopes",
        "Permissions",
        "TimestampStyles",
    ],
    "public error classes": [
        "AssetUrlError",
        "AttachmentDownloadError",
        "AttachmentRefreshError",
        "AuthenticationError",
        "BotApplicationOperationError",
        "ChannelOperationError",
        "ClientBusyError",
        "ClientClosedError",
        "CollectorError",
        "ConfigurationError",
        "ConnectionError",
        "ConnectionTimeoutError",
        "CriticalWorkerStoppedError",
        "CountOperationError",
        "EventOverflowError",
        "EventReadBusyError",
        "EventWaitError",
        "GuildOperationError",
        "HelperError",
        "MemberChunkError",
        "MessageCleanupError",
        "MessageError",
        "MessageOperationError",
        "OAuthOperationError",
        "PaginationError",
        "PresenceError",
        "RateLimitError",
        "ShardConnectionError",
        "SupervisorChildError",
        "SupervisorError",
        "UserOperationError",
        "WebhookOperationError",
    ],
    "client factory": ["createClient", "runBot"],
    "standalone webhook factory": ["createWebhookClient"],
    "local PKCE factory": ["createPkce"],
    "OAuth client tools": ["oauth"],
    "command tools": ["commands"],
    "supervisor factory and tools": ["supervisor"],
}

export const moduleConformance = Object.freeze({
    default: Object.freeze({
        entrypoint: "@neontechspace/fluxerly",
        categories: Object.freeze({
            ...shared,
            "default-only errors": ["CancelledError", "SdkDefect"],
            "default-only logging adapter": ["fromStructuredLogger"],
        }),
        intentionalDifferences: Object.freeze({
            onlyHere: ["CancelledError", "SdkDefect", "fromStructuredLogger"],
            onlyInOtherEntrypoint: ["fromEffectLogger"],
            rationale:
                "The default API exposes Result cancellation and defect values plus a structured-logger adapter; it does not require Effect logging values",
        }),
    }),
    effect: Object.freeze({
        entrypoint: "@neontechspace/fluxerly/effect",
        categories: Object.freeze({
            ...shared,
            "Effect-only logging adapter": ["fromEffectLogger"],
        }),
        intentionalDifferences: Object.freeze({
            onlyHere: ["fromEffectLogger"],
            onlyInOtherEntrypoint: ["CancelledError", "SdkDefect", "fromStructuredLogger"],
            rationale:
                "The Effect API preserves interruption and defects in Effect Cause and adapts Effect Logger values instead of exporting default Result wrappers",
        }),
    }),
})

function duplicateNames(categories) {
    const names = Object.values(categories).flat()
    return names.filter((name, index) => names.indexOf(name) !== index)
}

export function expectedModuleExports(mode) {
    const contract = moduleConformance[mode]
    if (!contract) throw new TypeError(`Unknown module conformance mode: ${mode}`)
    const duplicates = duplicateNames(contract.categories)
    if (duplicates.length > 0)
        throw new Error(`${mode} module inventory contains duplicate names: ${duplicates.join(", ")}`)
    return Object.values(contract.categories).flat().sort()
}

export function validateModuleConformance(mode, moduleObject) {
    const expected = expectedModuleExports(mode)
    const actual = Object.keys(moduleObject).sort()
    const missing = expected.filter((name) => !actual.includes(name))
    const added = actual.filter((name) => !expected.includes(name))
    if (missing.length > 0 || added.length > 0) {
        const details = [
            missing.length > 0 ? `missing: ${missing.join(", ")}` : "",
            added.length > 0 ? `added: ${added.join(", ")}` : "",
        ]
            .filter(Boolean)
            .join("; ")
        throw new Error(`${moduleConformance[mode].entrypoint} runtime export mismatch (${details})`)
    }
    return Object.freeze({ mode, names: Object.freeze(actual) })
}
