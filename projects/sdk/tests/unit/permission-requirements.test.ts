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

test("missing-permission hints reflect current Fluxer rules for sends, reactions and single-ban reads", () => {
    const send = requiredPermissionsHint(permissionRequirement("send")!)
    expect(send).not.toContain("age-restricted")
    const reaction = requiredPermissionsHint(permissionRequirement("addReaction")!)
    expect(reaction).not.toContain("age-restricted")
    expect(reaction).toContain("Adding to an existing reaction needs no")
    expect(permissionRequirement("members.fetchBan")).toEqual({ scope: "guild", permissions: ["BanMembers"] })
})
