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
- **A workspace** is a Better Auth organization, behind a gate of ID's own (see "Workspaces"). It owns
  apps, and will own groups. What its owners and admins may do is decided with `can`, never by comparing a
  role with `member`.
- **An app** is an OAuth client. A workspace's are made through ID's own endpoints, which put the
  workspace in the app's `metadata` (see "Apps a workspace adds"). The provider's own way,
  `clientReference`, reads the session's active workspace, which a person cannot see and ID does not use.
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
want, because signing in with only a mailbox would skip the password and two-factor.
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

## Passkeys

Passkeys need no address first: the button on the sign-in page, or the browser's own offer under the
email field. They are off on a deployment without `BETTER_AUTH_URL`, like the issuer, because each one
is bound to that host for good and cannot be moved.

Better Auth's passkey plugin does the WebAuthn. What it does by default falls short of being the way in
to everything else a person uses, so ID differs in these places:

- **User verification is required,** not `preferred`, so a stolen security key with no PIN will not do.
  The browser is told so too, or it could skip the fingerprint reader and be refused with no way to put
  it right. Before 1.7.16 the plugin ignored this when checking, so `test/passkeys.test.ts` holds it to it.
- **The credentials are discoverable,** since there is no address to look someone up by first.
- **The expected origin comes from settings, and is the only one.** Without that the plugin also takes
  any trusted origin the browser reports.
- **A credential id is unique across all accounts,** as the specification asks. The plugin keeps a plain
  index and looks passkeys up by that id alone.
- **A new passkey is named from its authenticator or the device,** not by the person. The name the plugin
  asks for would also replace the address in the operating system's list of passkeys, where people need
  to tell their accounts apart.
- **A registration cannot start a session.** The plugin offers `createSession`, but a passkey is added
  from an account page, by someone already signed in.
- **Removal goes through ID's own endpoint.** The plugin's would let someone remove their last way to
  sign in. ID's is one conditional `DELETE`, so that removing two passkeys at once cannot get past the
  rule. Another passkey counts, a password counts, and so does GitHub on a deployment that still has it.
- **Adding and removing need a recent sign-in,** so that someone at an unlocked computer cannot make
  themselves a way back in or take away the owner's.
- **Names have a limit, and each step has a rate limit of its own.** The plugin has neither.

A passkey is a way to sign in like any other: someone whose only one is a passkey is not sent to choose a
password on the way to an app, and is still subject to "Who may sign in", after which they carry on to
it as they would after a password.

## Two-factor sign-in

Someone who turns this on is asked for a code from an authenticator app every time they sign in with a
password. A passkey with user verification is already two factors, and GitHub has its own sign-in, so
neither asks. That is also why only someone with a password is offered it: it would protect nothing else
they have. The account page says what it covers, since a person choosing it should know.

Better Auth's two-factor plugin does the TOTP. ID differs from what it does by default in these places:

- **It runs before the provider.** Hooks run in plugin order, and the provider's carries on to the app when
  it sees a session being set. The plugin's is what takes the session away while a code is owed. In the
  other order a password alone would make a code for the app, which `test/two-factor.test.ts` checks by
  counting codes in the database, because the response alone would not show it.
- **A code works once.** The plugin takes one for as long as it is valid, a minute and a half with the
  step either side, so anyone who saw it could use it again, and RFC 6238 says a verifier must not.
  `RateLimiter` holds each person's code for two minutes, and it is claimed before it is checked, because
  checking first would let two requests with one code both through. A wrong code claimed this way harms
  nothing: it gets the same answer as any wrong code, and a repeat of it costs no attempt.
- **No device is remembered.** The plugin offers 30 days without a code, which is a password alone for 30
  days.
- **Nothing goes by email.** A mailbox already resets a password, so one mailbox would be both factors.
  For the same reason a reset by email leaves two-factor on, and the next sign-in asks.
- **The key is shown once.** The plugin's `get-totp-uri` would show it again to anyone with the password
  and a session, and that is a second authenticator the person never hears of.

