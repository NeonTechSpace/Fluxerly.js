const shared = {
    "local helper namespaces": [
        "assets",
        "colors",
        "display",
        "format",
        "hierarchy",
        "links",
        "permissionBits",
        "snowflakes",
        "text",
    ],
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
        "GuildMfaLevels",
        "GuildMemberProfileFlags",
        "GuildSplashCardAlignments",
        "GuildSystemChannelFlags",
        "GuildVerificationLevels",
        "MemberMentionPreferences",
        "MessageFlags",
        "MessageType",
        "OAuthScopes",
        "Permissions",
        "TimestampStyles",
        "WebhookType",
    ],
    "public error classes": [
        "ApplicationError",
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
        "FluxerlyError",
        "GatewaySendError",
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
        "RestRequestError",
        "ShardConnectionError",
        "SupervisorChildError",
        "SupervisorError",
        "UserOperationError",
        "WebhookOperationError",
    ],
    "error tools": ["describeError", "errors"],
    "client factory": ["createClient", "runBot"],
    "standalone webhook factory": ["createWebhookClient"],
    "OAuth client tools": ["oauth"],
    "command tools": ["commands", "guards"],
    "supervisor factory and tools": ["supervisor"],
}

/**
 * Exact runtime value exports of each public entry point, grouped by purpose. The default API alone exports its Result
 * cancellation and defect values and orThrow, and only the Effect API exports its Context service
 */
export const moduleConformance = Object.freeze({
    default: Object.freeze({
        entrypoint: "@neontechspace/fluxerly",
        categories: Object.freeze({
            ...shared,
            "default-only errors": ["CancelledError", "SdkDefect"],
            "default-only result tools": ["orThrow"],
        }),
    }),
    effect: Object.freeze({
        entrypoint: "@neontechspace/fluxerly/effect",
        categories: Object.freeze({
            ...shared,
            "Effect-only Context service": ["FluxerClient"],
        }),
    }),
    testing: Object.freeze({
        entrypoint: "@neontechspace/fluxerly/testing",
        categories: Object.freeze({
            "test client factories": ["createTestBot", "createTestClient"],
            "wire fixture builders": ["createFixtures", "fixtures", "fixtureToken"],
            "test wait and failure errors": ["TestTimeoutError", "UnhandledTestFailuresError"],
        }),
    }),
    effectTesting: Object.freeze({
        entrypoint: "@neontechspace/fluxerly/effect/testing",
        categories: Object.freeze({
            "test client factories": ["createTestBot", "createTestClient"],
            "wire fixture builders": ["createFixtures", "fixtures", "fixtureToken"],
            "test wait and failure errors": ["TestTimeoutError", "UnhandledTestFailuresError"],
            "test client service": ["FluxerTestClient"],
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
