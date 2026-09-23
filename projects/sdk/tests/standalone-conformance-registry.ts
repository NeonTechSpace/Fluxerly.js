import { providerRevision, type NamespaceConformance, type OperationConformance } from "./conformance-registry.js"

/** The existing authenticated upstream source pin used for this bounded registry expansion. */
export const standaloneProviderRevision = providerRevision

export interface StandaloneNamespaceConformance extends NamespaceConformance {
    /** Namespace-shaped members whose operations are inventoried by the named shared registry entry. */
    readonly delegatedNamespaces?: Readonly<Record<string, string>>
}

/**
 * Authored inventory of the two standalone clients exposed by both public entry points.
 *
 * Provider sources were read through authenticated GitHub access at standaloneProviderRevision. Local operations are
 * explicit exclusions from provider-operation metadata. A delegated namespace reuses the existing namespace registry
 * rather than duplicating its operation inventory here.
 */
export const standaloneConformance = {
    OAuthClient: {
        providerOperations: [
            "authorizationUrl",
            "exchangeCode",
            "refresh",
            "revoke",
            "fetchIdentity",
            "fetchGuilds",
            "fetchConnections",
            "introspect",
        ],
        localOperations: {
            shutdown:
                "Releases this standalone client's local secret, discovery, request, and response-reader ownership",
        },
        providerSources: [
            "packages/schema/src/domains/oauth/OAuthSchemas.ts",
            "fluxer_api/src/api/instance/InstanceController.ts",
            "fluxer_api/src/api/oauth/OAuth2Controller.ts",
            "fluxer_api/src/api/guild/controllers/GuildBaseController.ts",
            "fluxer_api/src/api/connection/ConnectionController.ts",
        ],
        positiveEvidence: [
            "tests/oauth.test.ts",
            "tests/oauth-input-boundaries.test.ts",
            "tests/standalone-conformance-reference.test.ts",
            "tests/consumers/standalone-conformance-reference.js",
        ],
        negativeEvidence: [
            "tests/oauth.test.ts",
            "tests/oauth-input-boundaries.test.ts",
            "tests/input-validation.test.ts",
            "tests/standalone-conformance-reference.test.ts",
            "tests/consumers/standalone-conformance-reference.js",
        ],
    },
    WebhookClient: {
        providerOperations: ["fetch", "edit", "delete", "send", "fetchMessage", "editMessage", "deleteMessage"],
        localOperations: {
            id: "Locally retained public webhook identifier without the webhook token",
            shutdown: "Releases this standalone client's local token, discovery, request, upload, and reader ownership",
        },
        delegatedNamespaces: {
            instance: "Instance",
        },
        providerSources: [
            "packages/schema/src/domains/webhook/WebhookRequestSchemas.ts",
            "packages/schema/src/domains/webhook/WebhookSchemas.ts",
            "packages/schema/src/domains/message/MessageRequestSchemas.ts",
            "packages/schema/src/domains/message/MessageResponseSchemas.ts",
            "fluxer_api/src/api/webhook/WebhookController.ts",
        ],
        positiveEvidence: [
            "tests/webhooks.test.ts",
            "tests/message-fields.test.ts",
            "tests/standalone-conformance-reference.test.ts",
            "tests/consumers/standalone-conformance-reference.js",
        ],
        negativeEvidence: [
            "tests/webhooks.test.ts",
            "tests/message-fields.test.ts",
            "tests/input-validation.test.ts",
            "tests/standalone-conformance-reference.test.ts",
            "tests/consumers/standalone-conformance-reference.js",
        ],
    },
} as const satisfies Readonly<Record<"OAuthClient" | "WebhookClient", StandaloneNamespaceConformance>>

const oauthBasic = {
    credential: "confidential-oauth-client HTTP Basic authentication",
    requestOwner: "src/internal/oauth.ts",
    responseOwner: "src/internal/oauth.ts",
    pagination: "none",
    audit: "not-applicable",
} as const

const oauthBearer = {
    credential: "caller-supplied delegated OAuth bearer token",
    requestOwner: "src/internal/oauth.ts",
    responseOwner: "src/internal/oauth.ts",
    pagination: "none",
    audit: "not-applicable",
} as const

const webhookToken = {
    credential: "webhook ID and token in the provider route",
    requestOwner: "src/internal/webhooks.ts",
    responseOwner: "src/internal/webhooks.ts",
    pagination: "none",
    audit: "not-applicable",
} as const

