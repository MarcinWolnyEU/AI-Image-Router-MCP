## Summary

<!-- What does this change, and why? Link the issue it closes: "Closes #123". -->

## Risks

<!-- What could this break? Gateways touched, config fields added, behavior that changes for existing users. -->

## Checklist

- [ ] `npm run typecheck` and `npm test` pass.
- [ ] Tests assert behavior (they would fail if the code were wrong), not just execute lines.
- [ ] No test or script makes a paid API call unless it lives in `tests/paid/`.
- [ ] README, `docs/API-NOTES.md` and `CLAUDE.md` are updated if a tool, config field or gateway contract changed.
- [ ] No secrets, API keys or tokens appear in code, tests, fixtures or logs.
- [ ] No absolute local paths (`C:\Users\...`, `/home/...`) appear in committed files.