Recovery codes are encrypted, not hashed as you might expect. The plugin compares them after decrypting,
and the authenticator key beside them has to be readable and guards the same thing, so hashing them would
add little. Both are encrypted with `BETTER_AUTH_SECRET`, like the signing keys, so replacing that secret
outright makes them unreadable, and everyone with two-factor on could then not sign in with a password
until `two-factor:remove` is run for them. They have one case and nothing that looks like something else,
since they may be read off paper, at some cost in length: about 50 bits each, against the limits below.

Guessing is held down at three levels: three tries per 10 seconds from one client address, through the
durable limiter; five tries at one challenge before the password is wanted again; and ten wrong codes in a
row, across challenges, lock out codes for that person for 15 minutes. A challenge lasts 10 minutes, and
is not a session: nothing that needs one accepts it.

Turning it on or off replaces the session, which is how the plugin does it. Apps signed in from the old
session get a back-channel logout, and the page says they will ask the person to sign in again. Replacing
recovery codes does not.

**Someone who has lost their authenticator** has a recovery code, then a passkey or GitHub if they added
one. Someone with none of those needs whoever runs the deployment, on purpose:

```sh
pnpm --filter @gateweave/id-web two-factor:remove --env cloud --email someone@example.com
```

Whoever runs it has to be sure who is asking, which ID cannot help with, and the person's activity says it
was done for them. Their sessions stay, since they lost a device and nobody said someone else has it.

**Apps cannot be told how someone signed in.** The provider strips `amr` from custom claims and always sends
`acr: "0"`, so no app can require a second factor through its tokens. A rule that does has to live in ID's
own check at authorization.

## Workspaces

A workspace is a group of people who will share apps. Better Auth's organization plugin keeps the rows,
and `apps/web/src/server/auth/workspaces.ts` decides what reaches it. Today a workspace has a name, an
address, members, invitations and apps. Groups come next.

**Every request to the plugin goes through a gate first.** Ten paths have a rule. Anything else answers
404, including the plugin's teams and custom roles and whatever a later version adds, so an upgrade
opens nothing. Each rule has a strict body and names the workspace in it, so a field the plugin would
accept and no page sends, such as `metadata` or `userId`, is refused. The session's "active workspace" is
not used: a person cannot see it, so a request that leans on it can act somewhere they did not mean.

`can`, in `lib/workspace.ts`, says who may do what, and the server and the pages both ask it. Rights are
granted by name, so a role this build has not heard of has none.

|                                              | Owner  | Admin            | Member |
| -------------------------------------------- | ------ | ---------------- | ------ |
| See the workspace and its members, and leave | Yes    | Yes              | Yes    |
| Rename, invite, see and withdraw invitations | Yes    | Yes              | No     |
| Change a role, remove someone                | Anyone | Anyone but owner | No     |
| Make someone an owner                        | Yes    | No               | No     |
| Delete the workspace                         | Yes    | No               | No     |

- **To someone outside, a workspace does not exist.** One that exists answers them with the same 404 and
  the same words as one that does not. A member who lacks a right gets a 403, since they can see it.
- **Reads are ID's own endpoints** (`/workspaces/list`, `/workspaces/get`, `/workspaces/invitation`), which
  name their columns, so that a new column stays in the database. Writes stay on Better Auth's endpoints,
  for its origin check. A cookie that is only `SameSite=Lax` would not stop another `*.gateweave.com` host.
- **A workspace always has an owner,** because nobody could fix one without. The gate says so in words, the
  plugin counts too, and triggers in the `0006` migration refuse the change in the database, which holds
  when two owners leave at once and for anything else that ever touches a row. Whoever loses that race
  gets a 500, and trying again gets the proper refusal.
- **Deleting goes workspace first.** The plugin deletes the members first, which the triggers refuse, so a
  hook deletes the workspace and lets the database's cascade take the rest.
- **Deleting needs a sign-in from the last day.** It cannot be undone and takes everyone's place with it,
  so like a first password it has to outlast a stolen cookie.