/** Full request-boundary metadata for every provider operation in standaloneConformance. */
export const standaloneOperationConformance = {
    "OAuthClient.authorizationUrl": {
        method: "GET discovery then local URL construction",
        path: "/.well-known/fluxer then discovered web application /oauth2/authorize URL; the authorization URL is returned, not requested",
        credential: "none for discovery; public OAuth client ID in the returned authorization query",
        requestOwner: "src/internal/oauth.ts; src/internal/instance.ts",
        responseOwner: "src/internal/instance.ts; src/internal/oauth.ts",
        rateScope: "not-applicable-no-shared-rate-bucket for discovery; no authorization-route request",
        pagination: "none",
        audit: "not-applicable",
    },
    "OAuthClient.exchangeCode": {
        ...oauthBasic,
        method: "POST",
        path: "/oauth2/token",
        rateScope: "provider oauth:token; standalone OAuth has no coordinated rate-limit wait or retry",
    },
    "OAuthClient.refresh": {
        ...oauthBasic,
        method: "POST",
        path: "/oauth2/token",
        rateScope: "provider oauth:token; standalone OAuth has no coordinated rate-limit wait or retry",
    },
    "OAuthClient.revoke": {
        ...oauthBasic,
        method: "POST",
        path: "/oauth2/token/revoke",
        rateScope:
            "provider oauth:introspect at the pinned controller revision; standalone OAuth has no coordinated rate-limit wait or retry",
    },
    "OAuthClient.fetchIdentity": {
        ...oauthBearer,
        method: "GET",
        path: "/oauth2/userinfo",
        rateScope:
            "provider oauth:introspect at the pinned controller revision; standalone OAuth has no coordinated rate-limit wait or retry",
    },
    "OAuthClient.fetchGuilds": {
        ...oauthBearer,
        method: "GET",
        path: "/users/@me/guilds?limit={limit}&with_counts={boolean}&before={before}|after={after}",
        requestOwner: "src/internal/oauth.ts; src/internal/guild-lifecycle.ts",
        responseOwner: "src/internal/guild-lifecycle.ts",
        rateScope: "provider guild:list; standalone OAuth has no coordinated rate-limit wait or retry",
        pagination: "single before-or-after cursor page",
    },
    "OAuthClient.fetchConnections": {
        ...oauthBearer,
        method: "GET",
        path: "/users/@me/connections",
        rateScope: "provider connection:list; standalone OAuth has no coordinated rate-limit wait or retry",
    },
    "OAuthClient.introspect": {
        ...oauthBasic,
        method: "POST",
        path: "/oauth2/introspect",
        rateScope: "provider oauth:introspect; standalone OAuth has no coordinated rate-limit wait or retry",
    },
    "WebhookClient.fetch": {
        ...webhookToken,
        method: "GET",
        path: "/webhooks/{webhookId}/{token}",
        rateScope: "standalone-webhook-rest:webhook:token, refined to provider webhook:read::webhook_id",
    },
    "WebhookClient.edit": {
        ...webhookToken,
        method: "PATCH",
        path: "/webhooks/{webhookId}/{token}",
        rateScope: "standalone-webhook-rest:webhook:token, refined to provider webhook:update::webhook_id",
    },
    "WebhookClient.delete": {
        ...webhookToken,
        method: "DELETE",
        path: "/webhooks/{webhookId}/{token}",
        rateScope: "standalone-webhook-rest:webhook:token, refined to provider webhook:delete::webhook_id",
    },
    "WebhookClient.send": {
        ...webhookToken,
        method: "POST",
        path: "/webhooks/{webhookId}/{token}?wait=true",
        requestOwner: "src/internal/webhooks.ts; src/internal/message.ts; src/internal/multipart.ts",
        responseOwner: "src/internal/message.ts",
        rateScope: "standalone-webhook-rest:webhook:token, refined to provider webhook:execute::webhook_id",
    },
    "WebhookClient.fetchMessage": {
        ...webhookToken,
        method: "GET",
        path: "/webhooks/{webhookId}/{token}/messages/{messageId}",
        responseOwner: "src/internal/message.ts",
        rateScope: "standalone-webhook-rest:webhook:token, refined to provider webhook:message_get::webhook_id",
    },
    "WebhookClient.editMessage": {
        ...webhookToken,
        method: "PATCH",
        path: "/webhooks/{webhookId}/{token}/messages/{messageId}",
        requestOwner: "src/internal/webhooks.ts; src/internal/message.ts",
        responseOwner: "src/internal/message.ts",
        rateScope: "standalone-webhook-rest:webhook:token, refined to provider webhook:message_edit::webhook_id",
    },
    "WebhookClient.deleteMessage": {
        ...webhookToken,
        method: "DELETE",
        path: "/webhooks/{webhookId}/{token}/messages/{messageId}",
        rateScope: "standalone-webhook-rest:webhook:token, refined to provider webhook:message_delete::webhook_id",
    },
} as const satisfies Readonly<Record<string, OperationConformance>>

