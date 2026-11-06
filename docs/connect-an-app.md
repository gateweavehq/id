# Connect an app

Your own app can sign people in with Gateweave ID. It works with any library that speaks OpenID Connect,
and only members of the workspace that added it can use it. To put a sign-in in front of an app without
changing the app, use [Cloudflare Access](cloudflare-access.md).

Gateweave ID is not certified. The OpenID conformance suite's Basic OP and Config OP plans pass, and
[The OpenID conformance suite](conformance.md) says what differs and why, so check that it does what you need
before you rely on it.

## Add it

You need to be an owner or admin of the workspace, and to have signed in within the last day. If you
signed in longer ago than that, sign out and in again.

1. Open the workspace, and find **Apps**.
2. Give the app a name. People see it when they are asked about the app.
3. Enter its redirect URIs, one to a line: the exact addresses your app takes the code back at.
4. Save the three values it shows you: the issuer, the client ID and the client secret. The secret is
   not kept, so it cannot be shown again. If you lose it, replace it.

A redirect URI must be an exact `https` address, or plain `http` on `localhost` or `127.0.0.1` while you
try things out. All of an app's URIs must be on one host, which cannot be this server's own, and an app
keeps that host for good. To move, add a new app there and delete the old one. People are asked again,
and your app sees them as new people, because their ids in an app are computed from its host.

## Configure your app

| Setting           | Value                                                                  |
| ----------------- | ---------------------------------------------------------------------- |
| Issuer            | What the page showed, such as `https://id.gateweave.com`               |
| Discovery         | `<issuer>/.well-known/openid-configuration`                            |
| Client ID, secret | What the page showed                                                   |
| Client auth       | `client_secret_basic`: HTTP Basic at the token endpoint                |
| Flow              | Authorization code, with PKCE (`S256`)                                 |
| Scopes            | `openid`, and any of `profile`, `email`, `offline_access` and `groups` |

### If your library needs something else

Both of these are under **If your app's library needs something else** when you add or edit the app.

- **Client auth.** Choose `client_secret_post` if your library sends the secret in the body of the
  request. An app is registered for one way, and the other is refused.
- **PKCE.** Turn **Require PKCE** off only if your library cannot do it. Your app then has to send a
  `nonce` and check it in the ID token, because nothing else stops a code that goes astray from signing
  someone in. ID does not check that you do. A request for `offline_access` needs PKCE or a nonce either
  way. An app that does send a challenge is held to it, on or off.

Turning **Require PKCE** off asks for a recent sign-in, like adding an app.

People are asked about scopes, so scopes decide what your app gets. The `claims` request parameter is
ignored. There is no introspection endpoint, because your app has what it needs in the ID token and from
userinfo.

