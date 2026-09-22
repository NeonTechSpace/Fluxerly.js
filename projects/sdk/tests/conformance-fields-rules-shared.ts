import { defineFieldRules, type FieldRuleAnnotation } from "./conformance-fields-registry.js"

const normalizedText = (
    target: string,
    maximum: number,
    sdkOwner: FieldRuleAnnotation["sdkOwner"],
    executableEvidence: FieldRuleAnnotation["executableEvidence"],
    minimum = 1,
    required = false,
): FieldRuleAnnotation => ({
    target,
    direction: "request",
    providerOwner: "packages/schema/src/primitives/StringType.ts:BaseTextType",
    sdkOwner,
    default: required
        ? { kind: "none", detail: "The nested field is required and omission is rejected" }
        : { kind: "omitted", detail: "An absent optional property is not serialized" },
    length: {
        kind: "bounded",
        unit: "UTF-16-code-units",
        minimum,
        maximum,
        detail: "The bound applies after the provider text preprocessing view",
    },
    normalization: {
        kind: "provider-normalized-view",
        detail: "Validation removes U+000C and U+202E and trims outer whitespace without rewriting the serialized value",
    },
    executableEvidence,
})

const textEvidence = ["tests/text-validation.test.ts"] as const
const embedEvidence = ["tests/message-fields.test.ts", "tests/text-validation.test.ts"] as const

/** Shared provider text rules whose implementation is centralized in internal/field-text.ts. */
export const sharedTextFieldRules = defineFieldRules([
    normalizedText("EmbedAuthorInput.name", 256, "src/internal/embeds.ts:inputAuthor.name", embedEvidence, 1, true),
    normalizedText("EmbedFooterInput.text", 2048, "src/internal/embeds.ts:inputFooter.text", embedEvidence, 1, true),
    normalizedText("EmbedMediaInput.description", 4096, "src/internal/embeds.ts:inputMedia.description", embedEvidence),
    normalizedText("EmbedFieldInput.name", 256, "src/internal/embeds.ts:inputField.name", embedEvidence, 1, true),
    normalizedText("EmbedFieldInput.value", 1024, "src/internal/embeds.ts:inputField.value", embedEvidence, 0, true),
    normalizedText("EmbedInput.title", 256, "src/internal/embeds.ts:inputEmbed.title", embedEvidence, 0),
    normalizedText("EmbedInput.description", 4096, "src/internal/embeds.ts:inputEmbed.description", embedEvidence, 0),
    normalizedText("MemberProfileEdit.bio", 320, "src/internal/guilds.ts:memberEditSelf", textEvidence),
    normalizedText("MemberProfileEdit.pronouns", 40, "src/internal/guilds.ts:memberEditSelf", textEvidence),
    normalizedText("RoleCreate.name", 100, "src/internal/guilds.ts:roleInput", textEvidence, 1, true),
    normalizedText("RoleEdit.name", 100, "src/internal/guilds.ts:roleInput", textEvidence),
    normalizedText("WebhookCreate.name", 80, "src/internal/webhooks.ts:name", textEvidence),
    normalizedText("WebhookEdit.name", 80, "src/internal/webhooks.ts:name", textEvidence),
    normalizedText("WebhookTokenEdit.name", 80, "src/internal/webhooks.ts:name", textEvidence),
    normalizedText("WebhookMessageInput.username", 80, "src/internal/webhooks.ts:name", textEvidence),
])
