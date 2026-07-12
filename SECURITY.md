# Security Policy

Do not commit credentials, personal resumes, portfolio files, application
packages, raw job-search data, local databases, or screenshots containing real
personal information. A private repository is not treated as a safe place for
those files.

Before every push, run:

```bash
npm run verify
```

The dashboard binds to `127.0.0.1` by default. The database must resolve inside
the repository's `data/` directory. File preview is deliberately not exposed in
the initial release.

Report security issues privately to the repository owner. Do not include a real
token or personal document in an issue.
