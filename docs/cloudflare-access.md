# Put Cloudflare Access in front of an internal app

Cloudflare Access can keep an app behind a sign-in, and Cloudflare Tunnel can reach that app with no port
open to the internet. Gateweave ID can be the sign-in, so only members of your workspace get as far as
Access's rules. You run `cloudflared` next to the app, and no server of your own.

**How far this has been checked.** On 2026-11-06 a script ran this against ID's staging server (v0.9.0), with
`cloudflared` 2026.10.7 and a small test app, in Chromium. It made the provider, the applications and the
tunnel through Cloudflare's API with the values below, so the dashboard steps here come from Cloudflare's
documentation and nobody has clicked through them. [What has not been tried](#what-has-not-been-tried) has
the rest.

## Before you start

You need:

- A workspace on ID where you are an owner or admin. [Connect an app](connect-an-app.md) says what adding an
  app asks of you.
- A Zero Trust team on Cloudflare, whose name is `<team>` below, and a domain on Cloudflare for the app's
  address.
- Somewhere to run `cloudflared` that can reach the app.

**A new provider appears on your other Access applications.** An application that does not list its
providers accepts all of them, so its login page gets another button as soon as you save. Members of your
workspace can use that button. A rule that names addresses decides as it did before, but a rule as broad as
**Everyone** now lets them in. Before you save, look for applications that accept every provider, and choose
their **Identity providers** if that is not what you want.

## 1. Add Access to your workspace as an app

Follow [Add it](connect-an-app.md#add-it), with this as the redirect URI:

```text
https://<team>.cloudflareaccess.com/cdn-cgi/access/callback
```

Leave everything under **If your app's library needs something else** as it is. Access sends the secret with
HTTP Basic and does PKCE, which is what the form sets. It sends no `nonce`, so keep **Require PKCE** on:
nothing else would protect the code.

Save the issuer, the client ID and the client secret.

## 2. Add ID to Access as a provider

In Cloudflare, open **Zero Trust** > **Integrations** > **Identity providers**, select **Add new identity
provider**, then **OpenID Connect**.

| Field                        | Value                                  |
| ---------------------------- | -------------------------------------- |
| Name                         | What people should see on a login page |
| Client ID                    | From step 1                            |
| Client secret                | From step 1                            |
| Auth URL                     | `<issuer>/api/auth/oauth2/authorize`   |
| Token URL                    | `<issuer>/api/auth/oauth2/token`       |
| Certificate URL              | `<issuer>/api/auth/jwks`               |
| Proof of Key Exchange (PKCE) | On                                     |

Leave **Email claim** at `email`. ID only ever gives an address it has verified.

To write rules on groups, make the provider as [Rules on groups](#rules-on-groups) shows instead of with this
form, because they need more than it offers.

A change to a provider can take a while to reach sign-ins. Fifteen seconds after one, Access was still asking
for what the old settings said, so give it a minute before you judge the result.

## 3. Make the Access application

Make this before the tunnel's route, because an app with a route and no Access application is open to anyone.

Open **Zero Trust** > **Access controls** > **Applications**, select **Create new application**, then
**Self-hosted and private**.

- **Add public hostname:** the address the app will have.
- **Access policies:** an Allow policy that says who may in, such as **Emails**, or a rule on a group. An
  application refuses everyone until someone matches.
- **Identity providers:** only the one you just made. **Apply instant authentication** then sends people
  straight to ID, with no Access login page first.
- **Session Duration:** as short as you can live with, for the reason in
  [Signing out and taking people out](#signing-out-and-taking-people-out).

## 4. Reach the app through a tunnel

Open **Networking** > **Tunnels** and select **Create a tunnel**. Cloudflare shows a command with a token in
it. To run it in a container next to your app instead, set `TUNNEL_TOKEN` to that token and run:

```sh
docker run -d --name cloudflared --network <your app's network> -e TUNNEL_TOKEN \
  cloudflare/cloudflared:2026.10.7 tunnel --no-autoupdate run
```

Once it connects, add a route of the kind **Published application**, with the address from step 3, and as its
**Service URL** the app's address as `cloudflared` sees it, such as `http://my-app:8080`.

Open the address in a private window. You should land on ID, sign in, be asked once whether Access may have
what it asked for, and arrive at your app.

## Rules on groups

An Access rule can use the groups in your workspace, as long as two things are set:

- **Access has to ask for the `groups` scope.** ID leaves `groups` out of the ID token otherwise.
- **`groups` has to be listed under OIDC Claims.** Access drops a claim it was not told about, even when the
  token holds it.

Cloudflare's documentation shows no field for scopes in the dashboard, and a provider made without them holds
`openid`, `email` and `profile`. The way this has been seen to work is to make the provider through the API,
with a token that has **Access: Organizations, Identity Providers, and Groups Write**. This takes the place of
step 2. If you have already made a provider there, this makes a second one, so choose the new one under your
application's **Identity providers** and delete the old one. A rule only sees claims from the provider it names.

Put the settings in a file, so that the client secret stays out of your shell's history:

```json
{
	"name": "Gateweave ID",
	"type": "oidc",
	"config": {
		"client_id": "<client id>",
		"client_secret": "<client secret>",
		"auth_url": "<issuer>/api/auth/oauth2/authorize",
		"token_url": "<issuer>/api/auth/oauth2/token",
		"certs_url": "<issuer>/api/auth/jwks",
		"pkce_enabled": true,
		"email_claim_name": "email",
		"scopes": ["openid", "email", "profile", "groups"],
		"claims": ["groups"]
	}
}
```

Then send it, and delete the file. The answer holds the new provider's `id`:

```sh
curl "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/access/identity_providers" \
  --request POST \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  --header "Content-Type: application/json" \
  --data @provider.json
rm provider.json
```

**Not settled:** whether a provider made in the dashboard, with `groups` only under **OIDC Claims**, asks for the
scope as well. It would make this simpler, and the runs so far do not agree. To see what you have, sign in and
open `https://<your app>/cdn-cgi/access/get-identity`. `custom.groups` should list your groups.

Then, in the application's policy, choose the selector **OIDC Claim**, the claim name `groups`, and the group's
name as the value. In the API, that is:

```json
{
	"oidc": {
		"claim_name": "groups",
		"claim_value": "engineers",
		"identity_provider_id": "<provider id>"
	}
}
```

Someone in several groups matches on any one of them: a rule on `engineers` let in someone in both `engineers`
and `ops`, and kept out a member in no group.

The value is the group's name, so a rule follows no rename. If an admin renames the group in ID, change the rule
too. Cloudflare's table of selectors says this one is checked at login and not continuously, so joining or
leaving a group counts from someone's next Access sign-in.

You can also [narrow the app to some groups in ID](connect-an-app.md#keeping-your-app-to-some-of-a-workspace).
That applies before Access is involved, and needs none of the above.

## What your app gets

Access adds two headers to each request that reaches your app:

| Header                               | What it holds                               |
| ------------------------------------ | ------------------------------------------- |
| `Cf-Access-Authenticated-User-Email` | The address ID gave                         |
| `Cf-Access-Jwt-Assertion`            | A token signed by Access, about this person |

The token holds `email`, and under `custom` each claim you listed, such as
`"custom": { "groups": ["engineers", "ops"] }`. For someone in no group, that is `[]`.

The tunnel keeps your app off the internet, but anything else on its network can still reach it. An app that
acts on who someone is should verify this token, as
[Cloudflare describes](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/),
rather than trust the header. Access signs it with keys of its own, so check it against your team's keys and not
against ID's.

## Who gets in

| Who                             | What they see                                                             |
| ------------------------------- | ------------------------------------------------------------------------- |
| Someone outside the workspace   | ID's "You do not have access". Access hears nothing, and no seat is taken |
| A member no Access rule matches | ID, then Access's "That account does not have access."                    |
| A member a rule matches         | ID, then the app                                                          |

Each person is asked once whether Access may have what it asked for, because an app a workspace adds always
asks. Cloudflare counts each person who signs in through Access as a Zero Trust seat.

## Signing out and taking people out

**Access keeps a session of its own, and ID cannot end it.** ID does not tell Access when someone signs out or
leaves.

| You do this                       | What happens                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| Sign out of ID                    | The Access session goes on                                                                  |
| Open `/cdn-cgi/access/logout`     | The Access session ends, and ID's does not, so the next visit gets through with no question |
| Remove someone from the workspace | Their live Access session goes on. The next time Access sends them to ID, ID refuses them   |

So when someone must lose access now, remove them from the workspace **and** revoke them in Cloudflare, under
**Zero Trust** > **Team & Resources** > **Users**, then **Action** > **Revoke**. Otherwise they keep the app until
their Access session runs out.

Access has two lengths to set: the application's **Session Duration**, and a global session that decides how
often people go back to ID. Cloudflare's default for both is 24 hours, so someone removed from your workspace can
keep an app for that long if nobody revokes them.

## If it does not work

| What you see                                                                                                              | Why                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Access's "Failed to fetch user/group information from the identity provider", with `error=invalid_request` in the address | PKCE is off in Access. Turn it on                                                               |
| ID's "You do not have access"                                                                                             | They are not in the workspace, or not in a group the app is narrowed to in ID                   |
| Access's "That account does not have access."                                                                             | ID let them through and no Access rule matches. On a rule about groups, look at `get-identity`  |
| Access's "Unable to find your Access application!"                                                                        | An application was deleted and made again with the same address moments ago. Wait a few minutes |

## What has not been tried

- Clicking through Cloudflare's dashboard, as the steps above describe, rather than using its API.
- ID's production server or a self-hosted one, which run the same code as staging.
- A real app in place of the test one, a browser other than Chromium, or a phone.
- Access's SCIM provisioning, service tokens, the Cloudflare One client, and Access for SaaS apps.
- Revoking someone in Cloudflare and seeing their session end, which comes from Cloudflare's documentation.
