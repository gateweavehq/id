# Architecture

Gateweave ID is an OpenID Connect provider that runs entirely on Cloudflare, with no server to run.
It is in the space of Pocket ID and authentik. People hold one account, and any app that supports
OIDC signs them in with it.

Read this before changing sign-in, tokens or who may use an app. A mistake in those places signs the
wrong person in to someone else's app.

## The shape

One Worker, one D1 database, a Durable Object for rate limits and a cron trigger.

Identity data is relational, read at sign-in and written rarely. Nobody edits it offline or
watches it change, so ID has no per-workspace Durable Object and no sync engine, unlike Track.
Building on Track's sync engine here would add moving parts and solve nothing.

| Piece       | Holds                                                                     |
| ----------- | ------------------------------------------------------------------------- |
| D1          | Accounts, sessions, passkeys, workspaces, groups, apps, tokens, audit log |
| RateLimiter | Durable counters for sign-in and code attempts, as in Track               |
| Cron        | Prunes expired rows and old audit events                                  |

## Accounts, workspaces and apps

There is one issuer per deployment. Gateweave Cloud's is `https://id.gateweave.com`.

- **An account** is global, with one verified email address.
- **A workspace** is a Better Auth organization. It owns apps and groups. Its owners and admins
  manage them, decided with `clientPrivileges` and never by comparing a role with `member`.
- **An app** is an OAuth client. `clientReference` makes the active workspace its owner.
- **A first-party app** has no workspace. The deployment registers it. Track and Agents are
  first-party in Gateweave Cloud. Anyone with an account may use one, because the product checks its
  own membership afterwards.

Sign-up is open in Gateweave Cloud, behind Turnstile. A strange account gains nothing, because every
workspace app refuses non-members. On a self-hosted deployment, the first account owns the instance
and sign-up then closes, leaving invitations as the way in, unless the owner opens it.

## Sign-up

**The address is proven before the account exists, and the password comes after that.**

The usual form takes a name, an address and a password, then emails a link. That allows pre-account
hijacking: a stranger signs up with someone else's address and their own password. When the real owner
opens the link, the account is verified, and the stranger knows its password. Better Auth's link
verification does not clear that password, so this form cannot be made safe by adding to it.

So signing up has three steps, and only the last two touch the database's accounts:

1. The person gives a name and an address, and ID emails a 6-digit code. The code is stored hashed, for
   10 minutes and three tries.
2. The code comes back. Only now does the account exist, and it is verified from its first row.
3. The person chooses a password at `/welcome`. Leaving before this is fine: a password reset gives
   the account its first password.

Better Auth's `email-otp` plugin does steps 1 and 2. It is also a way to sign in, which ID does not
want, because signing in with only a mailbox would skip the password and, later, two-factor.
`apps/web/src/server/auth/sign-up.ts` holds it to signing up:

- **A code never opens an account that exists.** An existing address gets an email that says so, with
  no code. If a right code does arrive, because an account appeared while it was still good, it is
  refused.
- **Every other way in is closed.** `/sign-up/email`, link verification and the plugin's other paths
  answer 404, and a database hook refuses any account that is not verified, which is what stops a
  GitHub account whose address GitHub has not verified.
- **Outside, an address with an account looks like one without.** Asking for a code and getting one
  wrong answer the same. "Expired" and "too many attempts" would give it away, so they use the same
  words too. The answers are not equal in time: telling them apart that way takes many measurements
  of codes that each cost a Turnstile pass.
- **Codes per address are capped** before a code is stored, because each new code resets the attempts.
  That holds the guesses against one address to about one chance in 33,000 a day, however many clients
  ask.

The first password goes through `/account/first-password`, which needs a session from the last day.
Setting a password outlasts a stolen cookie, so an old session cannot do it.

## Signing in with GitHub

GitHub is a second way to prove an address, under the same rule: no account without a verified one.

- **ID asks for `user:email` and nothing else.** That is enough to read someone's verified addresses,
  and it keeps the consent screen short. Each environment has its own OAuth App, since one has a single
  callback URL. An OAuth App rather than a GitHub App, because signing in with a GitHub App asks to
  "act on your behalf", and ID does not.
- **ID keeps none of GitHub's tokens.** It asks who someone is once per sign-in and never calls GitHub
  for them afterwards, so a token it does not store cannot leak.
- **A verified address that matches an account signs in to it.** An account's address is always
  verified, so both sides have proven it, and Better Auth links them. An address GitHub has not verified
  neither makes an account nor reaches one.
- **The link is to the GitHub account, not its address.** Someone who changes their address on GitHub
  stays the same person in ID, with the address ID already has.
- **A refusal comes back to `/login` as a code,** because it ends in a redirect. The page turns known
  codes into its own words and shows nothing from the URL, or a link could put any text on the page.

## Who may sign in

Three rules, in this order:

1. **The address is verified.** No account exists without that, as above, and the check stands
   anyway. Apps and Cloudflare Access trust the `email` claim, and rules such as "anyone at acme.com"
   depend on it.
