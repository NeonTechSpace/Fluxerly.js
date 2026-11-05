---
"@neontechspace/fluxerly": major
---

Names, codes, reasons, path values and link URLs now follow what Fluxer checks after its normalization, which removes U+000C and U+202E and trims whitespace. The SDK still sends the string as given, except for invite codes and Unicode reaction emoji, which it now sends normalized. What is accepted now, and what now fails with reason `input` before sending:

- Emoji names in `emojis.create`, `emojis.edit` and `emojis.createMany` are checked after normalization, so a name with surrounding whitespace, a form feed or U+202E around 2 through 32 ASCII letters, digits or underscores is accepted, where it used to fail
- The `guilds.editVanityUrl` method accepts the codes Fluxer turns into a valid one: It lowercases the code, turns each whitespace run into a hyphen and collapses repeated hyphens, so `My   Code` is stored as `my-code`. The answer is compared with that normalized code, so an accepted input no longer fails as a mismatch
- The `guilds.editVanityUrl` method now refuses a code whose normalized form contains `fluxer` with reason `input` and constraint `allowedValue`, as Fluxer always refuses it, so it used to fail remotely
  Affected: Code that sets vanity codes containing fluxer and handles Fluxer's refusal
  Migration: Choose a code without fluxer, and match reason `input`
- An `auditReason` is now measured after normalization. A reason of only U+202E, or that is empty after removing it, now fails with reason `input` and constraint `length`, because Fluxer silently drops such a reason and records the entry without it. A reason longer than 512 code units that shrinks to 512 or fewer once U+202E is removed is now sent
  Affected: Code that sends a reason made only of U+202E and expects it to be recorded
  Migration: Send a reason with visible text, and match reason `input`
- A reaction emoji may now hold at most 64 UTF-16 code units after normalization, the limit Fluxer applies, instead of 128. A name that normalizes to nothing, such as U+202E alone, fails too
  Affected: Code that reacts with Unicode text of 65 through 128 code units
  Migration: Use an emoji of at most 64 code units, and match reason `input`
- An invite code in `invites.fetch` and `invites.delete` may now hold at most 256 UTF-16 code units after normalization, where it had no limit. A code that normalizes to nothing fails too
  Affected: Code that passes codes longer than 256 code units and handles Fluxer's refusal
  Migration: Use a shorter code, and match reason `input`
- A webhook token for `createWebhookClient` may now hold at most 256 characters, the limit Fluxer applies, instead of 512. A longer token fails with a configuration error
  Affected: Code that passes tokens longer than 256 characters
  Migration: Use the token Fluxer issued
- A link channel `url` in `channels.create` and `channels.edit` now fails with reason `input` unless its normalized value is at most 2,048 code units, starts with `http://` or `https://`, parses as a URL and holds no `@` before its path, so no user name or password. It used to accept any absolute URL, such as `ftp://` or one with credentials, which Fluxer refuses. A URL with a form feed or U+202E that Fluxer removes before parsing is accepted
  Affected: Code that sets link URLs with other schemes, with credentials or over 2,048 code units, and handles Fluxer's refusal
  Migration: Use an http or https URL without credentials, and match reason `input`
- A webhook message `avatarUrl` is now checked as Fluxer checks it, after the same normalization as a link channel `url`: It must start with `http://` or `https://` in lowercase and hold no `@` before its path. So `HTTPS://cdn.example.com/a.png` and `https://@cdn.example.com/a.png` now fail with reason `input` before sending, where Fluxer used to refuse them, and a URL with a form feed or U+202E that Fluxer removes is now sent
  Affected: Code that sends avatar URLs with an uppercase scheme or an `@` before the path and handles Fluxer's refusal
  Migration: Use a lowercase `https://` URL without credentials, and match reason `input`
