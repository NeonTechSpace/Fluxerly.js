/**
 * Fluxer's JSON body limits for routes that carry base64 images, so the SDK refuses locally only what Fluxer refuses.
 * Fluxer allows 4/3 of the raw bytes of each image the route accepts, at 10 MiB each, plus a 1 MiB envelope, and every
 * route without its own limit gets the limit for one such image
 * (fluxer_api/src/api/middleware/RequestBodyLimitMiddleware.ts:12-28, packages/constants/src/AssetFormatPolicy.ts:111-143
 * at 0098958f). The limit is fixed per route, even where an instance lets one uploader send larger images
 */
const imageBytes = 10 * 1024 * 1024
const envelopeBytes = 1024 * 1024
const jsonAssetBodyLimit = (images: number) => 4 * Math.ceil((imageBytes * images) / 3) + envelopeBytes

/** PATCH /guilds/{guild_id} carries an icon, a banner, a splash and an embed splash: 56,972,632 bytes */
export const guildSettingsBodyLimit = jsonAssetBodyLimit(4)
/** PATCH /guilds/{guild_id}/members/@me carries an avatar and a banner: 29,010,604 bytes */
export const memberProfileBodyLimit = jsonAssetBodyLimit(2)
/** A route without its own limit: 15,029,592 bytes. That covers PATCH /channels/{channel_id}, including a group DM icon,
 * channel creation, channel and role positions, opening a DM, and creating one emoji or sticker
 */
export const defaultBodyLimit = jsonAssetBodyLimit(1)
/** POST /guilds/{guild_id}/emojis/bulk and POST /guilds/{guild_id}/stickers/bulk allow 50 images at Fluxer's default
 * 512 KiB expression size: 36,001,112 bytes. The route limit stays fixed when a community allows larger expressions
 * (fluxer_api/src/api/guild/controllers/GuildEmojiController.ts:57, GuildStickerController.ts:61,
 * packages/constants/src/AssetFormatPolicy.ts:162-177 at 0098958f)
 */
export const expressionBatchBodyLimit = 4 * Math.ceil((512 * 1024 * 50) / 3) + envelopeBytes
