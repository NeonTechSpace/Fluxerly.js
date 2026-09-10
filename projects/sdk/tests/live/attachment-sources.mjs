import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import {
    closeSync,
    existsSync,
    mkdtempSync,
    openAsBlob,
    openSync,
    realpathSync,
    rmdirSync,
    unlinkSync,
    writeSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

const chunkBytes = 65_536
const fileBytes = 3 * chunkBytes
const streamBytes = 10 * 1024 * 1024 + chunkBytes

function generatedChunk(offset, length, salt) {
    const value = new Uint8Array(length)
    for (let index = 0; index < value.length; index++) value[index] = (offset + index + salt) % 251
    return value
}

function generatedDigest(bytes, salt) {
    const hash = createHash("sha256")
    for (let offset = 0; offset < bytes; offset += chunkBytes)
        hash.update(generatedChunk(offset, Math.min(chunkBytes, bytes - offset), salt))
    return hash.digest("hex")
}

function streamSource(bytes, salt) {
    let offset = 0
    let emitted = 0
    let chunks = 0
    const stream = new ReadableStream(
        {
            pull(controller) {
                if (offset === bytes) {
                    controller.close()
                    return
                }
                const value = generatedChunk(offset, Math.min(chunkBytes, bytes - offset), salt)
                offset += value.byteLength
                emitted += value.byteLength
                chunks += 1
                controller.enqueue(value)
            },
        },
        { highWaterMark: 0 },
    )
    return { stream, emitted: () => emitted, chunks: () => chunks }
}

function createOwnedFile(bytes, salt) {
    const createdDirectory = mkdtempSync(join(tmpdir(), "fluxerly-sdk-attachment-source-"))
    let directory = createdDirectory
    let file = resolve(directory, "source.bin")
    try {
        directory = realpathSync(createdDirectory)
        file = resolve(directory, "source.bin")
        assert.equal(dirname(file), directory)
        const descriptor = openSync(file, "wx", 0o600)
        try {
            for (let offset = 0; offset < bytes; offset += chunkBytes) {
                const chunk = generatedChunk(offset, Math.min(chunkBytes, bytes - offset), salt)
                for (let written = 0; written < chunk.byteLength;) written += writeSync(descriptor, chunk, written)
            }
        } finally {
            closeSync(descriptor)
        }
        const resolvedFile = realpathSync(file)
        assert.equal(dirname(resolvedFile), directory)
        return { directory, file: resolvedFile }
    } catch (error) {
        cleanupOwnedFile({ directory, file })
        throw error
    }
}

function cleanupOwnedFile({ directory, file }) {
    assert.equal(dirname(file), directory)
    if (existsSync(file)) unlinkSync(file)
    assert.equal(existsSync(file), false)
    rmdirSync(directory)
    assert.equal(existsSync(directory), false)
}

function requestTarget(input, init) {
    const source = input instanceof Request ? input.url : input instanceof URL ? input.href : input
    return {
        url: new URL(source),
        method: init?.method ?? (input instanceof Request ? input.method : "GET"),
    }
}

function matchingPlan(input, init, url, filename, size) {
    const target = requestTarget(input, init)
    if (target.url.href !== url || target.method !== "POST" || typeof init?.body !== "string") return false
    try {
        const payload = JSON.parse(init.body)
        if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false
        const attachments = payload.attachments
        const attachment = attachments?.[0]
        return (
            Object.keys(payload).length === 1 &&
            Object.hasOwn(payload, "attachments") &&
            Array.isArray(attachments) &&
            attachments.length === 1 &&
            typeof attachment === "object" &&
            attachment !== null &&
            Object.keys(attachment).length === 4 &&
            attachment.id === 0 &&
            attachment.filename === filename &&
            attachment.file_size === size &&
            attachment.content_type === "application/octet-stream"
        )
    } catch {
        return false
    }
}

async function waitFor(check, message) {
    const deadline = performance.now() + 10_000
    while (!check()) {
        assert.ok(performance.now() < deadline, message)
        await sleep(20)
    }
}

async function digestRaw(rawFetch, attachment, size, digest) {
    assert.equal(typeof attachment.url, "string")
    const response = await rawFetch(attachment.url, { redirect: "error", signal: AbortSignal.timeout(60_000) })
    assert.ok(response.ok)
    const hash = createHash("sha256")
    let actual = 0
    for await (const chunk of response.body) {
        actual += chunk.byteLength
        assert.ok(actual <= size)
        hash.update(chunk)
    }
    assert.equal(actual, size)
    assert.equal(hash.digest("hex"), digest)
}

async function verifyDownload(ops, rawFetch, attachment, size, digest) {
    const bytes = await ops.download(attachment, { maxBytes: size, timeoutMs: 60_000 })
    assert.equal(bytes.byteLength, size)
    assert.equal(createHash("sha256").update(bytes).digest("hex"), digest)
    await digestRaw(rawFetch, attachment, size, digest)
}

async function sendAndReadback(ops, rawFetch, setStage, report, source, filename, size, digest, label) {
    setStage(`${label}_upload`)
    const sent = await ops.send(
        { attachments: [{ ...source, filename, contentType: "application/octet-stream" }] },
        { timeoutMs: 120_000 },
    )
    assert.equal(sent.attachments.length, 1)
    const attachment = sent.attachments[0]
    assert.equal(attachment.filename, filename)
    assert.equal(attachment.size, size)
    setStage(`${label}_sdk_and_raw_readback`)
    await verifyDownload(ops, rawFetch, attachment, size, digest)
    report(`${label}_sdk_and_raw_readback`, true)
    return attachment
}

async function verifyCancellation(ops, attachment, size, getFetch, setFetch, setStage, report) {
    const expected = new URL(attachment.url).href
    const previous = getFetch()
    const controllers = []
    const pending = []
    let delayedPulls = 0
    let wrapperCancellations = 0
    let upstreamCancellations = 0
    let upstreamReleases = 0
    setFetch(async (input, init) => {
        const target = requestTarget(input, init)
        if (target.url.href !== expected || target.method !== "GET") return previous(input, init)
        const response = await previous(input, init)
        assert.ok(response.ok)
        const reader = response.body?.getReader()
        assert.ok(reader)
        let exposed = false
        let released = false
        const body = new ReadableStream(
            {
                async pull(controller) {
                    if (!exposed) {
                        const next = await reader.read()
                        assert.equal(next.done, false)
                        assert.ok(next.value instanceof Uint8Array)
                        assert.ok(next.value.byteLength > 0)
                        exposed = true
                        controller.enqueue(next.value)
                        return
                    }
                    delayedPulls += 1
                    return new Promise(() => {})
                },
                async cancel(reason) {
                    wrapperCancellations += 1
                    try {
                        try {
                            await reader.cancel(reason)
                        } catch (error) {
                            // Native fetch may already have closed the body with this exact request's abort reason
                            if (!(init?.signal?.aborted && error === init.signal.reason)) throw error
                        }
                        upstreamCancellations += 1
                    } finally {
                        if (!released) {
                            reader.releaseLock()
                            released = true
                            upstreamReleases += 1
                        }
                    }
                },
            },
            { highWaterMark: 0 },
        )
        return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        })
    })
    try {
        setStage("attachment_sources_download_cancellation_test_owned_delayed_eof")
        const first = new AbortController()
        controllers.push(first)
        const firstPending = ops.cancelDownload(attachment, size, first.signal)
        pending.push(firstPending)
        await waitFor(() => delayedPulls === 1, "Delayed attachment reader did not begin")
        first.abort()
        await firstPending
        await waitFor(
            () => wrapperCancellations === 1 && upstreamCancellations === 1 && upstreamReleases === 1,
            "Cancelled attachment reader was not released",
        )

        // Four starts after the first cancellation establish that its media slot was released
        const laterControllers = Array.from({ length: 4 }, () => new AbortController())
        controllers.push(...laterControllers)
        const starts = laterControllers.map((controller) => ops.cancelDownload(attachment, size, controller.signal))
        pending.push(...starts)
        await waitFor(() => delayedPulls === 5, "Cancelled download retained a client HTTP slot")
        for (const controller of laterControllers) controller.abort()
        await Promise.all(starts)
        await waitFor(
            () => wrapperCancellations === 5 && upstreamCancellations === 5 && upstreamReleases === 5,
            "Cancelled attachment readers were not released",
        )
        report("attachment_sources_download_cancellation_test_owned_delayed_eof", true)
    } finally {
        for (const controller of controllers) controller.abort()
        await Promise.allSettled(pending)
        setFetch(previous)
    }
}