- **Limits are on owning, not belonging.** One person can own 10 workspaces and be invited to any number,
  because nobody chooses their invitations. A workspace holds 500 members.

**An invitation goes to an address, and only an account that has proven that address can see or take it.**
For anyone else it answers 404, like one that does not exist. Someone with no account follows the link to
the sign-in page, and from there to making an account, with the address already filled in. The sign-up
above proves it, and the invitation is waiting.

- **An invitation makes an admin or a member.** An owner is made afterwards, by another owner, so that a
  mistyped address cannot hand a workspace to a stranger.
- **The email can reach anyone, so it can say little of what a stranger chose.** The subject is fixed. The
  workspace's name cannot hold a link or characters that hide text, and the sender appears by the address
  they proved, never by the name they chose.
- **Sending is limited** to 30 an hour and 100 a day per person and 3 a day per address, whoever sends
  them. That last one sits well under what an address can be sent in all, so nobody can use up what it has
  left for a sign-up code or a password reset by inviting it.
- **It lasts 7 days.** Asking again replaces it, and the old link stops working. The cron deletes expired
  ones, since an address in one may have nothing to do with this deployment.
- **It outlives the person who sent it** leaving the workspace, until someone withdraws it or it expires.
  They may have gone for reasons that have nothing to do with it, and admins can see and withdraw it.
- **A deployment that sends no email has no invitations,** and the page says why. A workspace there stays
  one person.

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

Someone out of a workspace also loses what they already hold from its apps, in the same statement: a
trigger on `member` deletes their access tokens, refresh tokens and consent for them. Without that, an
access token would carry on for up to an hour. A token request that passes the check at the very moment
someone is removed can still leave an access token for up to that hour, and the next refresh is refused.

**Consent.** First-party apps skip the consent screen. Workspace apps never do, because `skip_consent`
on them would let any workspace's admin receive a member's address silently. The screen names the app,
the workspace that owns it and the host it sends people back to, from the app's own row, and says that
nobody has checked who runs it. Asked about an app they cannot use, it tells a person nothing.

## Signing in to an app

An app sends someone to the authorization endpoint, and the provider decides where they go next. Each
page it sends them to gets the app's request in its query, signed, and the auth client's
`oauthProviderClient` sends that query back with every POST from the page. The provider's answer says
where to go, and the auth client goes there. So the pages have three duties, all in `lib/oauth-flow.ts`
and `lib/search.ts`:

- **Keep the query as it is.** The signature covers each value. The router's default reads values as
  JSON and writes one value per name, so `state=1e5` came back as `100000` and the repeated `ba_param`
  as a JSON array, and it rewrites the URL to match. So `router.tsx` parses queries as plain text, and
  these pages validate with `z.looseObject`, since `z.object` would strip the request out of the URL.
- **Take it along.** Links between `/login` and `/signup` carry it, and so does GitHub's way back when
  someone is refused. A session is no reason to leave these pages either: someone signed in only reaches
  them when the app asked, with `prompt=login` or `max_age`.
- **Do not navigate.** The auth client is already on its way, and a second navigation would cancel it.

| Page         | When the provider sends someone there                                               |
| ------------ | ----------------------------------------------------------------------------------- |
| `/login`     | Nobody is signed in, or the app asked them to sign in again.                        |
| `/welcome`   | They have only proved an address, so have nothing to sign in with next time. Or the |
|              | app sent `prompt=create`: signed out, this page passes them to `/signup`; signed in |
|              | with a way to sign in, it tells the provider they are done.                         |
| `/consent`   | The app sent `prompt=consent`. Workspace apps will always come here.                |
| `/no-access` | The check above refused them. They can use another account, or go back to the app,  |
|              | which gets `access_denied`.                                                         |

The check does not depend on any of this. A page that sends the wrong thing gets a bad signature, and
a person who skips a page runs into the same checks at the next one.

