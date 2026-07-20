# Release Process

This repository treats pull-request review and release commit creation as separate gates.

## Safe release order

1. Prepare a release branch with privacy-preserving GitHub noreply author and committer metadata.
2. Run `npm run verify` and the external pre-publish safety scan on the exact branch commit.
3. Open a pull request and require the repository checks to pass.
4. Do not use a GitHub-generated squash, merge, or rebase commit unless the maintainer has explicitly confirmed `Settings → Emails → Keep my email addresses private` for web-based Git operations.
5. When that account setting cannot be verified, create the final release commit locally with noreply metadata from the approved tree and update `main` only through a separately approved release workflow.
6. Fetch the exact remote `main`, then rerun `npm run identity:check`, security scanning, tests, and Actions-log review.
7. Create a version tag and GitHub Release only after the exact remote `main` passes every post-update gate.

## Why this is required

GitHub can create a new commit during pull-request merging. That commit may use the account's web-based commit email even when every source-branch commit already uses noreply metadata and the public profile does not display an email. A successful scan of the pull-request branch therefore does not prove that the generated merge commit is private.

The repository test workflow fetches complete history and runs `npm run identity:check`. The command never prints a rejected email value; it reports only the number of unsafe identities.
