import type { AttachmentInput } from "./attachments.js"
import type { EmbedAuthorInput, EmbedFieldInput, EmbedFooterInput, EmbedInput, EmbedMediaInput } from "./embeds.js"
import type { AllowedMentions, MessageInput, MessageReference } from "./messages.js"
import { colors, type ColorInput } from "./colors.js"
import { ConfigurationError } from "./errors.js"
import { HelperError } from "./helpers.js"

/**
 * Display settings for one field added with EmbedBuilder.field
 *
 * @category Builders and formatting
 */
export interface EmbedFieldOptions {
    /** Request side-by-side display with neighboring inline fields. Omit or use false for a full-width field */
    readonly inline?: boolean
}

/**
 * Assemble an embed by chaining methods, then pass the builder or `build()`'s plain object in a message operation's embeds.
 * A message operation builds a supplied builder once when it reads its input, so later changes do not affect that operation.
 * Setters change this builder and return it so calls can be chained. Later setters replace earlier values, while field methods append.
 * Every build returns a fresh object, including copied author, footer, media and field objects.
 * The builder reads supported properties by name, including inherited properties and getters that do not appear in normal key lists.
 * Values that are not objects and unknown own enumerable fields remain for the message operation to validate.
 * Building sends nothing. Only color and timestamp convert their input, throwing HelperError for input they cannot convert.
 * The field method throws ConfigurationError for options that are not an object with an optional boolean inline.
 * Message operations check lengths, URLs and server limits
 *
 * @category Builders and formatting
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

    /**
     * Replace the color and return this builder. Accepts any ColorInput, such as `0xff8800`, `"#ff8800"` or `[255, 136, 0]`,
     * converted with colors.parse. Input that cannot be converted throws HelperError with operation embed.color
     */
    color(value: ColorInput): this {
        try {
            this.colorValue = colors.parse(value)
        } catch (error) {
            throw new HelperError("embed.color", "color", { cause: error })
        }
        return this
    }

    /**
     * Replace the embed's timestamp and return this builder. Accepts a Date, Unix epoch milliseconds or an ISO 8601
     * string with a timezone. A Date or number is converted with toISOString, and a string is kept for the message
     * operation to validate. An invalid Date or a number outside the Date range throws HelperError with operation embed.timestamp
     */
    timestamp(value: Date | number | string): this {
        if (typeof value === "string") {
            this.timestampValue = value
            return this
        }
        const date = value instanceof Date ? value : new Date(value)
        if (!Number.isFinite(date.getTime())) throw new HelperError("embed.timestamp", "time")
        this.timestampValue = date.toISOString()
        return this
    }

    /** Replace the author label and optional links, copy the supplied object, then return this builder */
    author(value: EmbedAuthorInput): this {
        this.authorValue = copyEmbedAuthor(value)
        return this
    }

    /** Replace the footer text and optional icon, copy the supplied object, then return this builder */
    footer(value: EmbedFooterInput): this {
        this.footerValue = copyEmbedFooter(value)
        return this
    }

    /** Replace the full-size image URL and optional alternative text, copy the object, then return this builder. No image is uploaded or fetched */
    image(value: EmbedMediaInput): this {
        this.imageValue = copyEmbedMedia(value)
        return this
    }

    /** Replace the small image URL and optional alternative text, copy the object, then return this builder. No image is uploaded or fetched */
    thumbnail(value: EmbedMediaInput): this {
        this.thumbnailValue = copyEmbedMedia(value)
        return this
    }

    /** Add a named section after existing fields and return this builder.
     * Set options.inline to true to request side-by-side display. It defaults to false when the message is sent.
     * Options that are not an object, or an inline value that is not a boolean, throw ConfigurationError
     */
    field(name: string, value: string, options?: EmbedFieldOptions): this {
        // A boolean third argument is the removed field(name, value, inline) form, which would otherwise drop inline
        if (options !== undefined && (typeof options !== "object" || options === null || Array.isArray(options)))
            throw new ConfigurationError("embedField", "EmbedBuilder.field options must be an object", {
                hint: "Pass display settings as an object, such as field(name, value, { inline: true })",
            })
        const inline = (options as { readonly inline?: unknown } | undefined)?.inline
        if (inline !== undefined && typeof inline !== "boolean")
            throw new ConfigurationError("embedField", "EmbedBuilder.field options.inline must be a boolean", {
                hint: "Pass display settings as an object, such as field(name, value, { inline: true })",
            })
        this.fieldValues.push(inline === undefined ? { name, value } : { name, value, inline })
        return this
    }

    /** Add field objects after existing fields in argument order and return this builder. Copies each object, passing no arguments adds nothing */
    addFields(...values: readonly EmbedFieldInput[]): this {
        this.fieldValues.push(...values.map(copyEmbedField))
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
            ...(this.authorValue === undefined ? {} : { author: copyEmbedAuthor(this.authorValue) }),
            ...(this.footerValue === undefined ? {} : { footer: copyEmbedFooter(this.footerValue) }),
            ...(this.imageValue === undefined ? {} : { image: copyEmbedMedia(this.imageValue) }),
            ...(this.thumbnailValue === undefined ? {} : { thumbnail: copyEmbedMedia(this.thumbnailValue) }),
            ...(this.fieldValues.length === 0 ? {} : { fields: this.fieldValues.map(copyEmbedField) }),
        }
    }
}

