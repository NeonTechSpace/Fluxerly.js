// Compatibility repairs belong to the build's temporary content, never the immutable release asset or current model
import { isDeepStrictEqual } from "node:util"

const attachment = { r: "AttachmentInput", h: "/docs/api/js-ts/messages/#attachmentinput" }
const embed = { k: "union", t: [{ r: "EmbedInput", h: "/docs/api/js-ts/messages/#embedinput" }, { r: "EmbedBuilder", h: "/docs/api/js-ts/embedbuilder/" }] }
const builderElements = new Map([["addAttachments", attachment], ["addEmbeds", embed], ["addStickers", "string"]])

export function snapshotContent(snapshot, file) {
    // TypeDoc lost the labels, rest marker and array wrapper inside these readonly tuples. The release's source
    // declares one required value followed by any number of that same type, not exactly two values:
    // https://github.com/NeonTechSpace/Fluxerly.js/blob/eba7baef00bf5caa6228777ed7732880b0daebfd/projects/sdk/src/builders.ts#L196-L231
    // Restrict the repair to this immutable release and its exact broken shapes. New extraction errors must still fail
    if (snapshot.version !== "1000.0.0" || snapshot.sourceCommit !== "eba7baef00bf5caa6228777ed7732880b0daebfd" || file.path !== "reference/model.json") return file.content
    const model = JSON.parse(file.content)
    let changed = false
    for (const entry of model.entries.filter((entry) => entry.key === "js-ts"))
        for (const category of entry.categories)
            for (const item of category.items.filter((item) => item.kind === "class" && item.name === "MessageBuilder"))
                for (const member of item.members ?? []) {
                    const element = builderElements.get(member.name)
                    if (!element || member.kind !== "method" || member.signatures?.length !== 1) continue
                    const parameters = member.signatures[0].p
                    if (parameters.length !== 1) continue
                    const parameter = parameters[0]
                    const broken = { k: "op", op: "readonly", t: { k: "tuple", t: [element, element] } }
                    if (parameter.n !== "values" || parameter.r !== 1 || !isDeepStrictEqual(parameter.t, broken)) continue
                    parameter.t = { k: "op", op: "readonly", t: { k: "tuple", t: [
                        { k: "named", n: "first", t: element },
                        { k: "rest", t: { k: "named", n: "rest", t: { k: "arr", t: element } } },
                    ] } }
                    changed = true
                }
    return changed ? JSON.stringify(model) : file.content
}
