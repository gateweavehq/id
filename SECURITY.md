# Security policy

## Supported versions

Gateweave ID is in early development. Security fixes go into `main` and the latest release only.

## Reporting a vulnerability

Please report vulnerabilities privately, never in a public issue or pull request.

- Preferred: [open a private security advisory](https://github.com/gateweavehq/id/security/advisories/new)
  on GitHub.
- Or email **security@gateweave.com**.

Include what an attacker could do, the steps to reproduce it, and the affected version or commit.
We aim to reply within three working days, and will keep you updated while we work on a fix,
and credit you in the release notes unless you would rather stay anonymous.

## Scope

Areas where reports are especially valuable:

- Signing in as someone else, or signing in with an address that was never verified.
- Authentication and session handling, and the rate limits on sign-in, sign-up and password reset.
- Password reset and email verification links that work twice, work after they expire, or reach
  someone other than the address's owner.
- Secrets leaving where they belong: the server's `BETTER_AUTH_SECRET` or a person's password
  reaching a page, a log or an email.

ID is early and does not issue tokens to other apps yet. Reports about the OpenID Connect provider
will matter once it exists.
