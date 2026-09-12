import { GuildFeatureToggles, type Client, type GuildEdit, type GuildFeatureToggle } from "@neontechspace/fluxerly"

export const cloning: readonly GuildFeatureToggle[] = [
    GuildFeatureToggles.CloneEmojiEnabled,
    GuildFeatureToggles.CloneStickerEnabled,
]

export function preserveCloningWhileChangingAnotherToggle(client: Client, guildId: string) {
    return client.guilds.edit(guildId, { featureToggles: [...cloning, GuildFeatureToggles.HideOwnerCrown] })
}

export const disableCloning: GuildEdit = { featureToggles: [] }

// @ts-expect-error Deprecated opt-out flags must not masquerade as current opt-in settings
const obsoleteEmoji: GuildFeatureToggle = "CLONE_EMOJI_DISABLED"
// @ts-expect-error Deprecated opt-out flags must not masquerade as current opt-in settings
const obsoleteSticker: GuildFeatureToggle = "CLONE_STICKER_DISABLED"
void [obsoleteEmoji, obsoleteSticker]