Let your library read everything else from discovery. For example, with
[`oauth4webapi`](https://github.com/panva/oauth4webapi):

```ts
import * as oauth from "oauth4webapi";

const issuer = new URL(process.env.GATEWEAVE_ISSUER);
const as = await oauth.processDiscoveryResponse(issuer, await oauth.discoveryRequest(issuer));
const client = { client_id: process.env.GATEWEAVE_CLIENT_ID };
const auth = oauth.ClientSecretBasic(process.env.GATEWEAVE_CLIENT_SECRET);
```

## What your app gets

The ID token is signed with RS256, and your library checks it against the keys in discovery.

| Claim                     | With scope | What it is                                           |
| ------------------------- | ---------- | ---------------------------------------------------- |
| `sub`                     | `openid`   | This person's id in your app. Key your data on this. |
| `email`, `email_verified` | `email`    | Their address, which ID has always verified          |
| `name`, `picture`         | `profile`  | Their name, and a picture if they have one           |
| `groups`                  | `groups`   | The names of their groups in your workspace          |

`sub` is the same for one person every time, and different on every host, so apps on two hosts cannot
match people up by it. Apps on one host do share it, so every app on `localhost:3000` sees the same one.
It is not their account id, and it is not an address that could change.

An ID token does not say which workspace someone is in, or their role in it. Anyone who gets as far as
your app is a member of the workspace that added it, and in one of its groups if an admin narrowed it to
some.

`groups` is an array, empty for someone in none, with all of their groups in the workspace that added your
app, and never another workspace's. It is at userinfo as well. Admins can rename a group, and the new name
is what your app sees at userinfo and in the next ID token, so a rule in your app that matches on a name
follows it. Each person is asked about this scope like any other.

Name the scopes you want. A request with no `scope` asks for every scope your app may have, `groups` included.

`offline_access` gets a refresh token, which rotates each time it is used.

## What people see

The first time, each person is asked whether your app may have what it asked for. The page says what the
app is called, which workspace's admin added it, and which host it goes to. It also says that nobody has
checked who runs it, because nobody has. After they say yes, they are not asked again unless your app
asks for more.

Someone outside the workspace is turned away before they are asked, and is told nothing about your app.
Your app hears nothing either.

**ID sends nobody to your app until it knows they are a member.** Anyone can add an app, so if a mistake
in a request sent people straight back to it, a link to ID could be a link to anywhere. So only a member
who is signed in sees your app get an error for a wrong request. Someone signed in from outside the
workspace sees the page that names no app. Someone signed out sees a page saying the request was refused,
and it names **Require PKCE** if that is why, since signing in would not change the answer.

`prompt=none` follows the same rule. A member gets the usual answer, with a code or an error. Someone
signed out is asked to sign in instead of your app getting `login_required`, and then goes on to your app.

## Keeping your app to some of a workspace

An admin can narrow your app to some of the workspace's groups, under **Who can use it** on the workspace's
page. Anyone else in the workspace is then treated like anyone outside it, and sees a page that names no
app. Being an owner or an admin does not change that. An app narrowed to groups with nobody in them admits
nobody, and a group an app names cannot be deleted until the app stops naming it, so an app only ever opens
to everyone when an admin chooses that.

## When someone leaves or takes your app back

When someone leaves a workspace or is removed, they lose its apps at once. The same goes for someone taken
out of the last group that opens your app, and for anyone an admin leaves out when narrowing it. Anyone can
also take your app back from their account page, and stay in the workspace. Either way their access tokens, refresh tokens
and consent are deleted, so anything your app does with those tokens starts failing, and a code you have
not exchanged yet is refused, unless they have since allowed your app at least its scopes. If they come
back, they are asked again.

When someone answers your consent screen with a different list of scopes, the tokens you hold for them
end, on every device. That happens when you ask for a scope they have not allowed, with or without
`prompt=consent`, and with `prompt=consent` when the same scopes come in another order. Their answer
replaces the old list rather than adding to it, so ask for everything you need each time: a request that
leaves out `offline_access` gets no refresh token. The code from that answer buys new tokens, so sign them
in with it.

Your app is not told, and its own sessions are its own to end. **If your app keeps people signed in
longer than an access token lasts, use `offline_access` and refresh, and end the session when a refresh
fails.** Without that, someone who has left the workspace or taken your app back stays signed in to your
app until its own session ends. Back-channel logout is not available to apps a workspace adds yet.

## Changing it later

Under **Apps** you can:

- **Edit** its name, its redirect URIs on the same host, and what its library needs.
- **Replace the secret.** The old one stops working at once, so your app cannot refresh or sign anyone in
  until it has the new one. People stay signed in, and tokens already issued keep working until they
  expire.
- **Delete** it. Everyone is signed out of it at once, and this cannot be undone. Deleting a workspace
  deletes its apps.

Each of these is in the activity of whoever did it.

A workspace can have up to 20 apps, and an app up to 5 redirect URIs. A name cannot hold Gateweave, and
an app cannot take the name of one that everyone on this deployment can use.

An app belongs to its workspace, not to whoever added it, so it stays when they leave. When someone who
ran an app leaves, delete it or replace its secret. The app list says who added each app, and says so when
they are no longer in the workspace.