/**
 * Assemble a message by chaining methods, then send the plain object returned by `build()`.
 * Methods change the same builder. Content and settings replace earlier values, while embeds, attachments and stickers append.
 * The builder reads supported properties by name, including inherited properties and getters that do not appear in normal key lists.
 * Values that are not objects and unknown own enumerable fields remain for the message operation to validate.
 * Building does not send or validate a message. In TypeScript, select content, an embed, an attachment or a sticker before calling build.
 * JavaScript can build an empty object, but message operations reject it. The HasBody type parameter tracks whether a body was selected, not whether its content is valid
 *
 * @category Builders and formatting
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
    constructor(..._empty: [HasBody] extends [false] ? ([false] extends [HasBody] ? [] : [never]) : [never]) {}

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
     * Add one attachment, copying its metadata while keeping the original bytes, file or stream source.
     * Return this builder, now buildable in TypeScript. File, stream and byte references are not copied or read here.
     * The builder and its outputs retain those references. Sending does not clear the builder, and direct operations own copying or consuming their inputs
     */
    attachment(value: AttachmentInput): MessageBuilder<true> {
        this.attachmentValues.push(copyAttachment(value))
        return this as unknown as MessageBuilder<true>
    }

    /** Add one or more attachments in argument order and return this builder. Metadata is copied, but bytes, file and stream sources stay shared just as with `attachment` */
    addAttachments(...values: readonly [first: AttachmentInput, ...rest: AttachmentInput[]]): MessageBuilder<true> {
        this.attachmentValues.push(...values.map(copyAttachment))
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

    /** Replace who may be notified by mention text, copy user/role arrays, and preserve other values for message-operation validation.
     * If omitted, message operations keep notifications disabled. This method alone neither inserts mention text nor notifies anyone
     */
    allowedMentions(value: AllowedMentions): this {
        this.allowedMentionsValue = copyAllowedMentions(value)
        return this
    }

    /** Choose the message to reply to when using `messages.send`, copy its reference, then return this builder. No message is fetched */
    reference(value: MessageReference): this {
        this.messageReferenceValue = copyMessageReference(value)
        return this
    }

    /** Replace the numeric message flags and return this builder, without validating the value.
     * Message operations accept only MessageFlags.SuppressEmbeds and MessageFlags.SuppressNotifications and reject other bits before dispatch
     */
    flags(value: number): this {
        this.flagsValue = value
        return this
    }

    /**
     * Return a fresh plain `MessageInput` after selecting content, an embed, an attachment or a sticker.
     * Before a body is selected, TypeScript rejects the call with an error naming selectContentEmbedAttachmentOrStickerBeforeBuild.
     * Sending or replying checks empty text, arrays, attachments and server limits, not this method.
     * JavaScript can call this on an empty builder and receive `{}`, which message operations reject locally
     */
    readonly build = (() => {
        return {
            ...(this.contentValue === undefined ? {} : { content: this.contentValue }),
            ...(this.embedValues.length === 0 ? {} : { embeds: this.embedValues.map(copyEmbed) }),
            ...(this.attachmentValues.length === 0 ? {} : { attachments: this.attachmentValues.map(copyAttachment) }),
            ...(this.stickerValues.length === 0 ? {} : { stickerIds: [...this.stickerValues] }),
            ...(this.allowedMentionsValue === undefined
                ? {}
                : { allowedMentions: copyAllowedMentions(this.allowedMentionsValue) }),
            ...(this.messageReferenceValue === undefined
                ? {}
                : { messageReference: copyMessageReference(this.messageReferenceValue) }),
            ...(this.flagsValue === undefined ? {} : { flags: this.flagsValue }),
        } as MessageInput
    }) as [HasBody] extends [true]
        ? [true] extends [HasBody]
            ? () => MessageInput
            : MissingMessageBody
        : MissingMessageBody
}

