# Security Policy

Do not commit credentials, personal resumes, portfolio files, application
packages, raw job-search data, local databases, or screenshots containing real
personal information. A private repository is not treated as a safe place for
those files.

Before every push, run:

```bash
npm run verify
```

The demo is read-only and always uses synthetic example settings. Onboarding mode
opens no personal database and permits mutations only under `/api/onboarding`.
Personal mode
fails before opening a database unless all four local configuration files are
valid. Demo and personal databases carry an immutable role marker so one cannot
be opened as the other.

The dashboard accepts loopback hosts only, refuses the protected port `8765`,
checks request Host and Origin, and requires object-shaped `application/json`
mutation bodies no larger than 100 KB. The database must resolve inside the
repository's `data/` directory. Existing and dangling symbolic links are rejected
for database, configuration, and package paths. Static serving rejects traversal
and links resolving outside its public root, while the release scanner blocks all
candidate symbolic links. Database files, local non-example configuration files,
and generated artifacts use owner-only `0600` permissions; private data directories use `0700`.
File preview is deliberately not exposed in the initial release.

Onboarding copies registered documents into random-ID directories below
`data/private/`; it never keeps a browser-supplied absolute path. Directories use
`0700` and files use `0600`. Extension, MIME type and file signature must agree.
PDF resumes are limited to 20 MB, other documents to 50 MB each, and all registered
documents to 70 MB. DOCX archives are checked for traversal, links, encryption,
duplicate entries, excessive entry count, expanded size and compression ratio.
Only checksums and source type are logged; document contents and contact data are
not written to application logs. Non-empty analysis items require registered source
IDs and source locators. Age and date of birth are rejected in fact keys, labels and
structured analysis content. Analysis starts unapproved and cannot enter the personal
database until every item is explicitly used, edited or excluded.

The repository scanner checks tracked and non-ignored release candidates,
including new files and symbolic links. It blocks credentials, personal contact
patterns, local configuration, databases, career documents, reports, and absolute
user paths. The pre-push hook additionally requires a clean tree and an explicit
approval manifest bound to the exact commit, remote name/URL, and remote ref, blocks
non-fast-forward remote-history replacement, then
exports that exact commit to a private temporary clone and runs the external
pre-publish scanner there. `gitleaks` is mandatory so full Git history inspection
cannot be silently skipped. The gate also rejects author or committer emails outside
privacy-preserving GitHub noreply domains without printing the address. Ignored local data
is never copied into the scan candidate. A scan result never grants permission
to publish.

Report security issues privately to the repository owner. Do not include a real
token or personal document in an issue.
