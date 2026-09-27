import {
    type FormatHelpers,
    type SnowflakeHelpers,
    type DisplayHelpers,
    type PermissionBitHelpers,
    type LinkHelpers,
    display as sharedDisplay,
    format as sharedFormat,
    links as sharedLinks,
    permissionBits as sharedPermissionBits,
    snowflakes as sharedSnowflakes,
} from "#sdk/helpers"
import { type ColorHelpers, colors as sharedColors } from "#sdk/colors"
import { type TextHelpers, text as sharedText } from "#sdk/text"
import { type AssetHelpers, assets as sharedAssets } from "#sdk/assets"

/**
 * Create Fluxer markup for mentions, timestamps, custom emoji and Markdown escaping.
 * Use these helpers when building message content, without creating a client or making a request.
 * Helpers return plain values and throw HelperError for invalid input, which indicates a programming mistake.
 * For text received from users, tryParseMention, tryParseTimestamp and tryParseCustomEmoji return a Result instead of throwing.
 * Check isOk() before reading value, or isErr() before reading error.
 * A mention in the text does not enable notifications, which are controlled by allowedMentions when sending
 *
 * @category Builders and formatting
 */
export const format: FormatHelpers = sharedFormat

/**
 * Read and convert Fluxer's IDs, called snowflakes, without losing integer precision.
 * Keep IDs as decimal strings rather than JavaScript numbers.
 * Conversions return plain values and throw HelperError for an invalid ID or Date.
 * For IDs received from users, tryParse returns a Result instead of throwing
 *
 * @category Builders and formatting
 */
export const snowflakes: SnowflakeHelpers = sharedSnowflakes

/**
 * Choose a display name from supplied user or member data.
 * No account request or cache lookup is made
 *
 * @category Builders and formatting
 */
export const display: DisplayHelpers = sharedDisplay

/**
 * Build and inspect raw permission flags with bigint values.
 * Use from to combine named permissions, missing to find absent names, and toDecimal to produce a decimal string.
 * Each helper returns a plain value and throws HelperError for unknown names or bits outside the unsigned 64-bit range.
 * These helpers inspect flags only, not whether Fluxer will allow a particular action
 *
 * @category Roles and permissions
 */
export const permissionBits: PermissionBitHelpers = sharedPermissionBits

/**
 * Convert supported RGB numbers, six-digit hex strings and RGB tuples into colors.
 * Invalid input throws HelperError rather than being converted automatically.
 * For colors received from users, tryParse returns a Result instead of throwing.
 * No client or network request is needed
 *
 * @category Builders and formatting
 */
export const colors: ColorHelpers = sharedColors

/**
 * Split a string into frozen pieces without dropping or changing its text.
 * The maxLength option counts UTF-16 code units, as JavaScript string.length does.
 * The pieces are returned directly, and invalid text or options throw HelperError.
 * This helper neither sends the pieces nor repairs Markdown split across them
 *
 * @category Builders and formatting
 */
export const text: TextHelpers = sharedText

/**
 * Build links to Fluxer channels, direct messages, messages and bot installation pages.
 * These helpers use hosted Fluxer URLs.
 * Each helper returns the URL directly, and invalid route inputs throw HelperError.
 * Building a link does not check access or install the bot
 *
 * @category Builders and formatting
 */
export const links: LinkHelpers = sharedLinks

/**
 * Build hosted Fluxer URLs for avatars, banners, community images, emoji and stickers.
 * Calls return the URL, null or undefined directly and throw AssetUrlError for invalid input.
 * They do not download the image or need a client.
 * Use client.instance.resolve() for helpers tied to a self-hosted instance instead.
 * Member avatar and banner helpers read only guildId, userId and the chosen image hash.
 * The displayMemberAvatar helper also reads profileFlags to choose the fallback image
 *
 * @category Builders and formatting
 */
export const assets: AssetHelpers = sharedAssets
