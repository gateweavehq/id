# Changelog

Notable changes to Gateweave ID, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org).

Each version's [GitHub release](https://github.com/gateweavehq/id/releases) carries the same notes.
Publishing a release deploys it to Gateweave Cloud.

## [0.10.0] - 2026-11-06

People can now delete their own account. One migration, no new setting.

### Added

- **Deleting your account, on the account page.** It takes a session from the last day, and the password if the account
  has one. The account goes at once, with its sessions, its ways of signing in and every app's tokens. The person gets
  an email where the server sends email, and audit rows stay for their ninety days.
  ([#63](https://github.com/gateweavehq/id/pull/63))
- **Two people have to stay.** The only owner of a workspace hands it over or deletes it first, and the answer names
  each one. Whoever runs the server stays until someone else does, as
  [self-hosting.md](https://github.com/gateweavehq/id/blob/main/docs/self-hosting.md) says. A new trigger,
  `deployment_keeps_its_owner`, in migration `0016`, holds that however a request comes to try.
  ([#63](https://github.com/gateweavehq/id/pull/63))

### Worth knowing

- **Apps keep their own copy.** Deleting an ID account does not delete what an app holds, and Track and Agents keep
  their own accounts on purpose. A first-party app hears only if it signed in through a session that is still alive, and
  a workspace app does not hear at all, so someone can stay signed in to an app for a while. The page and the email both
  say so.
- **Better Auth's `/delete-user` stays off.** It would let someone with a password through without it, and could leave
  them with no way back in if the last step were refused.

## [0.9.1] - 2026-11-06

A security fix for anyone running their own server, and two smaller changes. No migration and no new setting.

### Fixed

- **Removing a password takes the password.** `/unlink-account` asked only for a session from the last day, so on an
  account that also had GitHub, a stolen cookie could remove the password and then set its own through
  `/account/first-password`. It now asks for the password, with five tries a minute from one client address. Nothing
  changes on any page, since none offers this. ([#64](https://github.com/gateweavehq/id/pull/64))
- **`scripts/update-copy.mjs` reads `wrangler.jsonc` as data.** A comment could hide a rename, a binding's name could
  pass for the Worker's, and a release pointing `DB` at another database went through. It now compares each resource
  with its binding, and stops if it cannot read the file. ([#62](https://github.com/gateweavehq/id/pull/62))

### Added

- **A guide to putting Cloudflare Access in front of an internal app,** `docs/cloudflare-access.md`, written from a real
  run against Access. ([#61](https://github.com/gateweavehq/id/pull/61))

## [0.9.0] - 2026-11-06

ID now signs with RS256, as OpenID Connect requires, and the OpenID Foundation's conformance suite passes its Basic OP
and Config OP plans against it, in a run anyone can repeat. ID is not certified: that is a separate step with the
Foundation, and all this says is that the suite passes, with the differences written down. A standard library that sends
its secret in the body or has no PKCE can now connect, and a request that stops at ID gets a page that says why.

**Read this before updating.** Moving to RS256 takes more than updating ID, as the first two items below say.

### Changed

- **ID tokens and logout tokens are signed with RS256, with a 2048-bit key.** OpenID Connect Core requires it of a
  provider, and it is what a library expects if nobody told it otherwise. The first time discovery, the keys or a token
  is asked for, a server makes the key itself, with no migration and nothing to set. The old ES256 key stays published
  until it runs out and for 30 days after, so tokens already out still verify. **An app set to accept only ES256 has to
  accept RS256 before you update.** v0.8.0's docs said ES256, so one you set up from them may be. (#54, #57, #59)
- **If you run Gateweave Track or Gateweave Agents against your own ID, redeploy them straight after updating it, and
  again if you roll ID back past this release.** They read which algorithms to accept from discovery when an isolate
  starts, and keep the answer for as long as it lives. Until then a running one refuses every RS256 token, sign-ins and
  logouts alike, and ID does not try a refused logout again. Any other app that holds on to discovery the same way needs
  the same. (#59)
- **Discovery says only what works.** It no longer offers `private_key_jwt` and the algorithms for it, DPoP, `public`
  subjects or `select_account`, none of which an app could use here. (#54)

### Added

- **An app can say what its library needs.** It can send its secret in the body of the request instead of by HTTP Basic,
  and can do without PKCE. Both are under "If your app's library needs something else" on the form for a workspace's
  apps, and `--client-auth` and `--no-pkce` on `apps:add`. Nothing changes for an app that says nothing. An app without
  PKCE has to send a nonce and check it, which ID cannot see. The form says so, and turning PKCE off asks for a recent
  sign-in. [Connect an
  app](https://github.com/gateweavehq/id/blob/main/docs/connect-an-app.md#if-your-library-needs-something-else) has the
  details. (#56)
- **`pnpm test:conformance` runs the OpenID conformance suite against a local build.** It needs Docker, runs in a few
  minutes, and fails on any difference from what is written down, a better result included. CI runs it when the app's
  code or its dependencies change, and weekly. [The suite's
  page](https://github.com/gateweavehq/id/blob/main/docs/conformance.md) lists what does not plainly pass, and why:
  warnings that stay, skips the suite allows, pages it leaves for a person to look at, and one test that fails on
  purpose for apps a workspace adds, since a quiet redirect to an app anyone can add would make ID an open redirector.
  (#58)

### Fixed

- **A request ID cannot answer says so.** When a request names a redirect address its app has not registered, or an app
  that does not exist, there is nowhere safe to send someone back to. Someone signed in used to land on their account
  page with no word of what happened, and someone signed out on the sign-in page, told that signing in with GitHub had
  not worked. It now stops at a page that says what happened in its own words. (#55)

## [0.8.0] - 2026-11-06

A server you run yourself now belongs to its first account and closes behind it, can invite people with or without
email, and has a guide. Signing out reaches an app that was down for hours. One fix here is for a security problem in
every release so far.

### Security

- **An address written with the Kelvin sign skipped the cap on sign-up codes.** U+212A lowercases to `k`, and the check
  in front of a code read the address as typed while the code path lowercased it first. So an address containing a `k`,
  written that way, could keep getting new codes past the cap on codes per address, each with new tries at guessing it.
  Rate limits by client and Turnstile still applied. Every release so far has this. (#47)
- **How long an answer takes no longer tells addresses apart.** Asking for a sign-up code, entering one and asking to
  reset a password now take at least a second, whatever the answer, which covers the differences we measured. A rare
  slower answer could still differ. (#47, #50)

### Added

- **A new server belongs to its first account.** It starts closed, with no owner, and whoever makes the first account
  owns it, so claim it as soon as it is up. A deployment that upgrades stays open, and its oldest account owns it. (#43)
- **The owner decides who can join.** A "This server" section on their account page opens or closes sign-up and invites
  people, by email or with a link to pass on. While it is closed, only the owner makes workspaces, only workspaces they
  run can invite, and an admin elsewhere cannot get around that by promoting the owner. (#43, #45, #49, #50)
- **A server can run without email.** A new deployment starts that way. The first account claims it with a form, the
  owner's word stands in for proof of an address, and GitHub does not reach an account nothing proved. With GitHub set
  up, the first account comes from GitHub instead, and claiming goes behind Turnstile where that is set up. (#45, #48)
- **A guide to running your own ID.**
  [`docs/self-hosting.md`](https://github.com/gateweavehq/id/blob/main/docs/self-hosting.md) covers the Deploy button,
  the command line, every setting, someone who is locked out, backups and updating. `scripts/update-copy.mjs` takes a
  release into a copy made with the button. (#46)
- **Missed sign-outs are tried again.** When an app cannot be reached, its back-channel logout goes on a Cloudflare
  Queue and is tried for about 20 hours, each time with a new token. (#44)
- **A workspace's app list says who added each app,** and when that person has left. (#42)
- **ID has its own mark,** a key, on its favicon, home page and README, and the home page says what ID does today. (#51)

### Fixed

- An app repeating a refused refresh is recorded once an hour, so it cannot push the rest of someone's activity off
  their page. (#41)
- Long names no longer push confirm buttons off a phone's screen. (#40)

### Upgrading

- Migrations `0012` to `0015`, which a deploy applies.
- **A deployment that upgrades keeps working as it did:** sign-up stays open and its oldest account becomes the owner,
  who can close it.
- **There is a new queue,** which a deploy from the command line makes. A token you deploy with needs the Queues
  permission. Whether the Workers Builds token can make the queue has not been tried. On a copy made with the button, if
  the deploy stops there, run `pnpm wrangler queues create` with your queue's name, then deploy again.

## [0.7.0] - 2026-11-05

A deployment can now link its legal notice, privacy policy and terms from every page of ID. (#36)

### Added

- **Links to a deployment's legal pages.** `LEGAL_NOTICE_URL`, `PRIVACY_POLICY_URL` and `TERMS_URL` are unset by
  default, so a copy someone else runs shows none of Gateweave's and can show its own. Any that is set and is an http(s)
  address is linked from every page, in a new tab with no referrer, since some of these pages carry a token in their
  address. Where an account can be made, `TERMS_URL` also adds that continuing means agreeing to them. (#36)

### Upgrading

No migrations. Nothing changes until the settings are set. Track and Agents have the same three.

## [0.6.0] - 2026-11-05

A workspace's admins can now keep an app to some of its people with groups, and an app can ask which groups someone is
in. (#35)

### Added

- **Groups in a workspace.** Admins make groups, put members in them, and keep an app to one or more of them under **Who
  can use it** on its page. An app that names no groups stays open to every member, as before. Someone in none of the
  groups an app names cannot sign in to it, and hears nothing of the app from the page that turns them away or from
  their own activity. Being an owner or an admin lets nobody in by itself, and a group with nobody in it admits nobody.
  (#35)
- **Losing access happens at once.** Taking someone out of a group, or changing an app's list, ends their tokens and
  their consent for any app that no longer admits them, on every device. A group an app names cannot be deleted until no
  app names it, so an app never opens to everyone by losing its last group. (#35)
- **A `groups` scope for a workspace's apps.** Once someone agrees, the ID token and userinfo hold the names of their
  groups in that workspace, and an empty list for someone in none. First-party apps cannot ask for it.
  [`docs/connect-an-app.md`](https://github.com/gateweavehq/id/blob/main/docs/connect-an-app.md) says how to use it.
  (#35)

### Changed

- **A page left open cannot undo a choice.** Saving an app's list says what the page was showing, and a list that has
  changed since is refused. (#35)
- **Some group changes want a recent sign-in:** renaming a group, putting someone in one, and changing an app's list, as
  making someone an admin already does. (#35)

### Upgrading

A deploy applies three migrations, `0009_group_parents`, `0010_groups` and `0011_groups_hold`. Existing workspace apps
stay open to every member, no token is touched, and there are no new settings.

An app a workspace added can now ask for `groups`. One that names its scopes gets nothing new. One that sends no `scope`
asks for everything it may have, so its people are asked again, and their tokens end when they answer. Name the scopes
you want.

## [0.5.0] - 2026-11-05

### Added

- **Anyone can take back an app they allowed.** Their account page lists the workspace apps they have allowed,
  with what each may see, whose it is and where it goes. Taking one back deletes their tokens and their consent
  for it in one batch, and they stay in the workspace. A code the app was handed earlier buys nothing, the app
  cannot get them back with `prompt=none`, and their activity says what happened. First-party apps do not ask,
  so they are not on the list. (#33)

### Changed

- **A token of a workspace's app now rests on a consent, in the database as well as in the code.** Each person
  has one consent for each app. A token written with no consent behind it goes as it arrives, so a sign-in that
  crosses a take-back leaves nothing that works. An answer with a different list of scopes ends the tokens from
  the old one, on every device, and replaces the list rather than adding to it.
  [`docs/connect-an-app.md`](https://github.com/gateweavehq/id/blob/main/docs/connect-an-app.md) says what that
  means for an app. (#33)

### Fixed

- **The provider's own consent routes are closed.** `/oauth2/delete-consent` removed the consent and left the
  tokens, so it looked done without being, and a refresh never reads the consent. `get-consent`, `get-consents`
  and `update-consent` went with it, as nothing here uses them. (#33)
- **A link can no longer stop the buttons on ID's pages working.** The auth client sends a page's signed request
  back with every POST, so an app could link to the account page with a made-up signature and make its forms
  fail. Pages no sign-in flow comes to now drop one from their address. (#33)

### Upgrading

A deploy applies one migration, `0008_tokens_need_consent`. Where someone has more than one consent for an app
it keeps the latest, then adds a unique index and three triggers, so the running code keeps working until the
new code arrives. There are no new settings, and nobody is signed out.

An app a workspace added should ask for everything it needs each time, and end its own session when a refresh
fails. None of the first-party apps ask, so none of this reaches them.

## [0.4.1] - 2026-11-05

### Fixed

- **A Worker that has nothing to do with an app can no longer stop people signing in to it.** Every Worker
  reaches ID from one address, so ID's limits counted them all as one caller, and enough junk from any of them
  used up what Track and Agents need to sign people in. On staging, a sign-in to Track during such junk ended at
  `invalid_code`; on this release it works. A Worker is now counted by its zone, which Cloudflare sets and a
  sender cannot change. Anyone else is counted by their address as before, whatever they claim. The activity log
  keeps no address for a Worker's request, as it says nothing of where a person is. (#31)

### Upgrading

No migration and no new secret. Nobody is signed out.

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
