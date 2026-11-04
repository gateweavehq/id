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

## Who may sign in

Three rules, in this order:

1. **The address is verified.** No token ever goes out for an unverified address. Apps and Cloudflare
   Access trust the `email` claim, and rules such as "anyone at acme.com" depend on it.
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
- **On refresh,** in `customTokenResponseFields`, which can throw `invalid_grant`. Authorization does
  not run on refresh, so without this a removed person keeps their access. This hook sees the
  client's metadata and not its id, so every app carries its own id in `metadata.app`.

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
| Token prefixes   | Set before the first production deploy                                 | Better Auth's docs call them effectively immutable.                                     |

Other rules:

- **Signing keys rotate** (`rotationInterval`, `gracePeriod`), and private keys stay encrypted at rest.
- **Access tokens are opaque.** Better Auth's JWT access tokens carry the real user id, not the
  pairwise one, so ID registers no resources for workspace apps.
- **The ID token carries `email` and `email_verified`** through `customIdTokenClaims` when the `email`
  scope is granted. They are not there by default, and Cloudflare Access reads the ID token.
- **`amr` and `auth_time` are the provider's own.** Reserved claims are stripped from custom claims,
  so `amr` cannot be added that way and `acr` is always `"0"`. Do not promise an app that it can tell
  how someone signed in until this is solved.
- **Refresh tokens rotate,** and reusing an old one revokes the newer one too.
- **Apps need PKCE and exact redirect URIs.** There is no open dynamic client registration: admins
  choose apps. A pairwise app's redirect URIs must share one host.

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
- Sign-in and consent pages send a strict Content Security Policy and `frame-ancestors 'none'`.
- Rate limits are durable and keyed by `cf-connecting-ip`.
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

Still unproven:

- Cloudflare Access against a deployed ID.
- The back-channel logout round trip to a product.
- The OpenID conformance suite, which Pocket ID has passed and ID should too.
