# Jules Scheduled Task — Standards Sweep

**Manual setup required.** Create this task via the Jules dashboard or API.

## Cadence

Weekly (e.g. Monday 00:00 UTC)

## Prompt (paste into Jules task)

```
Smart Volume Radar — Standards Sweep

Read docs/standards-for-ci.md (vault export). Scan for violations:
- console.log → replace with logger
- User/API content in Telegram HTML without escapeHtml
- Debug statements, TODOs in production code

Only touch: src/, scripts/, tests/, package.json. Do not modify .env or secrets.
Open PR titled "chore(standards): fix [violation type] sweep - [date]"
Run npm run lint, npm run build, npm run test before pushing.
```

## Labels

Create these labels in repo **Settings > Labels** for PR observability:
- `jules`
- `jules/fix-daily`
- `jules/standards`