export interface ClientTopLevelMemberConformance {
    readonly classification: "provider-facing" | "local-only"
    readonly rationale: string
    readonly defaultMode: string
    readonly effectMode: string
    readonly providerSources: readonly string[]
    readonly positiveEvidence: readonly string[]
    readonly negativeEvidence: readonly string[]
}

const clientLifecycleSources = [
    "fluxer_docs/src/content/docs/gateway/overview.md",
    "fluxer_docs/src/content/docs/gateway/opcodes-and-close-codes.md",
    "fluxer_docs/src/content/docs/gateway/limits-and-rate-limits.md",
    "fluxer_docs/src/content/docs/gateway/events.md",
] as const

const eventEvidence = ["tests/network.test.ts", "tests/event-waits.test.ts"] as const
const lifecycleEvidence = ["tests/client.test.ts", "tests/network.test.ts", "tests/recovery.test.ts"] as const

/**
 * Every Client member outside its 19 namespace-object properties, including inherited ClientState members.
 * Provider-facing means the member starts or consumes gateway protocol work. Local-only members inspect or control
 * SDK-owned state and lifetime without being a provider operation.
 */
export const clientTopLevelConformance = {
    state: {
        classification: "local-only",
        rationale: "Synchronous aggregate snapshot of SDK-owned gateway lifecycle state",
        defaultMode: "Synchronous readonly property",
        effectMode: "The same synchronous readonly property; reading it does not execute an Effect",
        providerSources: [],
        positiveEvidence: ["tests/network.test.ts", "tests/recovery.test.ts"],
        negativeEvidence: ["tests/network.test.ts", "tests/recovery.test.ts"],
    },
    gatewayLatencyMs: {
        classification: "local-only",
        rationale: "Synchronous projection of locally retained heartbeat acknowledgements, not a provider request",
        defaultMode: "Synchronous readonly property returning milliseconds or null",
        effectMode: "The same synchronous readonly property; reading it does not execute an Effect",
        providerSources: [],
        positiveEvidence: ["tests/network.test.ts", "tests/sharding.test.ts"],
        negativeEvidence: ["tests/network.test.ts", "tests/recovery.test.ts"],
    },
    shards: {
        classification: "local-only",
        rationale: "Frozen snapshots of only the shards assigned to this local client",
        defaultMode: "Synchronous readonly property in configured local shard order",
        effectMode: "The same synchronous readonly property; reading it does not execute an Effect",
        providerSources: [],
        positiveEvidence: ["tests/sharding.test.ts", "tests/recovery.test.ts"],
        negativeEvidence: ["tests/sharding-cleanup.test.ts", "tests/recovery.test.ts"],
    },
    on: {
        classification: "provider-facing",
        rationale: "Registers bounded local consumption of future provider gateway events without replay",
        defaultMode: "Registers immediately and returns Result<Subscription>; handlers return void or Promise",
        effectMode: "Returns a scoped Effect that registers when executed; handlers return Effect values",
        providerSources: ["fluxer_docs/src/content/docs/gateway/events.md"],
        positiveEvidence: eventEvidence,
        negativeEvidence: ["tests/network.test.ts", "tests/event-accounting.test.ts"],
    },
    events: {
        classification: "provider-facing",
        rationale: "Exposes future provider gateway events through a bounded local subscription",
        defaultMode: "Registers immediately and returns Result<EventSubscription> with explicit next and unsubscribe",
        effectMode: "Returns a lazy scoped Stream whose execution owns the subscription",
        providerSources: ["fluxer_docs/src/content/docs/gateway/events.md"],
        positiveEvidence: eventEvidence,
        negativeEvidence: ["tests/network.test.ts", "tests/event-waits.test.ts"],
    },
    waitFor: {
        classification: "provider-facing",
        rationale: "Waits for one future provider gateway event accepted by a local filter",
        defaultMode: "Starts observation immediately and returns ResultAsync with AbortSignal cancellation",
        effectMode: "Returns a lazy Effect; fiber interruption owns cancellation and cleanup",
        providerSources: ["fluxer_docs/src/content/docs/gateway/events.md"],
        positiveEvidence: ["tests/event-waits.test.ts"],
        negativeEvidence: ["tests/event-waits.test.ts", "tests/input-validation.test.ts"],
    },
    diagnostics: {
        classification: "local-only",
        rationale: "Reads bounded local occupancy and cache accounting without telemetry or network work",
        defaultMode: "Synchronous frozen snapshot",
        effectMode: "The same synchronous frozen snapshot; it does not execute an Effect",
        providerSources: [],
        positiveEvidence: ["tests/diagnostics.test.ts", "tests/event-accounting.test.ts"],
        negativeEvidence: ["tests/diagnostics.test.ts"],
    },
    connect: {
        classification: "provider-facing",
        rationale: "Starts gateway transport, authentication, and READY processing for locally assigned shards",
        defaultMode: "Starts immediately and returns ResultAsync; AbortSignal controls startup only",
        effectMode: "Starts when the Effect executes; fiber interruption controls startup only",
        providerSources: clientLifecycleSources,
        positiveEvidence: lifecycleEvidence,
        negativeEvidence: lifecycleEvidence,
    },
    run: {
        classification: "provider-facing",
        rationale: "Owns gateway startup and the continuing provider session until final cleanup",
        defaultMode: "Starts immediately and returns ResultAsync; AbortSignal controls the accepted client lifetime",
        effectMode: "Starts when the Effect executes; fiber lifetime owns the accepted client lifetime",
        providerSources: clientLifecycleSources,
        positiveEvidence: lifecycleEvidence,
        negativeEvidence: lifecycleEvidence,
    },
    waitForClose: {
        classification: "local-only",
        rationale: "Observes the retained terminal outcome without starting or owning a provider connection",
        defaultMode: "Starts waiting immediately and returns ResultAsync; AbortSignal cancels only this waiter",
        effectMode: "Returns a lazy Effect; interruption cancels only this waiter",
        providerSources: [],
        positiveEvidence: ["tests/network.test.ts", "tests/recovery.test.ts"],
        negativeEvidence: ["tests/network.test.ts", "tests/recovery.test.ts"],
    },
    shutdown: {
        classification: "local-only",
        rationale: "Permanently closes SDK-owned work and resources; it is not a remote account or resource mutation",
        defaultMode: "Starts immediately and returns ResultAsync; accepts no cancellation signal",
        effectMode: "Returns an Effect and disables interruption once shutdown starts; Scope closure also invokes it",
        providerSources: [],
        positiveEvidence: [
            "tests/client.test.ts",
            "tests/network.test.ts",
            "tests/cleanup-failures.test.ts",
            "tests/standalone-conformance-reference.test.ts",
            "tests/consumers/standalone-conformance-reference.js",
        ],
        negativeEvidence: [
            "tests/network.test.ts",
            "tests/cleanup-failures.test.ts",
            "tests/standalone-conformance-reference.test.ts",
            "tests/consumers/standalone-conformance-reference.js",
        ],
    },
    observeState: {
        classification: "local-only",
        rationale: "Observes local lifecycle transitions without establishing provider readiness or terminal success",
        defaultMode: "Registers a callback immediately and returns a synchronous unsubscribe function",
        effectMode: "Returns a Stream whose execution owns and releases the state subscription",
        providerSources: [],
        positiveEvidence: ["tests/network.test.ts", "tests/recovery.test.ts"],
        negativeEvidence: ["tests/network.test.ts"],
    },
} as const satisfies Readonly<Record<string, ClientTopLevelMemberConformance>>