**The signature runs out after 10 minutes,** which an open page can outlive. No retry can help then,
so the provider's error becomes a "Start again" link, which asks for the app's request afresh.

**Resetting a password leaves the flow.** The link arrives by email, often in another tab or on another
device, so it ends at the account page. The way back is the tab the person left: the app asks again, and
now they pass straight through. The email saying an address already has an account does the same.

**A form cannot be sent before the page's script runs.** Sent that early, the browser would submit it
itself as a GET, with the password in the URL, where history and logs keep it. Pages reached by a full
navigation, which all of these are, have that moment on every load, so `LiveButton` arrives disabled.
A browser will not submit a form whose default button is disabled, not even with Enter.

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
from `BETTER_AUTH_SECRET`, so that replacing the session secret leaves every subject where it is. A
Worker's secrets cannot be read back through Cloudflare's API, and deleting the Worker deletes them, so
keep a copy of this one somewhere else when you generate it.

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
  person for as long as one session lasts. Workspace apps (who may
  not trust each other) need this looked at before they get `backchannel_logout_uri`.
- **Limits on the token and userinfo endpoints are high on purpose,** at 600 a minute per address, because
  apps' servers call them, and a cloud's customers can share an address.
- **A Worker is counted by its zone, not its address.** Every Worker reaches another zone from one address,
  anyone's, so counting by that let any Worker on Cloudflare stop people signing in to Track and Agents. The
  `cf-worker` header says which zone, and a Worker cannot change it: both were measured on 2026-11-05, as was the
  harm. Nothing else is told by that header, as anyone can send it. Track and Agents share a zone, and so a limit,
  which only their own Workers can spend. Apps on another cloud can still share an address and a limit.
- **Being limited costs an app little.** Track and Agents keep no tokens from ID, so nobody is signed out: a
  sign-in fails and works when tried again. A refresh that was limited was never read, so its token still works.

## Registering an app

First-party apps are registered by whoever runs the deployment, and only they can add one. Signed-in
people get no client endpoint (`clientPrivileges` is always false), and Better Auth's admin function can
only run inside the Worker, which no route offers:

```sh
pnpm --filter @gateweave/id-web apps:add --env staging --app track --name "Gateweave Track" \
  --redirect-uri https://track-staging.gateweave.com/api/auth/callback/oidc \
  --backchannel-logout-uri https://track-staging.gateweave.com/api/auth/backchannel-logout/oidc
```

It writes the row with `wrangler d1 execute`, keeps only a hash of the secret, and prints the secret once.
Since this writes what the provider would, `src/server/auth/app-row.ts` is the one part of ID that knows
the provider's table. `test/oidc.test.ts` signs in through a row it builds, so an upgrade that changes what
the provider reads fails there.

## Apps a workspace adds

An owner or admin can add an app from the workspace's page, and [connect-an-app.md](connect-an-app.md) is
what they read next. `workspace-apps.ts` has four endpoints, to add, change, replace a secret and delete.
The provider's own client endpoints stay closed, because they take fields from the caller. These take a
name and redirect URIs, in strict bodies, and write a fixed row that `workspaceAppRow` builds. So nothing
anyone sends can decide `skip_consent`, `metadata` or `reference_id`, and the row is what the check for
who may sign in trusts.

- **Two columns say whose an app is.** `reference_id` finds a workspace's apps, and the triggers below use
  it. `metadata.workspace` is what the token hooks can see of the same fact, as they get the client's
  metadata and not its row. Both are written once, together.
- **An app stays on its host.** People agreed to that host, and it is where their `sub` comes from. If it
  could change, an admin could move everyone's consent to a host they never saw, and every person would
  look new to the app there. Paths on the host can change. To move, add a new app.
- **A code never comes back here.** No app may send people to this server, on any port, because whatever
  this host serves could read the code. On a machine running everything locally, other ports are other
  programs, so they are allowed.