2. **The person belongs.** A workspace's app admits only that workspace's members.
3. **The app's rule passes.** An admin can narrow an app to some of its workspace's groups.

**The check fails closed.** If it cannot name the app or the person, it refuses. This is not a
style preference. The first version of the check, in the proof below, read the client id in the
wrong form, got nothing, and let everyone through while its tests for permitted people still passed.
Every test of this check must include a person who is refused.

It runs in two places:

- **At authorization,** in `postLogin.shouldRedirect`, which runs on every path to a code. The client
  id comes from `getOAuthProviderState()`, whose `query` is a serialized query string, not an object.
  A refused person goes to a page that explains why and gets no code. `prompt=none` gets
  `interaction_required`, and continuing past the page runs the check again.
- **At every token,** in `customTokenResponseFields`, which can throw `invalid_grant` and runs before
  any token is made. Authorization does not run on refresh, so without this a removed person keeps
  their access, and a code issued a moment before someone was refused would still work. This hook sees
  the client's metadata and not its id, so every app carries its own id in `metadata.app`.

Removing someone from a workspace or group also deletes their refresh tokens for its apps, so access
ends at the next expiry of a short-lived access token rather than at some later refresh.

**Consent.** First-party apps skip the consent screen. Workspace apps never do, because `skip_consent`
on them would let any workspace's admin receive a member's address silently. The screen names the app,
the workspace that owns it and the host it sends people back to.

## Tokens

These values are permanent once real apps depend on them. Changing one signs everybody out of every
app or breaks every integration, so each is decided here and not left to a default.

| Value            | Decision                                                               | Why                                                                                     |
| ---------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Issuer           | The bare origin, with discovery at `/.well-known/openid-configuration` | It is typed into customers' app settings. `/api/auth` is an implementation detail.      |
| Signing          | ES256 (`jwks.keyPairConfig.alg`)                                       | Better Auth defaults to EdDSA, which is not on Cloudflare Access's documented list.     |
| Subjects         | Pairwise for every app (`pairwiseSecret`)                              | With one shared issuer, a public `sub` would let unrelated customers match a person up. |
| `pairwiseSecret` | Generated once, never rotated                                          | Rotating it changes every subject, so every app would see new people.                   |
| Token prefixes   | `gwid_at_`, `gwid_rt_`, `gwid_cs_`                                     | Better Auth's docs call them effectively immutable.                                     |

**A deployment is a provider only when it says so:** `BETTER_AUTH_URL` and `OIDC_PAIRWISE_SECRET` both
set. The issuer is the origin of the first. It is never taken from a request, whose Host header belongs
to whoever sent it. Without both, discovery and every provider path answer 404, so a deployment that
has not set them up has no provider rather than a wrong one. The secret stands alone, and is not derived
from `BETTER_AUTH_SECRET`, so that rotating the session secret leaves every subject where it is.

Other rules:

- **A subject is derived from the host of the app's first redirect URI** and the person's id. Moving an
  app to a new host therefore gives everybody a new subject in it, so register the host it will keep.
  `test/oidc.test.ts` pins the derivation, so that an upgrade of Better Auth cannot change it unnoticed.
- **Signing keys rotate** every 90 days, and an old key stays published for 30 more, which is longer
  than any ID token lives. Private keys stay encrypted at rest with `BETTER_AUTH_SECRET`. A new key signs
  as soon as it exists, because Better Auth has no way to publish one first. So an app that fetched the
  JWKS in the seconds before a rotation can fail to verify one sign-in until it fetches again, which
  clients do when they meet an unknown key. Four times a year, this is accepted.
- **Access tokens are opaque, and `resource` is refused.** A JWT access token's subject is the real user
  id, whatever the app's subject type. Registering no resources is not enough: the provider always accepts
  its own userinfo endpoint as one, so any app could ask for a JWT by naming it. So a request that names
  any resource gets `invalid_target`, at authorization and at the token endpoint. Lifting this for APIs
  later takes a way to give such a JWT the pairwise subject.
- **`/token`, the JWT plugin's own endpoint, is closed** for the same reason.
- **The ID token carries `email`, `email_verified`, `name` and `picture`** through `customIdTokenClaims`
  when their scopes are granted. They are not there by default, and Cloudflare Access reads the ID token.
- **`amr` and `auth_time` are the provider's own.** Reserved claims are stripped from custom claims,
  so `amr` cannot be added that way and `acr` is always `"0"`. Do not promise an app that it can tell
  how someone signed in until this is solved.
- **Refresh tokens rotate,** and reusing an old one revokes the newer one too.
- **Apps need PKCE and exact redirect URIs.** There is no open dynamic client registration: admins
  choose apps. A pairwise app's redirect URIs must share one host.
- **`sid` is the session's own id, in the ID token and the logout token,** so two apps can match up a
  person for as long as one session lasts. All apps are first-party for now. Workspace apps (who may
  not trust each other) need this looked at before they get `backchannel_logout_uri`.
- **Limits on the token and userinfo endpoints are high on purpose,** at 600 a minute per address. Apps'
  servers call them, and apps on Workers all come from one Cloudflare address.

## Registering an app

