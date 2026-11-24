---
"@neontechspace/fluxerly": minor
---

Improve error guidance, `describeError` output, option typo suggestions, agent guides and CLI error reporting:

- Cover every `ApiErrorCode` and common HTTP rejection status in `apiErrorHints` and `statusHints`, differentiate empty `INVALID_FORM_BODY` rejections, and include concrete `retryAfterMs` waits where known
- Surface retry safety (`Retry:`), SDK `apiCode`, `inputConstraint` and structured `Validation:` field entries in `describeError` and error `details`, and add icon-tagged, color-coded terminal formatting for pretty logs and `describeError(error, { color: true })`
- Add actionable hints to `HelperError`, `AssetUrlError`, `ConnectionError`, `MessageCleanupError` and high-friction `ConfigurationError` sites, plus closest-key typo suggestions across option validators
- Fix subjectless input validation messages in count and member-chunk operations and document owner and administrator unknown-channel count behavior
- Expand error-handling guidance and fix the prefix-command `arguments` example in `skills/fluxerly/SKILL.md` and `agents/AGENTS.md`
- Refresh the `fluxerly` CLI with the pixel conductor mascot and adaptive terminal styling, expand `fluxerly doctor` with offline `tsconfig.json` and installed `node_modules` drift checks, and add `fluxerly triage` for agent-assisted SDK and bot debugging with bundled `agents/TRIAGE.md`
