---
"@neontechspace/fluxerly": minor
---

A webhook forward may now carry `content` that is null, empty or blank and empty `embeds`, `attachments` and `stickerIds` lists or null `stickerIds`, as Fluxer accepts them beside a forward. The SDK sends them as given. Other text, an embed, an upload or a sticker beside a forward still fails before sending with reason `input`. Fluxer counts a zero-width space as text, so content made of one fails too