- **Nobody is sent to one of these apps until they are known to be a member.** Anyone with an account can
  add one, so where it goes is anyone's to choose, and the provider redirects to it for a wrong request or
  `prompt=none` before it has looked at who someone is. That would make a link to this server a link to
  anywhere (RFC 9700, section 4.11.2). A hook checks the provider's answer, not the request, so it holds
  for every way of sending someone: anyone signed out stays here, and anyone outside goes to `/no-access`.
  A request sent with POST, which OpenID Connect allows, is first turned into the same request sent with
  GET, so everything here has one place to look. That goes by the request's own address, because the
  provider goes through the same endpoint itself after a sign-in, when the body is what someone typed.
  `prompt=none` for someone signed out asks them to sign in rather than answering `login_required`, which
  OpenID Connect would have it do, because that answer could be sent to anyone. A member can still be sent
  there by a wrong request, which is no more than an admin of their workspace could do anyway. The same
  goes for a member's signed link in someone else's hands: neither answer on the page sends them there.
- **A name is whatever an admin chooses,** so the screen always says whose the app is and where it goes,
  and it reaches only people who accepted an invitation to that workspace. It only takes the names people
  already trust off the table: no workspace or app can hold `Gateweave`, because they also go into
  invitations from this domain, and no app can take a first-party app's name. Both compare after folding
  away what merely looks different. It is not a defence against every lookalike.
- **What people are asked about is what an app gets.** The page lists scopes, so the `claims` parameter
  is dropped before the provider sees it, for every app, which would add to what an app gets without the
  page saying so. OpenID Connect lets a provider leave out what it is asked for that way, and discovery
  says it is not supported.
- **The secret is shown once.** Only its hash is kept, and the app list reads named columns, so the hash
  stays out of it too.
- **Adding, replacing a secret and deleting want a recent sign-in,** as deleting a workspace does. A new
  secret gets at every member who agrees, so it should outlast a stolen cookie. Making someone an admin
  or owner wants one too, or that cookie could make its thief an admin with a new session. Renaming does
  not.
- **No `sid`, and no logout URIs.** `enable_end_session` is off, so ID tokens hold no `sid`, which two
  apps that do not trust each other could use to match someone up across a session. Back-channel logout
  for these apps is ID-20. Introspection would tell an app the same thing, whatever its ID tokens leave
  out, and nothing here uses it, so `/oauth2/introspect` is closed for every app and left out of discovery.
  `auth_time` stays, because `max_age` needs it. To the second, it is a weaker way of doing the same, and
  we accept that.
- **`/oauth2/public-client` and `-prelogin` are closed.** They name any app to anyone who has its id.
  What a person may be told about an app is on the consent page, and it depends on who they are. The same
  rule holds in someone's own activity: an app a workspace added is named only to its members, so being
  refused by one tells nobody what it is called. Its id alone means nothing to anyone, so it is not shown
  in its place.

An app belongs to its workspace, so it stays when the admin who added it leaves. If they run its host,
the members who agreed to it can still reach it until someone deletes it.

**Removal is in the database, not in hooks.** Migration `0007` has a trigger on `member` that ends what
someone holds, and one on `organization` that deletes its apps, whose tokens and consents follow by their
foreign keys. A hook would hold only for the paths someone remembered, and cascades from deleting a user
or a workspace would pass it by.

## A patched dependency

`patches/` changes two things in how `@better-auth/oauth-provider` sends back-channel logouts. pnpm stops an
install when a patch no longer has its version, so an upgrade has to look at both again: drop what upstream
has fixed, and move the rest.

- **`redirect: "error"`, which Workers refuse outright,** so every logout failed with only a warning in the
  log. It is `"manual"` now. The provider treats anything but 200 or 204 as a failure, so a redirect still
  is not followed. The same line is in 1.7.17.
