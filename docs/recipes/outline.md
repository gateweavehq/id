# Sign in to Outline with Gateweave ID

Outline works once its app is set to send the secret in the body of the request, which is the one setting it
needs changed.

**How far this has been checked.** On 2026-11-06 a script ran this against ID's staging server, with Outline
1.12.0 in Docker on `localhost`, in Chromium. [What has not been tried](#what-has-not-been-tried) has the rest.

## 1. Add Outline to your workspace as an app

Follow [Add it](../connect-an-app.md#add-it), with this as the redirect URI:

```text
https://outline.example.com/auth/oidc.callback
```

Then, under **If your app's library needs something else**, choose **In the body of the request
(client_secret_post)**. Leave **Require PKCE** on, because Outline does PKCE. Save the issuer, the client ID and
the client secret.

## 2. Configure Outline

Add these to the rest of Outline's settings, replacing `https://id.gateweave.com` if you run your own server.
Outline reads the addresses from discovery.

```sh
URL=https://outline.example.com
OIDC_ISSUER_URL=https://id.gateweave.com
OIDC_CLIENT_ID=<client id>
OIDC_CLIENT_SECRET=<client secret>
OIDC_DISPLAY_NAME="Gateweave ID"
```

The run also had `OIDC_DISABLE_REDIRECT=true`, which keeps Outline's own sign-in page with its button instead
of going straight to ID. `OIDC_USERNAME_CLAIM` was not needed.

## What you should see

Outline's sign-in page gets a button for Gateweave ID. The first time, ID asks each person whether
Outline may have their name and address, and then they are in Outline. The first person became its admin.

If you left the app on ID's default, ID's consent page still appears, and then Outline only says
**Authentication failed**. Its log has the reason:

```text
OAuth error during authentication: client registered for client_secret_basic cannot use client_secret_post
```

## What has not been tried

- A deployment on a real `https` address. On `localhost` the run also needed `FORCE_HTTPS=false`.
- A second person, and what role they get.
- Groups. Outline did not ask for that scope here.
- Signing out, in either direction. Apps a workspace adds do not hear about a sign-out from ID yet.
