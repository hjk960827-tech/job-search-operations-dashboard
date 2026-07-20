# Release Process

This repository treats pull-request review and release commit creation as separate gates.

## Safe release order

1. Prepare a release commit with privacy-preserving GitHub noreply author and committer metadata.
2. Run `npm run verify` and the external pre-publish safety scan on the exact commit.
3. Do not create a pull request unless the maintainer has explicitly confirmed `Settings → Emails → Keep my email addresses private` for web-based Git operations. PR creation can immediately generate a synthetic `refs/pull/*/merge` commit containing the account email, even before a merge button is used.
4. When the setting is confirmed, a PR may be used, but every GitHub-generated test merge, squash, merge, or rebase commit remains a new artifact that must pass the identity gate.
5. When the setting is unconfirmed, use a separately approved no-PR release: temporarily relax only the required protection checks, fast-forward `main` to the exact scanned local-noreply commit, and restore the previous protection immediately. Never force-push or rewrite `main`.
6. Fetch the exact remote `main`, then rerun `npm run identity:check`, security scanning, tests, and Actions-log review.
7. Create a version tag and GitHub Release only after the exact remote `main` passes every post-update gate.

## Why this is required

GitHub can create a synthetic merge commit as soon as a pull request exists, and can create another commit during final merging. Either commit may use the account's web-based commit email even when every source commit uses noreply metadata and the public profile hides the address. A successful source-branch scan therefore does not prove that creating or merging a PR is private.

The repository test workflow fetches complete history and runs `npm run identity:check`. The command never prints a rejected email value; it reports only the number of unsafe identities.
