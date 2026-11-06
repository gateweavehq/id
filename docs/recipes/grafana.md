# Sign in to Grafana with Gateweave ID

Grafana works with ID's default settings, and can set each person's role from their groups.

**How far this has been checked.** On 2026-11-06 a script ran this against ID's staging server, with Grafana
13.3.0 in Docker on `localhost`, in Chromium. [What has not been tried](#what-has-not-been-tried) has the rest.

## 1. Add Grafana to your workspace as an app

Follow [Add it](../connect-an-app.md#add-it), with this as the redirect URI:

```text
https://grafana.example.com/login/generic_oauth
```

Leave everything under **If your app's library needs something else** as it is. Save the issuer, the client ID
and the client secret.

To give some people more than **Viewer**, add a group to the workspace, here called `grafana-admins`, and put
them in it.

## 2. Configure Grafana

These are Grafana's own settings, as environment variables, with the three addresses spelled out. Replace
`https://id.gateweave.com` if you run your own server.

```sh
GF_SERVER_ROOT_URL=https://grafana.example.com
GF_AUTH_GENERIC_OAUTH_ENABLED=true
GF_AUTH_GENERIC_OAUTH_NAME="Gateweave ID"
GF_AUTH_GENERIC_OAUTH_CLIENT_ID=<client id>
GF_AUTH_GENERIC_OAUTH_CLIENT_SECRET=<client secret>
GF_AUTH_GENERIC_OAUTH_SCOPES="openid profile email groups offline_access"
GF_AUTH_GENERIC_OAUTH_AUTH_URL=https://id.gateweave.com/api/auth/oauth2/authorize
GF_AUTH_GENERIC_OAUTH_TOKEN_URL=https://id.gateweave.com/api/auth/oauth2/token
GF_AUTH_GENERIC_OAUTH_API_URL=https://id.gateweave.com/api/auth/oauth2/userinfo
GF_AUTH_GENERIC_OAUTH_AUTH_STYLE=InHeader
GF_AUTH_GENERIC_OAUTH_USE_PKCE=true
GF_AUTH_GENERIC_OAUTH_USE_REFRESH_TOKEN=true
GF_AUTH_GENERIC_OAUTH_ALLOW_SIGN_UP=true
GF_AUTH_GENERIC_OAUTH_ROLE_ATTRIBUTE_PATH="contains(groups[*], 'grafana-admins') && 'Admin' || 'Viewer'"
GF_AUTH_GENERIC_OAUTH_ROLE_ATTRIBUTE_STRICT=true
```

`AUTH_STYLE=InHeader` is what makes Grafana send the secret the way ID expects, and `USE_PKCE=true` is what
**Require PKCE** asks for.

## What you should see

Grafana's sign-in page gets a button for Gateweave ID. The first time, ID asks each person whether
Grafana may have those scopes, and then they are back in Grafana, with an account made from their address and
name.

| Their groups        | Role in Grafana | Grafana server admin |
| ------------------- | --------------- | -------------------- |
| In `grafana-admins` | Admin           | No                   |
| Not in it           | Viewer          | No                   |

Only members of the workspace get as far as Grafana, as with [any app](../connect-an-app.md#what-people-see).

## What has not been tried

- A deployment on a real `https` address.
- Grafana using its refresh token. ID issued one, and the run ended before it was needed.
- Signing out, in either direction. Apps a workspace adds do not hear about a sign-out from ID yet.
- Moving someone in or out of the group while they are signed in to Grafana.
