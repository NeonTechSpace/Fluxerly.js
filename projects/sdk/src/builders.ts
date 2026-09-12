import type { AttachmentInput } from "./attachments.js"
import type { EmbedAuthorInput, EmbedFieldInput, EmbedFooterInput, EmbedInput, EmbedMediaInput } from "./embeds.js"
import type { AllowedMentions, MessageInput, MessageReference } from "./messages.js"

/**
 * Fluent rich-embed construction without a client, request, validation pass or retained output snapshot.
 * Every `build` result is a new plain `EmbedInput`. Mutate that result or continue changing this builder without changing a previous result
 */
export class EmbedBuilder {
    private titleValue: string | undefined
    private descriptionValue: string | undefined
    private urlValue: string | undefined
    private colorValue: number | undefined
    private timestampValue: string | undefined
    private authorValue: EmbedAuthorInput | undefined
    private footerValue: EmbedFooterInput | undefined
    private imageValue: EmbedMediaInput | undefined
    private thumbnailValue: EmbedMediaInput | undefined
    private readonly fieldValues: EmbedFieldInput[] = []

    /** Set the embed title. Existing message-operation validation remains authoritative */
    title(value: string): this {
        this.titleValue = value
        return this
    }

    /** Set the embed description. Existing message-operation validation remains authoritative */
    description(value: string): this {
        this.descriptionValue = value
        return this
    }

    /** Set the linked title URL without fetching or validating it */
    url(value: string): this {
        this.urlValue = value
        return this
    }

    /** Set the RGB integer used by the existing `EmbedInput` contract */
    color(value: number): this {
        this.colorValue = value
        return this
    }

    /** Set the ISO 8601 timestamp string used by the existing `EmbedInput` contract */
    timestamp(value: string): this {
        this.timestampValue = value
        return this
    }

    /** Replace the author with a copied plain input object */
    author(value: EmbedAuthorInput): this {
        this.authorValue = { ...value }
        return this
    }

    /** Replace the footer with a copied plain input object */
    footer(value: EmbedFooterInput): this {
        this.footerValue = { ...value }
        return this
    }

    /** Replace the full-size image with a copied plain input object */
    image(value: EmbedMediaInput): this {
        this.imageValue = { ...value }
        return this
    }

    /** Replace the thumbnail with a copied plain input object */
    thumbnail(value: EmbedMediaInput): this {
        this.thumbnailValue = { ...value }
        return this
    }

    /** Append one field in display order */
    field(name: string, value: string, inline?: boolean): this {
        this.fieldValues.push(inline === undefined ? { name, value } : { name, value, inline })
        return this
    }

    /** Append copied field objects in display order */
    addFields(...values: readonly EmbedFieldInput[]): this {
        this.fieldValues.push(...values.map((value) => ({ ...value })))
        return this
    }

    /**
     * Return a fresh plain input snapshot for `messages.send`, `messages.reply` or `messages.edit`.
     * This method performs no URL, length, attachment or provider-limit validation
     */
    build(): EmbedInput {
        return {
            ...(this.titleValue === undefined ? {} : { title: this.titleValue }),
            ...(this.descriptionValue === undefined ? {} : { description: this.descriptionValue }),
            ...(this.urlValue === undefined ? {} : { url: this.urlValue }),
            ...(this.colorValue === undefined ? {} : { color: this.colorValue }),
            ...(this.timestampValue === undefined ? {} : { timestamp: this.timestampValue }),
            ...(this.authorValue === undefined ? {} : { author: { ...this.authorValue } }),
            ...(this.footerValue === undefined ? {} : { footer: { ...this.footerValue } }),
            ...(this.imageValue === undefined ? {} : { image: { ...this.imageValue } }),
            ...(this.thumbnailValue === undefined ? {} : { thumbnail: { ...this.thumbnailValue } }),
            ...(this.fieldValues.length === 0 ? {} : { fields: this.fieldValues.map((value) => ({ ...value })) }),
        }
    }
}

/**
 * Fluent message-payload construction. A new builder has no selected body, so `build` becomes callable only after
 * content, an embed, an attachment or a sticker is selected. Runtime callers can still construct an empty builder,
 * and message operations remain responsible for rejecting a resulting empty payload
 */
export class MessageBuilder<HasBody extends boolean = false> {
    declare private readonly hasBodyState: HasBody
    private contentValue: string | undefined
    private readonly embedValues: EmbedInput[] = []
    private readonly attachmentValues: AttachmentInput[] = []
    private readonly stickerValues: string[] = []
    private allowedMentionsValue: AllowedMentions | undefined
    private messageReferenceValue: MessageReference | undefined
    private flagsValue: number | undefined

    /** Construct an empty builder. A buildable state can arise only from a fluent body-selection method */
    constructor(..._empty: IsExactly<HasBody, false> extends true ? [] : [never]) {}

    /** Set message content without trimming or validating it */
    content(value: string): MessageBuilder<true> {
        this.contentValue = value
        return this as unknown as MessageBuilder<true>
    }

