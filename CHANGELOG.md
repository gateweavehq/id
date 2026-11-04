# Changelog

Notable changes to Gateweave ID, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org).

Each version's [GitHub release](https://github.com/gateweavehq/id/releases) carries the same notes.
Publishing a release deploys it to Gateweave Cloud.

## [0.2.1] - 2026-11-04

### Fixed

- **Signing out of ID could leave someone signed in to an app.** An app had one try of five seconds to take
  a back-channel logout, and on production Track once took longer. An app now gets three tries, two seconds
  apart, when it answers with a server error or not at all. An app refusing the logout still gets one. (#21)

### Upgrading

Nothing to do. No migration and no new settings.

## [0.2.0] - 2026-11-04

### Added

- **Two-factor sign-in.** Someone with a password can ask for a code from an authenticator app whenever
  they sign in with it. Passkeys and GitHub do not ask. A code works once, no device is remembered, and
  nothing goes by email, so a mailbox alone never gets past it. Ten recovery codes are shown once, with one
  case and no look-alike characters. Turning it on or off signs apps out through back-channel logout. (#19)
- **`two-factor:remove`,** for someone who has lost their authenticator, their recovery codes and every
  other way in. Whoever runs it has to be sure who is asking, and the person's activity says it was done for
  them. (#19)
- **More in the activity list.** A right password with a code still owed, wrong codes, how someone got past
  the code, turning two-factor on and off, and replacing recovery codes. (#19)

### Changed

- Updated Wrangler, the Cloudflare Vite plugin, Biome and the TanStack devtools. (#17)

### Upgrading

Apply migration `0004_two_factor` before deploying. It rebuilds nothing, and the previous version runs fine
on it. There are no new settings.

`BETTER_AUTH_SECRET` now also encrypts authenticator keys and recovery codes. Replacing it outright makes them
unreadable, and people with two-factor on could not then sign in with a password until `two-factor:remove` is
run for them.

## [0.1.1] - 2026-11-04

### Security

- **Better Auth 1.7.16.** A sign-up or sign-in code could take more guesses than its limit under
  concurrent requests, and verification and email-change links worked for an account other than the
  one they were issued to. The passkey plugin now holds to `userVerification: "required"` and to the
  configured origin itself, so ID's own guards for them are gone, and the tests still refuse both. A
  refused passkey now answers 400. (#16)

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
