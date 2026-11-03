---
"@neontechspace/fluxerly": patch
---

OAuth redirect URIs:

- The `redirectUri` of `authorizationUrl` and `exchangeCode` now follows Fluxer at each step. The SDK removes U+000C and U+202E and trims surrounding whitespace, as Fluxer does, and sends that text in the authorization URL, which Fluxer compares exactly with the registered redirect URIs. The code exchange sends the URL's standard form, such as `https://example.test/` for `https://example.test`, because Fluxer stores that form with the code and compares the exchange with it. An exchange for a redirect URI registered without its standard form used to fail with `invalid_grant` after a successful consent
- A redirect URI whose standard form is longer than 256 UTF-16 code units now fails locally, since no exchange could match it
- HTTP redirect URIs for an IP address, such as `http://192.168.1.20:8080/callback` on a local network, are now accepted, as Fluxer registers them. HTTP still needs a loopback host or an IP address
