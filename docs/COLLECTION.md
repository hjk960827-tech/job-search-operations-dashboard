# Provider-neutral job collection

The dashboard does not log in to job platforms, bypass CAPTCHA, call private APIs,
or embed a crawler. A user's existing local agent or an external adapter may return
facts obtained from an official API, a publicly accessible page, or user-supplied
input. `sources.yml` remains the allow-list: only platforms with `collect: true` may
appear in a collection run.

## Adapter envelope

```json
{
  "adapterId": "generic-public-adapter",
  "accessPolicy": "public_page",
  "generatedAt": "2026-01-01T00:00:00.000Z",
  "jobs": [
    {
      "jobKey": "stable-source-key",
      "companyName": "Example Organization",
      "title": "Example Role",
      "deadline": "2099-12-31",
      "sources": [
        {
          "platform": "direct",
          "url": "https://example.invalid/jobs/example-role",
          "status": "active",
          "deadline": "2099-12-31",
          "confidence": 90
        }
      ]
    }
  ]
}
```

Allowed access policies are `official_api`, `public_page`, `user_agent`, and
`user_supplied`. The declared source `accessMethod` must match. Credential/account
state fields and company rating/review fields are rejected recursively. A JobPlanet
job-posting URL may remain a normal source when enabled, but ratings and reviews are
not collected, stored, analyzed, or summarized.

## Dry-run and publish

```bash
npm run collection -- contract
npm run collection -- stage --input=data/private/adapter-result.json
npm run collection -- show --run=<run-id>
npm run collection -- publish --run=<run-id> --expected-checksum=<sha256>
```

The input must be a regular file below ignored `data/private/`. Staging creates an
owner-only run directory containing the normalized batch, a consistent SQLite
snapshot, and a manifest with create/update/unchanged diff. It runs the full batch
against that snapshot and checks SQLite integrity and foreign keys. The operating
database remains unchanged.

Publish requires the exact request checksum and the same database instance and jobs
revision. It rechecks artifact hashes and staging integrity, then applies at most
1,000 normalized jobs in one `BEGIN IMMEDIATE` transaction. Another writer or a
changed run makes publication fail closed. Equivalent staged requests on the same
revision coalesce. Collection request lease, heartbeat, stale recovery, retry and
cancel behavior is supplied by the provider-neutral `agent_tasks` queue.

The jobs and a publication journal entry are committed in that same transaction.
The JSON manifest is a local, owner-only mirror rather than the source of truth. If
the database commit succeeds but the manifest file cannot be replaced, `show`
reports the run as published with `artifactSynchronized: false`. Repeating publish
with the same run ID and exact request checksum repairs only the manifest and never
imports those jobs a second time. A read-only `show` never modifies run artifacts.

The HTTP equivalent is `POST /api/jobs/batch`. The first request stages and returns
`dryRun: true`; a second request sends `runId`, `expectedChecksum`, and
`publishConfirmed: true`.

## Deadline and lifecycle rules

- Job and source deadlines use nullable `YYYY-MM-DD` values.
- D-day and expiration use the calendar date in `profile.yml`'s configured time
  zone; an invalid zone falls back to `Asia/Seoul`.
- Every platform link remains under the same canonical job.
- A passed source deadline makes that source effectively closed.
- A job closes only when every stored source is closed or expired. A job-level
  deadline is the fallback for a source that has no source-specific deadline.
- Any active source reopens the canonical job.
- When open sources have different dates, the canonical job remains open through
  the latest effective open-source deadline. Closed-source dates do not make an
  open sibling appear urgent.
- The list API exposes the same canonical deadline and lifecycle used by filters,
  plus D-day, source-specific deadlines, provenance, first/last seen times, and
  last checked time.
