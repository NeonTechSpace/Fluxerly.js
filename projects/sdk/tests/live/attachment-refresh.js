import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { pacedDeadlineMs } from "./support/watchdogs.js"

/** One refresh or download request with its paced slot */
const mediaTimeoutMs = pacedDeadlineMs(60_000, 1)

/** Refresh one test-owned uploaded attachment and verify its bytes through the returned URL */
export async function verifyAttachmentRefresh({ ops, attachment, size, digest, setStage, report }) {
    assert.equal(typeof attachment.url, "string")
    const original = attachment.url
    setStage("attachment_refresh_ordered_mapping")
    // Fluxer serves the refresh route, so any rejection, including a 404, fails the check
    const refreshed = await ops.refreshUrls([original], { timeoutMs: mediaTimeoutMs })
    assert.equal(refreshed.length, 1)
    assert.equal(refreshed[0].original, original)
    assert.equal(typeof refreshed[0].refreshed, "string")
    assert.ok(refreshed[0].refreshed.length > 0)
    report("attachment_refresh_ordered_mapping", true)

    setStage("attachment_refresh_bounded_digest_readback")
    const bytes = await ops.download(
        { ...attachment, url: refreshed[0].refreshed },
        { maxBytes: size, timeoutMs: mediaTimeoutMs },
    )
    assert.equal(bytes.byteLength, size)
    assert.equal(createHash("sha256").update(bytes).digest("hex"), digest)
    report("attachment_refresh_bounded_digest_readback", true)
    report(
        refreshed[0].refreshed === original ? "attachment_refresh_url_unchanged" : "attachment_refresh_url_reissued",
        true,
    )
}
