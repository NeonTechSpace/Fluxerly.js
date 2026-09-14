import type { AttachmentInput } from "./attachments.js"
import type { EmbedAuthorInput, EmbedFieldInput, EmbedFooterInput, EmbedInput, EmbedMediaInput } from "./embeds.js"
import type { AllowedMentions, MessageInput, MessageReference } from "./messages.js"

/**
 * Assemble an embed by chaining methods, then pass `build()`'s plain object to a message operation.
 * Setters change this builder and return it so calls can be chained. Later setters replace earlier values, while field methods append.
 * Every build returns a fresh object, including copied author, footer, media and field objects.
 * Building sends nothing and performs no validation. Message operations check lengths, URLs and server limits
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

    /** Replace the title text and return this builder. Message operations enforce the 256-character limit */
    title(value: string): this {
        this.titleValue = value
        return this
    }

    /** Replace the body text and return this builder. Message operations enforce the 4096-character limit */
    description(value: string): this {
        this.descriptionValue = value
        return this
    }

    /** Replace the destination opened from the title and return this builder. The URL is not checked or fetched here */
    url(value: string): this {
        this.urlValue = value
        return this
    }

    /** Replace the color and return this builder. Use an integer from 0 through 0xffffff, or convert a color with `colors.parse` first */
    color(value: number): this {
        this.colorValue = value
        return this
    }

    /** Replace the embed's timestamp and return this builder. Supply an ISO 8601 string with a timezone, such as `new Date().toISOString()` */
    timestamp(value: string): this {
        this.timestampValue = value
        return this
    }

    /** Replace the author label and optional links, copy the supplied object, then return this builder */
    author(value: EmbedAuthorInput): this {
        this.authorValue = { ...value }
        return this
    }

    /** Replace the footer text and optional icon, copy the supplied object, then return this builder */
    footer(value: EmbedFooterInput): this {
        this.footerValue = { ...value }
        return this
    }

    /** Replace the full-size image URL and optional alternative text, copy the object, then return this builder. No image is uploaded or fetched */
    image(value: EmbedMediaInput): this {
        this.imageValue = { ...value }
        return this
    }

    /** Replace the small image URL and optional alternative text, copy the object, then return this builder. No image is uploaded or fetched */
    thumbnail(value: EmbedMediaInput): this {
        this.thumbnailValue = { ...value }
        return this
    }

    /** Add a named section after existing fields and return this builder.
     * `inline` requests side-by-side display when true, it defaults to false when the message is sent
     */
    field(name: string, value: string, inline?: boolean): this {
        this.fieldValues.push(inline === undefined ? { name, value } : { name, value, inline })
        return this
    }

    /** Add field objects after existing fields in argument order and return this builder. Copies each object, passing no arguments adds nothing */
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
 * Assemble a message by chaining methods, then send the plain object returned by `build()`.
 * Methods change the same builder. Content and settings replace earlier values, while embeds, attachments and stickers append.
 * Building does not send or validate a message. In TypeScript, select content, an embed, an attachment or a sticker before calling build.
 * JavaScript can build an empty object, but message operations reject it. The HasBody type parameter tracks selection, not valid content
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

    /** Start with no content or settings. TypeScript callers must use a body-selection method before build, not choose HasBody themselves */
    constructor(..._empty: IsExactly<HasBody, false> extends true ? [] : [never]) {}

    /** Replace the message text and return this builder, now buildable in TypeScript. Empty or invalid text is still checked by the message operation */
    content(value: string): MessageBuilder<true> {
        this.contentValue = value
        return this as unknown as MessageBuilder<true>
    }

    /** Add one embed and return this builder, now buildable in TypeScript.
     * Copies the embed's nested objects and fields now. Later changes to the supplied embed or EmbedBuilder do not change this message
     */
    embed(value: EmbedInput | EmbedBuilder): MessageBuilder<true> {
        this.embedValues.push(copyEmbed(value instanceof EmbedBuilder ? value.build() : value))
        return this as unknown as MessageBuilder<true>
    }

    /** Add one or more embeds in argument order and return this builder, copying each just as `embed` does. Message operations check the final count */
    addEmbeds(
        ...values: readonly [first: EmbedInput | EmbedBuilder, ...rest: (EmbedInput | EmbedBuilder)[]]
    ): MessageBuilder<true> {
        this.embedValues.push(
            ...values.map((value) => copyEmbed(value instanceof EmbedBuilder ? value.build() : value)),
        )
        return this as unknown as MessageBuilder<true>
    }

    /**
     * Add one attachment, copying its metadata while keeping your original bytes, file or stream source.
     * Return this builder, now buildable in TypeScript. File, stream and byte references are not copied or read here.
     * The builder and its outputs retain those references. Sending does not clear the builder, and direct operations own copying or consuming their inputs
     */
    attachment(value: AttachmentInput): MessageBuilder<true> {
        this.attachmentValues.push({ ...value })
        return this as unknown as MessageBuilder<true>
    }

    /** Add one or more attachments in argument order and return this builder. Metadata is copied, but bytes, file and stream sources stay shared just as with `attachment` */
    addAttachments(...values: readonly [first: AttachmentInput, ...rest: AttachmentInput[]]): MessageBuilder<true> {
        this.attachmentValues.push(...values.map((value) => ({ ...value })))
        return this as unknown as MessageBuilder<true>
    }

    /** Add a decimal sticker ID after existing stickers and return this builder. The ID and final sticker count are checked when sending */
    sticker(value: string): MessageBuilder<true> {
        this.stickerValues.push(value)
        return this as unknown as MessageBuilder<true>
    }

    /** Add one or more decimal sticker IDs in argument order and return this builder. This does not look up or validate the stickers */
    addStickers(...values: readonly [first: string, ...rest: string[]]): MessageBuilder<true> {
        this.stickerValues.push(...values)
        return this as unknown as MessageBuilder<true>
    }

    /** Replace who may be notified by mention text, copy the user/role arrays, then return this builder.
     * If omitted, message operations keep notifications disabled. This method alone neither inserts mention text nor notifies anyone
     */
    allowedMentions(value: AllowedMentions): this {
        this.allowedMentionsValue = copyAllowedMentions(value)
        return this
    }

    /** Choose the message to reply to when using `messages.send`, copy its reference, then return this builder. No message is fetched */
    reference(value: MessageReference): this {
        this.messageReferenceValue = { ...value }
        return this
    }

    /** Replace the numeric message flags and return this builder. Only writable MessageFlags are accepted by message operations */
    flags(value: number): this {
        this.flagsValue = value
        return this
    }

    /**
     * Return a fresh plain `MessageInput` after selecting content, an embed, an attachment or a sticker.
     * Sending or replying checks empty text, arrays, attachments and server limits, not this method.
     * JavaScript can call this on an empty builder and receive `{}`, which message operations reject locally
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

/** Start optional chainable builders instead of writing embed and message objects by hand.
 * Both package entry points return builders immediately, not lazy Effects
 */
export const builders: Readonly<{
    /** Return a new empty EmbedBuilder. Call build to get a plain embed object, no message is sent */
    embed: () => EmbedBuilder
    /** Return a new empty MessageBuilder. Select content, an embed, an attachment or a sticker before building */
    message: () => MessageBuilder<false>
}> = Object.freeze({
    embed: () => new EmbedBuilder(),
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
