// Compile-only check, run by the test typecheck: display.name accepts the author of any received message,
// whose displayName is optional, and falls back to the username at runtime.
// Member-search hits and OAuth identities name the account-wide display name displayName too, so the helper reads it
import { display, type MemberSearchHit, type Message, type OAuthIdentity } from "../../src/index.js"
import { display as nativeDisplay, type Message as NativeMessage } from "../../src/effect.js"

export function authorName(message: Message): string {
    return display.name(message.author)
}

export function nativeAuthorName(message: NativeMessage): string {
    return nativeDisplay.name(message.author)
}

export function searchHitName(hit: MemberSearchHit): string {
    return display.name(hit, hit)
}

export function identityName(identity: OAuthIdentity): string {
    return display.name(identity)
}

// A MemberSearchHit without displayName would still satisfy display.name, so require the field itself
export const searchHitDisplayName: MemberSearchHit["displayName"] = null
export const identityDisplayName: OAuthIdentity["displayName"] = null
