---
"@neontechspace/fluxerly": major
---

A missing or empty token no longer makes `runBot` throw in the default API or die in the Effect API. Once the other options are valid, `runBot` reports it like any failed run before creating a client: It logs the `ConfigurationError` once without a stack trace, sets `process.exitCode` to 1 unless `reportFailure` is `false`, and returns it as an Err in the default API or fails with it in the Effect API. Both `runBot` failure types now include `ConfigurationError`. Other invalid options still throw in the default API and die in the Effect API, and `createClient` still rejects a missing token as misuse

The missing-token hint now also covers projects created by `fluxerly init`: Copy `.env.example` to `.env` and set `FLUXER_BOT_TOKEN`

Migration: Code that caught the thrown `ConfigurationError` for a missing token around a default `runBot` call reads it from the returned Err instead. Effect code that handled the defect handles the typed `ConfigurationError` failure