- **One try, of five seconds.** Track once took longer than that on production, for a reason its logs do not
  show, and whoever had signed out of ID stayed signed in to it. An app now gets three tries, two seconds
  apart, when the answer is a failure of the app's (5xx) or no answer at all, and all of them fit in the 30
  seconds Workers give work after a response. That is the recoverable case the specification allows sending
  again for (section 2.5). A 4xx would only repeat. The token is the same each time, and a person already
  signed out counts as a success (section 2.7). An app down for longer than that still misses it, and the
  person stays signed in there until that session runs out.

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
  since `generic-oauth` has none. It has to finish even when ID stops waiting for the answer, which on
  Workers takes `waitUntil`, or that request is cancelled along with the logout. And when it cannot fetch
  ID's keys at that moment it answers 503, not 400, so that ID tries again.

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
- Rate limits are durable and keyed by `cf-connecting-ip`, or by zone for a Worker.
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

## Audit log

An identity provider has to be able to answer who signed in to what, and who changed what. `audit_event`
holds it, in D1.

- **Signing in:** `account_created` and `sign_in`, with how (`password`, `code`, `passkey`, `github`,
  `totp`, `recovery_code`), and `sign_in_failed`, for a wrong password, a passkey that did not hold up or a
  wrong code, against the account it was for. `two_factor_asked` is a right password with a code still
  owed, which is not someone signing in, though someone who did not enter it will want to know.
- **Apps:** `app_sign_in` when an app exchanges a code, the moment it learns who someone is, `refused`
  by the check at authorization or on refresh, `consent_granted`, `consent_denied`, and `token_revoked`
  when an app revokes a token. That last one names no person: an app's server is asking, and tokens are
  stored hashed.
- **Changes to an account:** `password_changed` (`first`, `changed`, `reset` or `removed`), `passkey_added`,
  `passkey_removed`, `two_factor_enabled`, `two_factor_disabled` (`operator` when `two-factor:remove` did
  it), `recovery_codes_replaced`, `provider_linked`, `provider_unlinked`, and `sessions_revoked` for
  someone ending a session elsewhere.
- **Workspaces:** `workspace_created`, `workspace_renamed`, `workspace_deleted`, `member_invited`,
  `invitation_canceled`, `invitation_accepted`, `invitation_declined`, `member_role_changed`,
  `member_removed` and `member_left`.
- **The deployment:** `app_added`, from `apps:add`. Who ran it is between them and Cloudflare.

Each row has the time, and where it applies the account, the app's own id, the IP address and a device
name such as "Chrome on Windows". A workspace's rows also have its id, and its name and any role in
`detail`, which is all that is left of it once it is deleted. There, `user_id` is who it happened to and
`actor_id` who did it. A workspace's admins will see their workspace's events through an endpoint of its
own.

Not recorded: signing out, a refresh that changes nothing, and a refresh token reused, which the provider
answers and revokes with no hook to hear it. A request stopped by the rate limit or Turnstile never gets
this far, which is what bounds the rows a person's account can collect.

**This is personal data**, so what it keeps is decided on purpose:

- **Ninety days.** The daily cron deletes older rows. That is long enough to look into something noticed
  late, and it is a constant, `AUDIT_RETENTION_DAYS`, because a promise about personal data should not
  vary by accident.
- **No addresses.** The account's id says who. A failed sign-in for an address with no account writes
  nothing at all: what someone typed may be a password in the wrong field, and there is no end to
  addresses with no account for a stranger to send. `member_invited` does not say who was invited, for
  the same reason.
- **No foreign keys.** A log someone can empty by deleting what it talks about is no log. Rows outlive
  an account until their ninety days are up. ID cannot delete an account yet; a privacy policy has to
  state this when it can.

A person sees their last 50 events on their account page: what happened to them, and what they did to
someone else. Where someone else did it, they see who, and not that person's IP address or device. Nobody
can read anyone else's.

Every write happens after the response. A failed sign-in writes a row only for an address with an
account, so a response that waited for the write would say which addresses have one, as sending email
in the background already avoids. A write that fails stops nothing, and logs
`audit: could not record <type>` with the kind of error, and nothing about whose it was.

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

