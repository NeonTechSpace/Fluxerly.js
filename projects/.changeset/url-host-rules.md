---
"@neontechspace/fluxerly": major
---

URLs that the SDK checks before sending now also follow Fluxer's host rules: The host must be an IP address or a domain name with a top-level domain, without a trailing dot, an underscore, a label that starts or ends with a hyphen or a label over 63 characters, and a port must be 1 through 65535. The URL may hold no whitespace or angle brackets after Fluxer's normalization. This covers link channel `url` in `channels.create` and `channels.edit`, webhook message `avatarUrl`, and embed URLs, author and footer icons and image and thumbnail URLs. The top-level domain rule applies locally only when the client targets hosted Fluxer. A client or webhook client created with a custom `instance` skips only that rule locally and leaves it to that server, because a Fluxer server in development mode skips it too. A numeric top-level domain and every other host rule still apply there

- A URL such as `https://a_b.example.com` on any instance, or `http://localhost:3000` or `https://intranet/build` on hosted Fluxer, now fails with reason `input` before sending, and the explanation states the host rule. Fluxer refuses such a URL, so it used to fail remotely
  Affected: Code that sends URLs with such hosts and handles Fluxer's refusal
  Migration: Use a public host name with a top-level domain or an IP address, and match reason `input`