    /** Append one embed or a snapshot of another embed builder */
    embed(value: EmbedInput | EmbedBuilder): MessageBuilder<true> {
        this.embedValues.push(copyEmbed(value instanceof EmbedBuilder ? value.build() : value))
        return this as unknown as MessageBuilder<true>
    }

    /** Append one or more embeds in display order */
    addEmbeds(
        ...values: readonly [first: EmbedInput | EmbedBuilder, ...rest: (EmbedInput | EmbedBuilder)[]]
    ): MessageBuilder<true> {
        this.embedValues.push(
            ...values.map((value) => copyEmbed(value instanceof EmbedBuilder ? value.build() : value)),
        )
        return this as unknown as MessageBuilder<true>
    }

    /**
     * Append one attachment input with copied container metadata and shared caller-owned source references.
     * The builder and its outputs retain those references. Sending does not clear the builder, and direct operations own copying or consuming their inputs
     */
    attachment(value: AttachmentInput): MessageBuilder<true> {
        this.attachmentValues.push({ ...value })
        return this as unknown as MessageBuilder<true>
    }

    /** Append one or more attachment inputs with copied metadata and shared caller-owned source references, as with attachment */
    addAttachments(...values: readonly [first: AttachmentInput, ...rest: AttachmentInput[]]): MessageBuilder<true> {
        this.attachmentValues.push(...values.map((value) => ({ ...value })))
        return this as unknown as MessageBuilder<true>
    }

    /** Append one sticker ID in send order */
    sticker(value: string): MessageBuilder<true> {
        this.stickerValues.push(value)
        return this as unknown as MessageBuilder<true>
    }

    /** Append one or more sticker IDs in send order */
    addStickers(...values: readonly [first: string, ...rest: string[]]): MessageBuilder<true> {
        this.stickerValues.push(...values)
        return this as unknown as MessageBuilder<true>
    }

    /** Replace explicit allowed mentions. Omitting this method retains the SDK’s notification-safe default */
    allowedMentions(value: AllowedMentions): this {
        this.allowedMentionsValue = copyAllowedMentions(value)
        return this
    }

    /** Replace the optional reply reference for `messages.send` */
    reference(value: MessageReference): this {
        this.messageReferenceValue = { ...value }
        return this
    }

    /** Set writable message flags. Existing message-operation validation remains authoritative */
    flags(value: number): this {
        this.flagsValue = value
        return this
    }

    /**
     * Return a fresh plain `MessageInput` snapshot after a body field is selected. Direct send/reply validation still
     * owns empty-text, array, attachment and provider-limit decisions. Runtime callers can invoke this method on an
     * empty builder and receive `{}`, which those message operations reject locally
     */
    readonly build = (() => {
        return {
            ...(this.contentValue === undefined ? {} : { content: this.contentValue }),
            ...(this.embedValues.length === 0 ? {} : { embeds: this.embedValues.map(copyEmbed) }),
            ...(this.attachmentValues.length === 0
                ? {}
                : { attachments: this.attachmentValues.map((value) => ({ ...value })) }),
            ...(this.stickerValues.length === 0 ? {} : { stickerIds: [...this.stickerValues] }),
            ...(this.allowedMentionsValue === undefined
                ? {}
                : { allowedMentions: copyAllowedMentions(this.allowedMentionsValue) }),
            ...(this.messageReferenceValue === undefined
                ? {}
                : { messageReference: { ...this.messageReferenceValue } }),
            ...(this.flagsValue === undefined ? {} : { flags: this.flagsValue }),
        } as MessageInput
    }) as IsExactly<HasBody, true> extends true ? () => MessageInput : never
}

type IsExactly<Value, Expected> = [Value] extends [Expected] ? ([Expected] extends [Value] ? true : false) : false

/** Optional plain-payload builders with no client, request, cache or connection ownership */
export const builders = Object.freeze({
    /** Start a rich-embed builder */
    embed: () => new EmbedBuilder(),
    /** Start a message builder. Select content, an embed, an attachment or a sticker before building */
    message: () => new MessageBuilder(),
})

function copyEmbed(value: EmbedInput): EmbedInput {
    return {
        ...value,
        ...(value.author === undefined ? {} : { author: { ...value.author } }),
        ...(value.footer === undefined ? {} : { footer: { ...value.footer } }),
        ...(value.image === undefined ? {} : { image: { ...value.image } }),
        ...(value.thumbnail === undefined ? {} : { thumbnail: { ...value.thumbnail } }),
        ...(value.fields === undefined ? {} : { fields: value.fields.map((field) => ({ ...field })) }),
    }
}

function copyAllowedMentions(value: AllowedMentions): AllowedMentions {
    return {
        ...value,
        ...(value.users === undefined ? {} : { users: [...value.users] }),
        ...(value.roles === undefined ? {} : { roles: [...value.roles] }),
    }
}
