/**
 * The hosted Fluxer instance discovery document served by test transports.
 * Invariant: The document matches what hosted Fluxer publishes at its bootstrap URL, so a client under test resolves the
 * same API, gateway and media origins it uses in production without any network request.
 * Implements [SDK contracts: Connection and recovery](/docs/SDK-CONTRACTS.md#connection-and-recovery)
 */

/** The bootstrap URL a client with the default instance reads first */
export const hostedDiscoveryUrl = "https://fluxer.app/.well-known/fluxer"

/** The public document hosted Fluxer serves at the bootstrap URL */
export const hostedDiscoveryDocument = Object.freeze({
    api_code_version: 1,
    endpoints: Object.freeze({
        api_public: "https://api.fluxer.app",
        gateway: "wss://gateway.fluxer.app",
        media: "https://fluxerusercontent.com",
        static_cdn: "https://fluxerstatic.com",
        webapp: "https://fluxer.app",
        invite: "https://fluxer.gg",
    }),
    features: Object.freeze({ presigned_attachment_uploads: true }),
})
