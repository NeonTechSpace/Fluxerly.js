---
"@neontechspace/fluxerly": minor
---

`stickerIds` may now be null on message sends, replies, direct messages, the first message of a forum or media post and webhook sends and replies, as Fluxer accepts it there. The SDK sends null as given, and Fluxer reads it as no stickers, so such a message still needs content, an embed or an attachment. Null used to fail before sending with reason `input`
