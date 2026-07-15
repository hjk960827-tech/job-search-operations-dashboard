# Local Onboarding Contract

`npm run onboarding` starts the dashboard on the loopback-only release port without
opening a personal database. The browser stores drafts, registered documents and
analysis results below ignored `data/private/` paths. Completion validates and
creates the four local YAML files plus the personal database, then changes the same
running dashboard to personal mode.

## Eleven steps

1. Confirm local storage and Git exclusion.
2. Register one PDF or DOCX resume and an optional portfolio.
3. Ask the user's existing Codex or Claude Code session to analyze the documents.
4. Mark every result as use, edit or exclude. New analysis always starts as
   `pending`; leaving even one item undecided blocks completion.
5. Set primary/secondary roles and career stage.
6. Set region, work mode, employment and experience conditions.
7. Confirm suggested include/exclude keywords and user-defined tracks.
8. Choose collection, display, lifecycle checking and source priority.
9. Choose which resume sections may change for each job.
10. Optionally enable scoring dimensions and make their weights total 100.
11. Preview and activate the personal dashboard.

The dashboard never requests an AI key. The user runs analysis in an already
authenticated local agent session. Suggestions do not become settings until the
user explicitly loads and saves them. Age and date of birth must not be extracted,
stored or scored.

## Analysis result

The local `data/private/onboarding/agent-request.json` file lists random document
IDs, ignored relative paths and SHA-256 checksums. The agent submits an object to
`PUT /api/onboarding/analysis` with these collections:

- `facts[]`: `id`, `key`, `label`, `value`, `sourceDocumentId`, `sourceLocator`,
  `confidence` from 0 to 100.
- `evidence[]`: `id`, `title`, `description`, `metrics[]`, `skills[]`, `sourceRefs[]`.
- `sections[]`: `id`, `key`, `label`, `kind` (`text` or `list`), `value`, `sourceRefs[]`.
- `suggested`: optional `roles`, `includeKeywords`, `excludeKeywords`, `tracks` lists.

Every non-empty fact, evidence item and section must point to a registered document
and include a human-readable locator such as a page or section. Unsupported document
IDs, missing locators, duplicate IDs, duplicate semantic section keys, invalid
confidence and age/date-of-birth keys or content are rejected before the draft
changes. The completion API independently verifies that every result has an explicit
`use`, `edit` or `exclude` decision; `edit` stores only the reviewed value.

The nine built-in section keys remain `headline`, `summary`, `skills`,
`experience_highlights`, `achievement_evidence`, `representative_experience`,
`direct_scope`, `collaboration_scope`, and `career_direction`. Equivalent labels
map to those keys even if an agent prefixes an alias with `custom:`. Only unmatched
sections receive a normalized `custom:*` key. The same semantic duplicate guard is
also applied to direct resume-save API input before any resume row is changed.

## API summary

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/onboarding` | Draft, documents, analysis and completion requirements |
| `PATCH` | `/api/onboarding` | Save interview/checklist answers and review decisions |
| `POST` | `/api/onboarding/documents?kind=resume\|portfolio` | Copy and validate one document |
| `DELETE` | `/api/onboarding/documents/:id` | Remove a registered document |
| `PUT` | `/api/onboarding/analysis` | Validate and save structured agent output |
| `POST` | `/api/onboarding/complete` | Atomically install settings and create the personal DB |
| `GET` | `/api/scoring-profile` | Read active dimensions and their profile checksum |

If completion fails, temporary settings and a partially created database are
removed and onboarding remains active. Existing configuration or a personal DB is
never overwritten automatically.
