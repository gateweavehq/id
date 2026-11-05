# Changelog

Notable changes to Gateweave ID, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org).

Each version's [GitHub release](https://github.com/gateweavehq/id/releases) carries the same notes.
Publishing a release deploys it to Gateweave Cloud.

## [0.4.0] - 2026-11-05

### Added

- **Apps a workspace adds.** A workspace's owners and admins can add their own apps from its page, and
  [`docs/connect-an-app.md`](https://github.com/gateweavehq/id/blob/main/docs/connect-an-app.md) says how to connect one. Only that workspace's members
  can use such an app, and each person is asked first, on a page that says what it is called, whose it is and
  where it goes. Someone outside is turned away and told nothing of it. Removing someone ends what they hold
  from the workspace's apps at once, tokens included, down to database triggers, and deleting a workspace
  deletes its apps. An app stays on its host. Its secret is shown once, and adding an app, replacing a secret
  and deleting an app want a sign-in within the last day. These apps get no back-channel logout yet, so an app
  that keeps its own sessions learns someone has gone when it next refreshes. (#27)
- **Nobody is sent to a workspace's app until they are known to be a member.** Anyone with an account can add
  one, so a wrong request or `prompt=none` could otherwise have made a link to ID a link to anywhere. Anyone
  signed out stays on ID, and anyone outside goes to a page that names no app. For these apps, `prompt=none`
  for someone signed out asks them to sign in rather than answering `login_required`, which departs from
  OpenID Connect on purpose, because that answer could be sent to anyone. Apps everyone can use are as they
  were. (#28)

### Changed

- **`/oauth2/public-client` and `/oauth2/public-client-prelogin` are closed.** They named any app to anyone
  who had its id. ID's own pages did not use them. (#27)
- **`/oauth2/introspect` is closed, and discovery no longer offers it.** ID has no APIs to introspect for, and
  it told an app the id of the session behind a token, which two apps could match someone up by. (#28)
- **The `claims` request parameter is ignored, for every app,** and discovery says so. People are asked about
  scopes, and naming claims one by one got an app more than the page said. No app here used it. (#28)
- **Inviting someone as an admin or owner, or making them one, wants a sign-in within the last day,** or a
  stolen cookie could make its thief an admin with a new session. Inviting a member does not. (#28)
- **No workspace or app can have a name holding `Gateweave`,** compared after folding away capitals, spaces,
  punctuation and letters of the same look. Those names go into invitations sent from this domain. Names that
  exist already stay as they are. (#28)

### Fixed

- An app's address cannot end its host in a dot, which got past the check that it is not this server. (#28)
- The activity log says which app asked to give up a token by the credentials it signed in with, not by what
  the request's body claimed. It also records the redirect URIs of an app added or changed. (#28)
- The page that asks and the page that refuses say what they know from the app's row, never from the link, and
  neither offers a way to an app someone may not know of. (#28)

### Upgrading

A deploy applies one migration, `0007_workspace_apps`. It only adds an index and two triggers, so the running
code keeps working until the new code arrives. There are no new settings. A deployment with no OpenID Connect
provider configured shows no Apps section and has none of these endpoints.

An app that reads `/oauth2/introspect` has to stop, and one that sends `claims` gets what its scopes give. None
of the first-party apps do either.

## [0.3.0] - 2026-11-05

### Added

- **Workspaces.** Someone signed in can make a workspace, rename it, invite people by email, change their
  roles, remove them, leave it and delete it, under `/workspaces`. Accepting an invitation needs a session
  with that verified address, and someone with no account signs up first, which proves it. A workspace
  always keeps an owner, down to database triggers that hold however a row changes. Someone outside a
  workspace gets the same answer as for one that does not exist. Each change goes in the audit log, with who
  did it and to whom. Apps do not use workspaces yet, so this changes nobody's sign-in. (#25)

### Upgrading

A deploy applies two migrations, `0005_workspaces` and `0006_workspace_keeps_an_owner`. They only add
tables, nullable columns, indexes and triggers, so the running code keeps working until the new code
arrives. There are no new settings. A deployment that sends no email still has workspaces, but cannot invite
anyone yet.

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
