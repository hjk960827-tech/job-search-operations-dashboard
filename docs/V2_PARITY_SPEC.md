# V2 Frontend Parity Specification

## Purpose

This specification records the public, generic equivalent of the protected personal Career Ops frontend under the public product brand `FREE AGENT` (`FA`). The parallel implementation was completed and promoted to the default root frontend for v0.5.0.

Parity means that the agreed information architecture, component geometry, design tokens, controls, state presentation, actions, and responsive behavior are implemented against the release backend. It does not mean copying personal data, personal job-search assumptions, or excluded integrations.

## Protected reference and release baseline

| Item | Frozen value |
|---|---|
| Personal reference | protected local Career Ops workspace (read-only; path is intentionally not recorded in release files) |
| Personal URL | `http://127.0.0.1:8765/` |
| Protected DB | protected personal SQLite ledger (path is intentionally not recorded in release files) |
| Release repository | current repository root |
| Release baseline | `7964461` (`v0.4.0`, full commit retained in local Git history) |
| Work branch | `codex/v2-parity-rebuild` |
| Default frontend | `web-dashboard/public/{index.html,app.js,styles.css}` |
| Default URL | `http://127.0.0.1:8766/` |
| Setup-only frontend | `web-dashboard/onboarding-public/{index.html,app.js,styles.css}`; selected only while runtime mode is `onboarding` |
| Cutover rule | the superseded frontend is retained in Git history, not duplicated in the release tree |

Baseline hashes recorded before implementation and cutover:

- personal `index.html`: `9491960b8252a3961a3bebc0751bf5fb7f7c4f23754dd7b96e2a522c47a61ebf`
- personal `app.js`: `102ba4872a22f23fb55ab17a966d903efdea41a3d382b40a4dadb60536d8f685`
- personal `styles.css`: `c4eff4391503140d6db8a8434c69c3e9846e81c0e95852a09f26232ed525f98c`
- release `index.html`: `a5a246ca5ffd08a1ef4c1c048eb3669deee5d5507be29fea431b40f59db4dcce`
- release `app.js`: `735ffc2b2cd7b43451d6d681428bda0d22feda0f5353fff659892e21e718f1d4`
- release `styles.css`: `973d39dc1b60c5cb543bfd27c8520b435c13837690d1c464c52ec1840c94fc40`

## Information architecture

Only two primary categories are visible after onboarding:

1. `구직공고 대시보드`
2. `이력서 관리`
   - `이력서 생성`
   - `이력서 수정`
   - `이력서 리뷰`

Supporting capabilities are contextual rather than primary navigation:

- workflow is projected into dashboard progress chips and resume-review stages;
- companion tasks are requested from the job, document, and package context that creates them;
- notifications use the header drawer and full modal;
- settings use a header utility action;
- onboarding replaces the application screens only until setup is complete.

The default post-setup screen is the job dashboard.

The visible product wordmark is exactly `FREE AGENT`. `Job Search Ops` is not used as the release-facing brand.

## Generic replacement contract

| Protected personal assumption | Release parity behavior |
|---|---|
| A/B plan labels | first and second configured `target_tracks`; neutral demo labels `주 목표 직무` and `보조 직무` |
| Additional personal tracks | remaining configured tracks in overflow/filter |
| Marketing position groups | sanitized user track and job facets |
| Seoul region catalog | configured regions and observed job locations |
| Personal company and former-company logic | user preference and generic risk/condition fields only |
| Personal resume and portfolio names | local registered source documents and assets |
| Personal score/rank language | configured scoring profile and external-score distinction |
| Personal AI worker | release companion queue processed by the user's signed-in local Codex/Claude environment |

Occupation names such as `Engineering`, `Design`, and `Product` may occur only when a user imports or configures them. They are not product defaults, HTML literals, or demo track labels.

## Agreed exclusions

The matrix records these separately and does not count them as implementation targets:

- map, map toggle, map state, and Seoul map drawing;
- Jobplanet rating, review, sort, queue, collection, and enrichment;
- personal A/B labels and marketer defaults;
- personal identity, contact details, companies, salary, region, files, job data, and application history;
- Telegram;
- automatic application submission.

## Frozen visual reference

Desktop reference viewport: `1440 × 1000`.

