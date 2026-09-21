import assert from "node:assert/strict"
import { createHash } from "node:crypto"

/** Refresh one test-owned uploaded attachment and verify its bytes through the returned URL */
export async function verifyAttachmentRefresh({ ops, attachment, size, digest, setStage, report }) {
    assert.equal(typeof attachment.url, "string")
    const original = attachment.url
    setStage("attachment_refresh_ordered_mapping")
    let refreshed
    try {
        refreshed = await ops.refreshUrls([original], { timeoutMs: 60_000 })
    } catch (error) {
        if (
            error?._tag === "AttachmentRefreshError" &&
            error.operation === "attachments.refreshUrls" &&
            error.status === 404
        ) {
            setStage("attachment_refresh_unavailable_404")
            report("attachment_refresh_unavailable_404", false)
            return
        }
        throw error
    }
    assert.equal(refreshed.length, 1)
    assert.equal(refreshed[0].original, original)
    assert.equal(typeof refreshed[0].refreshed, "string")
    assert.ok(refreshed[0].refreshed.length > 0)
    report("attachment_refresh_ordered_mapping", true)

    setStage("attachment_refresh_bounded_digest_readback")
    const bytes = await ops.download(
        { ...attachment, url: refreshed[0].refreshed },
        { maxBytes: size, timeoutMs: 60_000 },
    )
    assert.equal(bytes.byteLength, size)
    assert.equal(createHash("sha256").update(bytes).digest("hex"), digest)
    report("attachment_refresh_bounded_digest_readback", true)
    report(
        refreshed[0].refreshed === original ? "attachment_refresh_url_unchanged" : "attachment_refresh_url_reissued",
        true,
    )
}