async function verifyInlineFallback(ops, rawFetch, getFetch, setFetch, channelId, setStage, report) {
    const filename = `attachment-inline-${randomUUID()}.bin`
    const bytes = 2 * chunkBytes
    const source = streamSource(bytes, 43)
    const digest = generatedDigest(bytes, 43)
    const planUrl = `https://api.fluxer.app/v1/channels/${channelId}/attachments`
    const previous = getFetch()
    let injected = 0
    setFetch(async (input, init) => {
        if (!matchingPlan(input, init, planUrl, filename, bytes)) return previous(input, init)
        injected += 1
        assert.equal(injected, 1)
        return Response.json({ code: "FEATURE_TEMPORARILY_DISABLED" }, { status: 403 })
    })
    try {
        setStage("attachment_sources_exact_feature_disabled_plan_fallback")
        const sent = await ops.send(
            {
                attachments: [
                    {
                        stream: source.stream,
                        size: bytes,
                        filename,
                        contentType: "application/octet-stream",
                    },
                ],
            },
            { timeoutMs: 60_000 },
        )
        assert.equal(injected, 1)
        assert.equal(sent.attachments.length, 1)
        const attachment = sent.attachments[0]
        assert.equal(attachment.filename, filename)
        assert.equal(attachment.size, bytes)
        assert.equal(source.emitted(), bytes)
        assert.equal(source.chunks(), bytes / chunkBytes)
        await verifyDownload(ops, rawFetch, attachment, bytes, digest)
        report("attachment_sources_exact_feature_disabled_plan_fallback", true)
    } finally {
        setFetch(previous)
    }
}

