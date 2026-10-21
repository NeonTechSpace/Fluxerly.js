/**
 * REST module entry: One client's request scheduler, split into [owner](/projects/sdk/src/internal/rest/owner.ts),
 * [admission](/projects/sdk/src/internal/rest/admission.ts), [attempt](/projects/sdk/src/internal/rest/attempt.ts),
 * [classify](/projects/sdk/src/internal/rest/classify.ts) and [download](/projects/sdk/src/internal/rest/download.ts).
 * Invariant: Code outside REST reaches the scheduler only through this entry, while the standalone helpers
 * rest/closed and rest/options are imported directly. Implements
 * [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
export { RestOwner } from "./rest/owner.js"
export type { AttachmentDownloadSource } from "./rest/download.js"