First-party apps are registered by whoever runs the deployment, and nothing else can add one. Signed-in
people get no client endpoint (`clientPrivileges` is always false), and Better Auth's admin function can
only run inside the Worker, which no route offers:

```sh
pnpm --filter @gateweave/id-web apps:add --env staging --app track --name "Gateweave Track" \
  --redirect-uri https://track-staging.gateweave.com/api/auth/oauth2/callback/gateweave-id \
  --backchannel-logout-uri https://track-staging.gateweave.com/api/auth/backchannel-logout
```

It writes the row with `wrangler d1 execute`, keeps only a hash of the secret, and prints the secret once.
Since this writes what the provider would, `scripts/app-row.ts` is the one part of ID that knows the
provider's table. `test/oidc.test.ts` signs in through a row it builds, so an upgrade that changes what
the provider reads fails there.

## A patched dependency

`@better-auth/oauth-provider` sends back-channel logouts with `redirect: "error"`, which Workers refuse
outright, so every one of them failed with only a warning in the log. `patches/` changes that word to
`"manual"`. The provider treats anything but 200 or 204 as a failure, so a redirect still is not followed.
The same line is in 1.7.16. pnpm stops an install when a patch no longer has its version, so an upgrade
has to look at this again: drop the patch if upstream has fixed it, otherwise move it.

## Products as clients

Track and Agents use Better Auth's `generic-oauth` plugin. Without an issuer in their configuration,
nothing changes for them, and they accept any OIDC provider, not only ID. They keep their own users,
sessions and workspaces. See [ecosystem.md in Track](https://github.com/gateweavehq/track/blob/main/docs/ecosystem.md#identity-and-workspaces)
for why this replaced a shared session.

- **Linking an existing account** happens only when ID says the address is verified and the product's
  own account is verified too (`requireLocalEmailVerified`, on by default). ID must never be added to
  `trustedProviders`, which skips the first of those checks.
- **Signing out everywhere** is back-channel logout: ID posts a signed `logout+jwt` to the product's
  `backchannel_logout_uri`. Better Auth sends it. The receiving endpoint is the product's to build,
  since `generic-oauth` has none.

## Security baseline

- The session cookie stays on ID's own host. Nothing is shared on a parent domain.
- The passkey `rpID` is ID's own host, for the same reason. Changing it invalidates every passkey, so
  it counts as a permanent value too.
- Every page sends a Content Security Policy with a new script nonce per response, `frame-ancestors
  'none'` and `no-store`, and every response sends `nosniff`, a referrer policy and HSTS. HSTS leaves
  out `includeSubDomains`, because a self-hosted deployment's other hosts are someone else's. Styles
  stay at `'unsafe-inline'`: Radix sets `style` attributes, and a style cannot run code.
- Turnstile sits in front of what costs money or invites guessing: sending a code, requesting a reset,
  and password sign-in. It is off unless `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` are both set.
  The server requires success, the expected action and the expected hostname, and refuses when
  Siteverify cannot answer. Entering a code needs no pass, since the code is the proof.
- Rate limits are durable and keyed by `cf-connecting-ip`.
- Changing a password ends every other session, since whoever knew the old one may be why it changed.
  The account page lists a person's sessions, and they can end any of them.
- The cookie keeps the session token away from scripts, so the session a page carries leaves it out.
- A password known from a breach is refused wherever someone chooses one. Only the first five
  characters of its SHA-1 go to Have I Been Pwned. It is on in Gateweave Cloud, and self-hosters opt in
  with `CHECK_BREACHED_PASSWORDS`, since it means calling another company. When the service cannot
  answer within three seconds the password goes through: a reset is how someone takes their account
  back, and another company's outage should not stand in the way.
- A person cannot remove their last way to sign in.
- Sign-ins, refusals, consents and admin changes go to an audit log from the first release. Exporting
  it is an `ee/` feature; recording it is not.

## What has been proven

A throwaway Worker on workerd, driven by `oauth4webapi` and by Chromium's WebAuthn, checked these on
2026-11-04 with Better Auth 1.7.14. All of them were local, none on a deployed Worker:

- The issuer at the origin, which `oauth4webapi`'s discovery accepts, and ES256 ID tokens with a P-256
  key in JWKS.
- Apps owned by a workspace through `clientReference`.
- Pairwise subjects: two hosts see different values, one host always sees the same, and neither is the
  internal id.
- The check above: permitted, refused, `prompt=none`, continuing past the refusal page, and refresh
  after removal.
- Refresh rotation and reuse revoking the newer token.
- TOTP enrolment, and a passkey registering and signing in.

`apps/web/test/oidc.test.ts` now holds most of this against the built Worker, with `oauth4webapi` going
through discovery and the JWKS. It found two things the throwaway Worker had not: back-channel logout
never worked on Workers (see "A patched dependency"), and naming the userinfo endpoint as a `resource`
got a JWT with the real user id.

Still unproven:

- Cloudflare Access against a deployed ID.
- The back-channel logout round trip to a product's own endpoint.
- The OpenID conformance suite, which Pocket ID has passed and ID should too.
