# Standards for CI (Jules)

> **Export only** — Source of truth: Maestro `04-knowledge/standards/smart-volume-radar-standards.md`  
> CI has no vault access; this is the minimal export for automation.

- `logger` only; no `console.log`
- `escapeHtml()` for user/API content in Telegram HTML
- No debug statements, TODOs, hardcoded secrets
- Imports at top of file
