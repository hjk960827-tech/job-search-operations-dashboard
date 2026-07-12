# Job Search Operations Dashboard

This repository is a local-first companion for Codex and Claude. It starts with
synthetic example data and must not infer a real user's profile from source code.

## First run

1. Run `npm install`.
2. Run `npm run setup` and answer the prompts, or ask the user's agent to create
   the four local YAML files from the corresponding `.example.yml` files.
3. Run `npm run db:init`.
4. Run `npm run dashboard` and open `http://127.0.0.1:8766`.

If any required personal configuration is missing, keep the application in
example-data mode. Do not run discovery or scoring with example defaults.

## Personalization boundary

- `config/profile.yml`: identity, experience, region, preferences
- `config/search.yml`: roles, include/exclude keywords, tracks
- `config/sources.yml`: collect/display/check/priority per platform
- `config/resume.yml`: resume sections, style, filename policy
- `data/`: ignored local runtime state

Do not put personal values in JavaScript, HTML, tests, examples, or documentation.
Do not add Telegram or another external notification credential in this release.

The tracked template for local `config/resume.yml` is
`config/document.example.yml`; the neutral template filename prevents generic
publish scanners from mistaking a sanitized policy file for a real resume.
