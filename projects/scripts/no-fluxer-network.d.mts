/** Whether a host name is Fluxer's or one of its subdomains */
export function isFluxerHost(host: unknown): boolean
/** Every request this process tried to send to Fluxer, for a test runner hook to fail on */
export const blockedFluxerRequests: string[]
