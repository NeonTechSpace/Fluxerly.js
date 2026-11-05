import { expect, test } from "vitest"
import { Permissions } from "../../src/index.js"
import { eachEntry, operationTable } from "../../src/internal/binding/operations.js"
import {
    permissionRequirement,
    permissionRequirements,
    requiredPermissionsHint,
} from "../../src/internal/permission-requirements.js"

test("every permission requirement belongs to a client operation and names known permissions", () => {
    const operations = new Set<string>()
    eachEntry(operationTable(), (_entry, id) => operations.add(id))
    const entries = Object.entries(permissionRequirements)
    expect(entries.length).toBeGreaterThan(0)
    for (const [operation, requirement] of entries) {
        expect(operations, operation).toContain(operation)
        expect(requirement.permissions.length, operation).toBeGreaterThan(0)
        for (const name of requirement.permissions)
            expect(Object.hasOwn(Permissions, name), `${operation} ${name}`).toBe(true)
    }
})

// Fluxer refuses age-restricted expressions outside their community whatever the bot's permissions, so the hints say so
// instead of only suggesting permissions (MessageStickerService.ts:41-43 and 62-64, MessageReactionService.ts:409-412 at
// 0098958f)
test("missing-permission hints for sends and reactions name the age-restricted refusal", () => {
    const send = requiredPermissionsHint(permissionRequirement("send")!)
    expect(send).toContain(
        "A sticker from an age-restricted community is refused outside that community, whatever the bot's permissions",
    )
    const reaction = requiredPermissionsHint(permissionRequirement("addReaction")!)
    expect(reaction).toContain(
        "A new reaction with a custom emoji from an age-restricted community is refused outside that community, whatever the bot's permissions",
    )
    expect(reaction).toContain("Adding to an existing reaction needs no")
})