- body background `#f7f8f7`, text `#252b28`;
- panel `#ffffff`, secondary panel `#f3f7f5`;
- line `#e4e8e5`, strong line `#d4dbd7`;
- green `#0f6f5a`, green soft `#e7f5ef`;
- blue `#285f8f`, amber `#9a6715`, red `#a54242` and matching soft colors;
- shadow `0 8px 24px rgba(31, 41, 35, 0.06)`;
- font stack `Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
- application padding `12px`, topbar minimum height `62px`;
- brand `24px / 950`, primary nav `15px / 850`;
- quick-tab toolbar desktop height approximately `88px`;
- filter card desktop padding `20px`, radius `8px`, gap `12px`;
- progress strip gap `8px`;
- standard table row approximately `82px`;
- desktop workspace uses a dense list with persistent right detail;
- mobile breakpoint uses `14px` application padding, stacked header/filter, horizontally scrollable dense table, and a non-page-overflowing detail surface.

Data length may change geometry within normal responsive constraints. The parity gate compares role, placement, tokens, component dimensions, spacing, and interaction rather than requiring a zero pixel diff for different text and records.

## Screen contract

### Job dashboard

The screen follows the protected sequence:

`quick tracks → compact primary filters → optional advanced filters → progress chips → dense result table + persistent detail → pagination`.

The Jobplanet column is removed. Its width is reassigned to generic deadline/source/package/workflow information. The map toggle is removed; list is the only view.

### Resume create

The screen preserves the three-column operational arrangement:

- basic job/career/education/skill fields;
- structured experience and project list;
- separate resume and optional portfolio source-document cards, readiness, and supplemental evidence.

The resume and portfolio lanes each support PDF/DOCX upload, replacement, safe local opening, archive, and confirmed permanent deletion. The resume is required. A missing portfolio alone never reduces readiness.

Structured career and project records store title, organization, role, dates, engagement/employment type, location or work mode, summary, highlights, tools/skills, and portfolio/evidence links.

Fields are populated from release resume, structured items, evidence, documents, and settings. No occupation-specific datalist is embedded.

### Resume edit

The first row is exactly `등록된 이력서 | 사이트 작성 이력서 | 등록된 포트폴리오`. `현재 적용 기준` occupies a full-width second row. It must not recreate personal A/B files.

### Resume review

The screen uses exactly five user-facing stages: `검토 필요`, `제출 준비`, `제출완료`, `지원 결과`, `보관함`. Internal quality/approval/package states are projected into those five tabs rather than exposed as extra navigation. The screen preserves candidate list, package detail, before/after comparison, quality evidence, edit, approval, revision/hold, PDF creation, manual submission preparation/cancellation/completion, result recording, and conflict resolution when those actions are valid.

## Backend contract

The FA frontend uses release endpoints only. It must read `/api/ui-contract` and apply both capability and per-job `allowedActions` before enabling mutations.

Existing read/write routes cover bootstrap, paged jobs, job detail, workflow, saved filters, settings/documents, resume/structured items/assets, companion queue/review, job state, collection import, packages, approvals, submission preparation/completion, outcomes, follow-ups, and single-item notifications.

The release backend implements the following personal-parity actions and keeps them capability-gated:

- revision and hold transitions;
- approval cancellation where the state machine permits it;
- submission-preparation cancellation;
- mark-all notification read;
- outcome evidence upload;
- safe generated-PDF status/open behavior required by the review flow.
- safe source-document open, archive, and confirmed permanent deletion.

Automatic submission remains excluded.

## Mutation safety

Every mutation must have:

- capability and `allowedActions` gate;
- disabled reason;
- in-flight duplicate-click lock;
- explicit success/error feedback;
- revision/cache invalidation;
- deterministic test in personal mode and read-only test in demo mode.

## Completion accounting

`V2_PARITY_MATRIX.md` contains exactly 100 in-scope atomic targets (`P001`–`P100`) and separate exclusions (`X001` onward). Completion is:

`PASS targets / 100`.

The goal is not complete until all 100 targets are `PASS`, exclusions remain absent, all required runtime and security gates pass, the FA frontend is the only default release frontend, and the protected personal baseline remains unchanged by release work.