/** Exercise caller-owned file and stream attachment sources against the existing journaled live channel */
export async function verifyAttachmentSources({ ops, channelId, rawFetch, getFetch, setFetch, setStage, report }) {
    const fileSalt = 17
    const fileDigest = generatedDigest(fileBytes, fileSalt)
    const temporary = createOwnedFile(fileBytes, fileSalt)
    try {
        const blob = await openAsBlob(temporary.file)
        assert.equal(blob.size, fileBytes)
        const fileAttachment = await sendAndReadback(
            ops,
            rawFetch,
            setStage,
            report,
            { file: blob },
            `attachment-file-${randomUUID()}.bin`,
            fileBytes,
            fileDigest,
            "attachment_sources_open_as_blob",
        )

        setStage("attachment_sources_download_too_small")
        const tooSmall = await ops.downloadFailure(fileAttachment, { maxBytes: fileBytes - 1, timeoutMs: 60_000 })
        assert.equal(tooSmall?._tag, "AttachmentDownloadError")
        assert.equal(tooSmall?.reason, "tooLarge")
        report("attachment_sources_download_too_small", true)
        await verifyCancellation(ops, fileAttachment, fileBytes, getFetch, setFetch, setStage, report)

        const streamSalt = 29
        const source = streamSource(streamBytes, streamSalt)
        const streamDigest = generatedDigest(streamBytes, streamSalt)
        const previous = getFetch()
        let putCount = 0
        setFetch(async (input, init) => {
            const target = requestTarget(input, init)
            if (target.method === "PUT") putCount += 1
            return previous(input, init)
        })
        try {
            await sendAndReadback(
                ops,
                rawFetch,
                setStage,
                report,
                { stream: source.stream, size: streamBytes },
                `attachment-stream-${randomUUID()}.bin`,
                streamBytes,
                streamDigest,
                "attachment_sources_stream_multipart",
            )
        } finally {
            setFetch(previous)
        }
        assert.equal(source.emitted(), streamBytes)
        assert.equal(source.chunks(), streamBytes / chunkBytes)
        assert.ok(putCount >= 2)
        report("attachment_sources_stream_multipart", true)

        await verifyInlineFallback(ops, rawFetch, getFetch, setFetch, channelId, setStage, report)
    } finally {
        cleanupOwnedFile(temporary)
    }
}
