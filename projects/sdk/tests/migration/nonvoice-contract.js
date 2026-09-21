function fail(message) {
    throw new Error(message)
}

function equal(actual, expected, label) {
    const left = JSON.stringify(actual)
    const right = JSON.stringify(expected)
    if (left !== right) fail(`${label}: expected ${right}, received ${left}`)
}

function ok(value, label) {
    if (!value) fail(label)
}

export async function runNonVoiceMigrationContract(adapter) {
    const replies = []
    const database = {
        fail: false,
        async greeting(userId) {
            if (this.fail) throw new Error("fixture database unavailable")
            return `Hello, ${userId}`
        },
    }

    async function handleCommand(message) {
        if (message.content !== "!hello") return { kind: "ignored" }
        try {
            const content = await database.greeting(message.authorId)
            await adapter.reply(message, content)
            replies.push(content)
            return { kind: "replied", content }
        } catch (error) {
            return { kind: "applicationError", message: error instanceof Error ? error.message : "Unknown error" }
        }
    }

    equal(await handleCommand(adapter.message), { kind: "replied", content: "Hello, 30" }, "command reply")
    database.fail = true
    equal(
        await handleCommand(adapter.message),
        { kind: "applicationError", message: "fixture database unavailable" },
        "database failure",
    )
    database.fail = false
    equal(replies, ["Hello, 30"], "failed commands must not replay a reply")

    equal(await adapter.history("20", 3), ["30", "20", "10"], "bounded history")
    equal(adapter.historyRequests(), [null, "20"], "history cursors")

    equal(await adapter.kick({ guildId: "10", userId: "30" }, "migration fixture"), { kind: "succeeded" }, "kick")
    adapter.failNextKick()
    equal(
        await adapter.kick({ guildId: "10", userId: "30" }, "migration fixture"),
        { kind: "failed", outcome: "unknown" },
        "uncertain kick",
    )
    equal(adapter.kickAttempts(), 2, "application adapter must not call kick again")

    const attachment = {
        url: "https://cdn.example.test/attachments/old?expires=1",
        expired: true,
    }
    const prepared = await adapter.prepareAttachment(attachment)
    if (adapter.capabilities.attachmentRefresh) {
        equal(
            prepared,
            { kind: "ready", url: "https://cdn.example.test/attachments/fresh?expires=2" },
            "attachment refresh",
        )
    } else {
        equal(prepared, { kind: "unsupported", reason: "attachmentRefresh" }, "attachment refresh gap")
    }

    const health = adapter.health()
    equal(health.sdk, adapter.name, "health SDK name")
    ok(health.gateway === "notStarted" || health.gateway === "ready", "health gateway state")
    ok(Number.isSafeInteger(health.cachedMessages) && health.cachedMessages >= 0, "health cache count")

    await adapter.close()
    await adapter.close()
    equal(adapter.closeState(), "closed", "idempotent close")
}