`apps/web/e2e/oidc.spec.ts` drives the pages in Chromium with `oauth4webapi` as the app's server,
through real redirects: making an account on the way to an app, signing in, each `prompt`, refusal, and
a page that has been open too long. It found the router breaking signed queries, and passwords reaching
the URL from forms sent before the page's script ran.

`apps/web/test/passkeys.test.ts` holds what the server takes and refuses, with a software authenticator
of its own that can sign what a real one never would. `apps/web/e2e/passkeys.spec.ts` drives the pages
with Chromium's WebAuthn and a virtual authenticator, which found someone with only a passkey being asked
for a password on the way to an app. That authenticator answers the browser's offer under the email field
by itself, so no test sees the list a person chooses from. It was looked at once by hand, on staging on
2026-11-04, with that authenticator in Chromium: the list names the address, choosing from it signs in, the
button does too, and a key whose signature counter went backwards is refused.

On 2026-11-04 Track's staging signed a browser in through ID's staging, both deployed Workers on Custom
Domains of one zone: discovery, the code exchange and the JWKS from Track to ID, a refused person landing
on `/no-access`, and signing out of ID ending Track's session through back-channel logout, which proves
that round trip to a product's own endpoint. The same day Agents' staging did all of that too, and the
button then signed someone in with no password while ID's session lasted.

On 2026-11-04 the same held on production: one sign-in through Track's button, then Agents' with no
password, each with its own session and no provider tokens kept, signing out of ID ending both, signing out
of Track leaving ID alone, and a refused person reaching `/no-access` from each. One run in between found
signing out of ID leaving Track's session in place (see "A patched dependency"), and this was run again and
held on ID 0.2.1, Track 0.26.2 and Agents 0.12.2, all on Better Auth 1.7.16. The first real account came
the same day, through Agents' button and GitHub: Agents and then Track each linked it to the account that
person already had, by its verified address, with no new user in either.

`apps/web/test/two-factor.test.ts` holds two-factor sign-in against an authenticator written from RFC 6238
rather than with the library ID uses, so that a pass says an authenticator app can use what ID hands out,
and not only that the library agrees with itself. `apps/web/e2e/two-factor.spec.ts` drives the pages,
including on the way to an app. On 2026-11-04 it held on staging and on production, through Track's button:
turning it on ending Track's session, a right password stopping at `/two-factor` with no session in Track, a
code going on to Track, the same code refused a second time within its window, a recovery code in capitals
working, and turning it off leaving no keys behind.

`apps/web/test/workspaces.test.ts` holds what the gate lets through and what the database refuses, for each
role and for someone from outside, and `apps/web/e2e/workspaces.spec.ts` drives the pages: two people from an
invitation to a removal, an invitation for someone else, a narrow screen, and signing in on the way to one.

`apps/web/test/workspace-apps.test.ts` holds who can add an app, who reaches one and what they get from it, and
`apps/web/e2e/workspace-apps.spec.ts` drives the pages. An independent read of the first version, before it was
released, found what all of its tests and its run on staging had not: anyone can add an app, and the provider
redirected to one before it knew who someone was, so a link to ID could lead anywhere. That read is worth having
before a release of anything like this.

On 2026-11-05 what came of it held on staging and then on production, on ID 0.4.0, with `oauth4webapi` outside
Cloudflare as the app's server and two people made for the run. Someone signed out or from outside stayed on ID
through a wrong link, `prompt=none` and a POST. A member signed in under a subject that was not their account's
id, and named claims got the app no more than its scopes. Signing in with a password on the way put nothing typed
into any address. Replacing a secret left people signed in, and removing someone stopped their access and refresh
tokens at once and left no rows. Deleting a workspace took its apps along, and a first-party app still signed
people in without asking.

Still unproven:

- A real passkey, from Windows Hello or a phone, rather than a virtual authenticator.
- An invitation email sent by a deployed Worker.
- A workspace's app that someone runs, rather than one a script plays.
- Cloudflare Access against a deployed ID.
- The OpenID conformance suite, which Pocket ID has passed and ID should too.
