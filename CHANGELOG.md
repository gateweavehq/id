# Changelog

Notable changes to Gateweave ID, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org).

Each version's [GitHub release](https://github.com/gateweavehq/id/releases) carries the same notes.
Publishing a release deploys it to Gateweave Cloud.

## [0.1.0] - 2026-11-04

The first release. Gateweave ID is an OpenID Connect provider that runs entirely on Cloudflare: one
Worker, one D1 database and a Durable Object for rate limits. It holds people's accounts and signs them
in to first-party apps that a deployment registers itself. It has no workspaces or two-factor sign-in
yet, and nobody can register an app of their own, so it is not ready to stand in front of your own
apps.

### Added

- **Accounts.** An address is proven with a code sent by email before an account exists, and the
  password comes after that. Signing in takes a password, GitHub or a passkey. Passwords known from a
  breach are refused when `CHECK_BREACHED_PASSWORDS` is set. (#2, #5, #7, #11)
- **An account page**, where a person manages their name, password, passkeys and sessions, and sees
  their recent activity. (#4, #13)
- **An OpenID Connect provider.** Discovery at the origin, ES256 ID tokens, a different subject for each
  app, PKCE and exact redirect URIs, rotating refresh tokens, and back-channel logout. Apps are
  registered with `pnpm --filter @gateweave/id-web apps:add`, and nothing else can add one. Someone
  the check for who may use an app refuses gets a page saying so, and the app gets no code. (#8, #9)
- **An audit log** of sign-ins, refusals, consents and changes to an account, kept for 90 days. (#13)
- **A strict Content Security Policy** with a new nonce per response, and Turnstile in front of
  sign-in and email when a deployment sets it. (#3)
- **A daily clean-up** of expired sessions, verifications and tokens. (#6)