const clientGatewayEvents = {
    method: "gateway-event intake",
    path: "provider gateway Dispatch events",
    credential: "authenticated-bot-session",
    requestOwner: "src/internal/events.ts",
    responseOwner: "src/internal/events.ts",
    rateScope: "not-applicable-no-outbound-request",
    pagination: "none",
    audit: "not-applicable",
} as const

const clientGatewayLifecycle = {
    method: "GET discovery then WebSocket handshake and gateway Identify or Resume",
    path: "/.well-known/fluxer then discovered gateway URL; gateway opcode 2 or 6",
    credential: "none for discovery; authenticated bot token in gateway Identify or Resume",
    requestOwner: "src/internal/client.ts; src/internal/instance.ts; src/internal/gateway.ts",
    responseOwner: "src/internal/gateway.ts; src/internal/client.ts",
    rateScope: "discovery has no shared rate bucket; client-wide Identify pacing and per-shard recovery backoff",
    pagination: "none",
    audit: "not-applicable",
} as const

/** Full boundary metadata for every provider-facing entry in clientTopLevelConformance. */
export const clientTopLevelOperationConformance = {
    "Client.on": clientGatewayEvents,
    "Client.events": clientGatewayEvents,
    "Client.waitFor": clientGatewayEvents,
    "Client.connect": clientGatewayLifecycle,
    "Client.run": clientGatewayLifecycle,
} as const satisfies Readonly<Record<string, OperationConformance>>

