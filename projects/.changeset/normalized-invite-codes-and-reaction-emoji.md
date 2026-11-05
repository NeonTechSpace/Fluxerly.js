---
"@neontechspace/fluxerly": patch
---

Invite codes and Unicode reaction emoji now receive Fluxer's normalization before the SDK checks and sends them. Fluxer removes U+000C and U+202E from these path values and trims whitespace, and the SDK now does the same and uses the result

- The `invites.fetch` and `invites.delete` methods accept a code with surrounding whitespace, a form feed or U+202E, such as `" FixtureCode "`, where padding used to fail with reason `input`. The request carries the normalized code, and Fluxer's answer is compared with it, so a code holding U+202E no longer fails as a response mismatch. An answer for a different code now names that mismatch instead of the last field read
- Reaction operations accept Unicode emoji with surrounding whitespace, a form feed or U+202E, such as `" 👍 "`, and send the normalized emoji. A reaction collector's `emoji` selector uses the normalized emoji too, so a selector holding U+202E or padding now matches the reaction Fluxer stores
