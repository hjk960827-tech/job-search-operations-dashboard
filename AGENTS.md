# Job Search Operations Dashboard for Codex

Read `CLAUDE.md` before changing behavior.

- Keep user-specific values in ignored local configuration files under `config/`.
- Never add a personal fallback role, location, salary, company, or file path.
- Never submit an application for the user.
- Keep databases under this repository's `data/` directory.
- Run `npm run verify` before committing or pushing.
- Treat this repository as privacy-sensitive. Do not create a GitHub pull request unless the maintainer has explicitly confirmed `Settings → Emails → Keep my email addresses private`; PR creation can generate a synthetic merge commit containing the account email.
- While that setting is unconfirmed, release only through a separately approved, exact-SHA, local-noreply fast-forward update to `main`, with any temporary protection changes restored immediately and the exact remote history rescanned before tagging.
