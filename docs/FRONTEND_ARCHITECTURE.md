# Frontend Architecture

The local release backend is the operational core for the default Free Agent frontend.
The frontend must read `GET /api/ui-contract` before enabling write actions. It
must not infer capability from button visibility or duplicate workflow rules.

Before setup is complete, the server selects the dedicated files in
`web-dashboard/onboarding-public/`. Those files expose only the 11-step setup
workflow in onboarding mode. Completing setup reloads `/`, after which the same
server serves the default Free Agent files in `web-dashboard/public/`.

## V2

V2 keeps the current operational dashboard structure and makes it usable for a
new self-hosted user.

1. Freeze the versioned UI contract and capability matrix.
2. Build and verify the operational V2 shell in a temporary parallel entry point.
3. Map generic bootstrap, job, workflow, resume, package, submission, outcome,
   notification, and companion responses through a frontend adapter.
4. Replace personal assumptions with onboarding configuration and empty states.
5. Connect job browsing, filters, details, resume management, package review,
   approved PDF generation, manual submission, outcomes, and notifications.
6. Connect staged job updates and selection-based companion requests without
   bypassing existing checksums, revisions, leases, or approval gates.
7. Verify demo read-only behavior, personal data isolation, clean-clone onboarding,
   desktop/mobile behavior, and V2 parity.
8. Promote the verified shell to the default `/` path and remove the temporary
   parallel copy so users have one frontend.

Automatic application submission is not part of the V2 contract. A future
platform adapter must remain disabled by default until receipt verification,
idempotency, account isolation, and recovery behavior have separate approval.

## V2 Confirmed Presentation Boundaries

- Do not port the personal dashboard's Jobplanet company rating or review area.
  A Jobplanet URL may still appear as an ordinary imported job source; it must
  not enable rating collection, review collection, or review summarization.
- Do not port the Seoul map, map tab, map toggle, geographic drawing, or
  map-specific filter state. Region selection remains a normal list/filter
  backed by the user's configuration.
- Before setup is complete, render a visually complete, read-only example
  dashboard with synthetic copy and data. Every example surface must be marked
  as example data and must not contain a real person's identity, employment
  history, company preference, contact details, or application history.
- Example values are presentation fixtures, not defaults. Onboarding and
  settings inputs remain empty except for neutral placeholders, and completing
  setup must never copy an example role, region, company, score, or track into
  the user's configuration.
- After setup, the same visual slots are populated from the user's local
  profile, search, source, and document settings. Personal mode must expose a
  settings action so these values can be edited after the dashboard has been
  reviewed.
- Keep universal action labels in the frontend copy catalog. Move role, track,
  region, platform priority, scoring, document section, and filename text out
  of HTML/CSS literals and bind it through the sanitized frontend view model.

## Future frontend replacement

A future frontend change is a replacement, not a second backend.

1. Define the new information architecture, navigation, and design tokens.
2. Build a temporary parallel entry point against the same UI contract.
3. Reuse the V2 API client and domain adapter without copying V2 DOM logic.
4. Map domain navigation intents to V3 routes and implement responsive layouts.
5. Run old/new parity tests for every read model and write action.
6. Keep the current frontend as the default until the replacement passes shadow use and recovery checks.

## Contract Rules

- `contractId` identifies the product UI contract.
- `schemaVersion` changes when an existing field changes meaning or shape.
- `frontendVersions` lists supported frontend generations.
- `capabilities` controls whether a feature is visible and whether it is writable
  in onboarding, demo, and personal modes.
- `available: false` means the frontend must hide the feature or show an explicit
  unavailable state; it must not render a control that calls a blocked endpoint.
- `navigationIntents` are domain actions. Frontends map them to their own routes.
- Unsupported automation must be reported as unavailable instead of being shown
  as a non-functional control.

## V2 Frontend / Backend Match

The V2 operational shell uses the release backend only. It does not call or
reference the separate personal Career Ops server, database, port, or launch
agent.

| Frontend area | Release backend status | V2 behavior |
|---|---|---|
| Job list, search, filters, sorting, pagination | Supported | Connected |
| Favorite, application state, notes | Supported | Connected; demo is read-only |
| Multiple job sources and primary link | Supported | Connected |
| Resume and portfolio registration | Supported | Connected; private local storage only |
| Generic resume and custom sections | Supported | Connected |
| Package create, edit, approve and PDF creation | Supported | Connected with backend `allowedActions` |
| Manual submission preparation and submitted record | Supported | Connected with checksum and state gates |
| Outcomes, corrections and follow-ups | Supported | Connected |
| Local notifications | Supported | Connected, including mark-all |
| Codex/Claude companion requests | Queue supported | Connected; an external signed-in local companion must process the request |
| Jobplanet rating and review summary | Unsupported by policy | Not rendered |
| Map view | Out of release scope | Not rendered |
| Private document open | Supported owner-only route | Connected with no-store response |
| Approved PDF open | Supported owner-only route | Connected when an approved PDF exists |
| Revise/hold/cancel-approval transitions | Supported | Connected with state gates |
| Cancel submission preparation | Supported | Connected with confirmation |
| Mark all notifications read | Supported | Connected |
| Outcome evidence file upload | Supported | Connected to private local storage |
| Automatic job application | Explicitly unsupported | Not rendered |

Every hydrated job includes an `allowedActions` object. The backend computes
whether review, package creation, editing, approval, refresh, submission
preparation, and submission recording are currently valid and provides a reason
when they are not. V2 applies that result in addition to the mode capability,
so its presentation conditions cannot enable an action the backend has denied.
