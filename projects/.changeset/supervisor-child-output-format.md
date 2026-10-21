---
"@neontechspace/fluxerly": patch
---

With the default `childOutput` of `prefix`, a supervisor now reads each child record and prints it in the format of the stream it goes to. SDK records print as readable labeled lines on a pretty stream, and as JSON Lines with a `fields.child` entry on a `json` stream. For this, default-API children always log `json`, as do Effect API children whose `logging.format` is `json`. Setting `FLUXERLY_LOG_FORMAT` or `FLUXERLY_LOG_COLOR` in the child environment still takes precedence

Before, starting a bot with a terminal on standard output and standard error redirected, such as `node supervisor.js 2> errors.log`, gave children readable colored lines. Their Warn and Error records then reached the parent's JSON standard error as `supervisor.childOutput` text, without their level, code and fields, and without the documented `fields.child` entry. Those records now keep their shape and gain `fields.child`, while standard output still shows readable lines