export interface FactoryConformance {
    readonly classification: "local-factory"
    readonly rationale: string
    readonly defaultMode: string
    readonly effectMode: string
    readonly positiveEvidence: readonly string[]
    readonly negativeEvidence: readonly string[]
    readonly negativeEvidenceExclusion?: string
}

/** Selected lifecycle factories only; this is not a complete inventory of either module's exports. */
export const clientFactoryConformance = {
    runBot: {
        classification: "local-factory",
        rationale: "Creates and owns one bot client, its critical subscriptions and shutdown until the run ends",
        defaultMode: "Starts immediately and returns ResultAsync; optional AbortSignal requests graceful shutdown",
        effectMode: "Returns a lazy Effect using the caller's context, Scope and interruption",
        positiveEvidence: ["tests/run-bot.test.ts", "tests/consumers/default.ts", "tests/consumers/effect.ts"],
        negativeEvidence: ["tests/run-bot.test.ts"],
    },
    "oauth.create": {
        classification: "local-factory",
        rationale: "Validates and owns a confidential OAuth client without making a provider request",
        defaultMode: "Runs synchronously and returns Result<OAuthClient, ConfigurationError>",
        effectMode: "Returns a lazy scoped Effect; execution creates the client and Scope closure shuts it down",
        positiveEvidence: [
            "tests/oauth.test.ts",
            "tests/standalone-conformance-reference.test.ts",
            "tests/consumers/standalone-conformance-reference.js",
        ],
        negativeEvidence: [
            "tests/oauth.test.ts",
            "tests/oauth-input-boundaries.test.ts",
            "tests/standalone-conformance-reference.test.ts",
            "tests/consumers/standalone-conformance-reference.js",
        ],
    },
    "oauth.createPkce": {
        classification: "local-factory",
        rationale: "Generates a local random verifier and SHA-256 challenge without storage or a request",
        defaultMode: "Runs immediately and returns the verifier and challenge",
        effectMode: "The same immediate helper; it does not return an Effect",
        positiveEvidence: ["tests/oauth.test.ts"],
        negativeEvidence: [],
        negativeEvidenceExclusion:
            "This input-free random helper has no expected failure channel; cryptographic runtime failure is an unqualified defect",
    },
    createClient: {
        classification: "local-factory",
        rationale: "Validates configuration and constructs a bot client without connecting it",
        defaultMode: "Runs synchronously and returns Result<Client, ConfigurationError>",
        effectMode: "Returns a lazy scoped Effect; execution creates the client and Scope closure shuts it down",
        positiveEvidence: [
            "tests/client.test.ts",
            "tests/network.test.ts",
            "tests/standalone-conformance-reference.test.ts",
            "tests/consumers/standalone-conformance-reference.js",
        ],
        negativeEvidence: [
            "tests/client.test.ts",
            "tests/input-validation.test.ts",
            "tests/standalone-conformance-reference.test.ts",
            "tests/consumers/standalone-conformance-reference.js",
        ],
    },
    createWebhookClient: {
        classification: "local-factory",
        rationale: "Validates and copies one webhook credential into an independently owned client without a request",
        defaultMode: "Runs synchronously and returns Result<WebhookClient, ConfigurationError>",
        effectMode: "Returns a lazy scoped Effect; execution creates the client and Scope closure shuts it down",
        positiveEvidence: [
            "tests/webhooks.test.ts",
            "tests/standalone-conformance-reference.test.ts",
            "tests/consumers/standalone-conformance-reference.js",
        ],
        negativeEvidence: [
            "tests/webhooks.test.ts",
            "tests/input-validation.test.ts",
            "tests/standalone-conformance-reference.test.ts",
            "tests/consumers/standalone-conformance-reference.js",
        ],
    },
} as const satisfies Readonly<Record<string, FactoryConformance>>