/**
 * The type of MessageBuilder.build before a body is selected. Calling it fails to compile with an error that names the
 * missing argument selectContentEmbedAttachmentOrStickerBeforeBuild, which states the fix
 *
 * @category Builders and formatting
 */
export type MissingMessageBody = (selectContentEmbedAttachmentOrStickerBeforeBuild: never) => never

/** Start optional chainable builders for embed and message objects.
 * Both package entry points return builders immediately, not lazy Effects
 *
 * @category Builders and formatting
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
    const copied = copyStructuralInput(value, [
        "title",
        "description",
        "url",
        "color",
        "timestamp",
        "author",
        "footer",
        "image",
        "thumbnail",
        "fields",
    ])
    if (!structuralRecord(copied)) return copied
    return {
        ...copied,
        ...(copied.author === undefined ? {} : { author: copyEmbedAuthor(copied.author) }),
        ...(copied.footer === undefined ? {} : { footer: copyEmbedFooter(copied.footer) }),
        ...(copied.image === undefined ? {} : { image: copyEmbedMedia(copied.image) }),
        ...(copied.thumbnail === undefined ? {} : { thumbnail: copyEmbedMedia(copied.thumbnail) }),
        ...(Array.isArray(copied.fields) ? { fields: copied.fields.map(copyEmbedField) } : {}),
    }
}

function copyAllowedMentions(value: AllowedMentions): AllowedMentions {
    const copied = copyStructuralInput(value, ["users", "roles", "everyone", "repliedUser"])
    if (!structuralRecord(copied)) return copied
    return {
        ...copied,
        ...(Array.isArray(copied.users) ? { users: [...copied.users] } : {}),
        ...(Array.isArray(copied.roles) ? { roles: [...copied.roles] } : {}),
    }
}

function copyEmbedAuthor(value: EmbedAuthorInput): EmbedAuthorInput {
    return copyStructuralInput(value, ["name", "url", "iconUrl"])
}

function copyEmbedFooter(value: EmbedFooterInput): EmbedFooterInput {
    return copyStructuralInput(value, ["text", "iconUrl"])
}

function copyEmbedMedia(value: EmbedMediaInput): EmbedMediaInput {
    return copyStructuralInput(value, ["url", "description"])
}

function copyEmbedField(value: EmbedFieldInput): EmbedFieldInput {
    return copyStructuralInput(value, ["name", "value", "inline"])
}

function copyAttachment(value: AttachmentInput): AttachmentInput {
    return copyStructuralInput(value, [
        "data",
        "file",
        "stream",
        "size",
        "filename",
        "contentType",
        "title",
        "description",
        "spoiler",
    ])
}

function copyMessageReference(value: MessageReference): MessageReference {
    return copyStructuralInput(value, ["id", "channelId"])
}

/** Copy an object's enumerable own keys and supported properties read from that object.
 * Other values remain unchanged for the message operation to validate
 */
function copyStructuralInput<Value extends object>(value: Value, properties: readonly (keyof Value)[]): Value {
    if (!structuralRecord(value)) return value
    const copied = { ...value } as Record<PropertyKey, unknown>
    for (const property of properties) {
        if (Object.hasOwn(copied, property)) continue
        const item = value[property]
        if (item !== undefined) copied[property] = item
    }
    return copied as Value
}

function structuralRecord(value: unknown): value is object {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
