---
"@neontechspace/fluxerly": minor
---

Behavior change: `text.truncate`, `text.split` and the pages of `router.help` now cut at a grapheme boundary, as `Intl.Segmenter` defines it, so a visible character stays whole. Before, they kept the two UTF-16 units of a code point together but could cut inside a character made of several code points, such as a flag, a skin-tone emoji, a joined emoji, a base letter with combining marks, or the pair "\r\n". For example, `text.truncate("aaaaaaaaa🇩🇪", { maxLength: 11, suffix: "" })` returned `"aaaaaaaaa🇩"`, half a flag, and now returns `"aaaaaaaaa"`. A piece or truncated result can now be shorter than `maxLength` and never longer, and the newline and whitespace preferences of `text.split` only choose positions between characters

`text.truncate` keeps whole characters only. When the first character does not fit before the suffix, it returns the suffix alone, so `text.truncate("🇩🇪x", { maxLength: 4 })` now returns `"…"` instead of half a flag, and a letter with more combining marks than fit is dropped entirely. `text.split` still cuts a single character that is longer than the limit between code points, because it must advance, and it still throws `HelperError` when the limit cannot hold one code point. Joining the pieces of `text.split` still reconstructs the input exactly

No code change is needed unless a caller relied on a cut inside a character, or on a result of exactly `maxLength - suffix.length` units of text
