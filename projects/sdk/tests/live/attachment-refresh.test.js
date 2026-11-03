import { expect, test } from "vitest"
import { verifyAttachmentRefresh } from "./attachment-refresh.js"

test("a 404 from the attachment refresh route fails the check at its refresh stage", async () => {
    const notFound = Object.assign(Error("fixture refresh rejection"), {
        _tag: "AttachmentRefreshError",
        operation: "attachments.refreshUrls",
        status: 404,
    })
    const stages = []
    const reports = []
    const run = verifyAttachmentRefresh({
        ops: { refreshUrls: async () => Promise.reject(notFound) },
        attachment: { url: "https://fixture.invalid/attachment.bin" },
        size: 1,
        digest: "",
        setStage: (stage) => stages.push(stage),
        report: (check, passed) => reports.push({ check, passed }),
    })
    await expect(run).rejects.toBe(notFound)
    expect(stages.at(-1)).toBe("attachment_refresh_ordered_mapping")
    expect(reports).toEqual([])
})
