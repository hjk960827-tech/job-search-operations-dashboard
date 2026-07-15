# Job Search Operations Dashboard

This repository is a local-first companion for Codex and Claude. It starts with
synthetic example data and must not infer a real user's profile from source code.

## First run

1. Run `npm install`.
2. Run `npm run onboarding` and open `http://127.0.0.1:8766`.
3. Register a resume, analyze it through the user's existing Codex or Claude Code
   session, review the evidence, and complete the eleven setup steps.
4. Later runs use `npm run personal`.

`npm run setup` remains an advanced terminal alternative. It creates the four
local YAML files directly; the user must then run `APP_MODE=personal npm run db:init`.

If any required personal configuration is missing, personal mode must fail
closed before opening a database. Demo mode is a separate read-only synthetic
environment; never run discovery, importing, or scoring with its defaults.

## Personalization boundary

- `config/profile.yml`: identity, experience, region, preferences
- `config/search.yml`: roles, include/exclude keywords, tracks
- `config/sources.yml`: external-adapter collect/check contract plus dashboard display/priority
- `config/resume.yml`: active minimum-completion and maximum-PDF-page rules
- `data/private/`: registered source documents and onboarding analysis state
- `data/`: ignored local runtime state

Do not put personal values in JavaScript, HTML, tests, examples, or documentation.
Do not add Telegram or another external notification credential in this release.
The dashboard has no built-in crawler or AI client. An external Codex/Claude
workflow may analyze local documents and use the import API, but it must follow
the user's local search, source, and scoring settings and must never store AI
account tokens in the repository. Never extract or score age or date of birth.

The tracked template for local `config/resume.yml` is
`config/document.example.yml`; the neutral template filename prevents generic
publish scanners from mistaking a sanitized policy file for a real resume.
