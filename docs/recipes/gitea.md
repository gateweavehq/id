# Sign in to Gitea with Gateweave ID

Gitea works once **Require PKCE** is off, and can make people admins from their groups. Read
[what that setting costs](#what-turning-require-pkce-off-costs) before you decide.

**How far this has been checked.** On 2026-11-06 a script ran this against ID's staging server, with Gitea
28.3.0 in Docker on `localhost`, in Chromium. [What has not been tried](#what-has-not-been-tried) has the rest.

## What turning Require PKCE off costs

Gitea 28.3.0 asks ID for a code with `state`, and with neither PKCE nor a `nonce`. ID can't make it send them.

[Connect an app](../connect-an-app.md#if-your-library-needs-something-else) says an app without PKCE has to
send a `nonce` and check it. Gitea does not, so nothing stops a code that goes astray from signing someone in:
whoever holds it can start their own sign-in at Gitea and hand it in there. `state` does not help, because it
is theirs. This is authorization code injection
([RFC 9700, section 4.5](https://www.rfc-editor.org/rfc/rfc9700#section-4.5)).

So it is worth doing only if you accept that for your Gitea. If a later version of Gitea sends PKCE, turn the
setting back on.

## 1. Make your own admin first

The only user on a Gitea is made an admin, whatever their groups say. With nobody else there, the first person
to sign in with ID becomes one. Make your own admin before you add the sign-in:

```sh
gitea admin user create --username <name> --email <address> --password <password> --admin
```

In the official Docker image, run `gitea` commands as the `git` user: `docker compose exec -u git gitea gitea …`.

## 2. Add Gitea to your workspace as an app

Follow [Add it](../connect-an-app.md#add-it), with this as the redirect URI. The `gateweave` in it is the name
you give the sign-in in the next step.

```text
https://gitea.example.com/user/oauth2/gateweave/callback
```

Then, under **If your app's library needs something else**, turn **Require PKCE** off. That asks for a recent
sign-in. Save the issuer, the client ID and the client secret.

To make some people admins, add a group to the workspace, here called `gitea-admins`, and put them in it.

## 3. Configure Gitea

Add the sign-in, replacing `https://id.gateweave.com` if you run your own server. Leave `offline_access` out:
ID refuses a request for it with neither PKCE nor a `nonce`.

```sh
gitea admin auth add-oauth \
  --name gateweave \
  --provider openidConnect \
  --key <client id> \
  --secret <client secret> \
  --auto-discover-url https://id.gateweave.com/.well-known/openid-configuration \
  --scopes openid --scopes profile --scopes email --scopes groups \
  --group-claim-name groups \
  --admin-group gitea-admins
```

Then restart Gitea. The run also set these, which are `app.ini` settings written as the image's environment
variables, so that people get an account the first time they sign in:

```sh
GITEA__service__DISABLE_REGISTRATION=false
GITEA__service__ALLOW_ONLY_EXTERNAL_REGISTRATION=true
GITEA__oauth2_client__ENABLE_AUTO_REGISTRATION=true
GITEA__oauth2_client__USERNAME=email
GITEA__oauth2_client__ACCOUNT_LINKING=disabled
GITEA__oauth2_client__UPDATE_AVATAR=false
```

## What you should see

Gitea's sign-in page gets a button for `gateweave`. The first time, ID asks each person whether Gitea may have
those scopes, and then they are on Gitea's dashboard, with a username from the part of their address before
the `@`.

With another admin already there:

| Their groups      | Gitea's admin pages |
| ----------------- | ------------------- |
| In `gitea-admins` | Open                |
| Not in it         | 403                 |

If **Require PKCE** is still on, someone signed out sees a page at ID saying that the app left out PKCE, and
nothing reaches Gitea.

## What has not been tried

- A deployment on a real `https` address.
- Taking someone out of `gitea-admins` and having them sign in again.
- `--restricted-group` and `--required-claim-name`.
- Two people whose addresses start the same way, which `USERNAME=email` would give the same username.
- Signing out, in either direction. Apps a workspace adds do not hear about a sign-out from ID yet.
