# Self-hosting

Gateweave ID runs on your own Cloudflare account as one Worker, with a D1 database for accounts, a Durable
Object for rate limits and a Queue for logouts an app missed.

Use the Workers Paid plan. On the Free plan a request gets
[10 ms of CPU](https://developers.cloudflare.com/workers/platform/limits/), and checking a password takes
about 100 ms. [Email to any address](https://developers.cloudflare.com/email-service/platform/pricing/) needs the
Paid plan too. ID has not been run on the Free plan.

There are two ways to deploy: the button, which also sets up deploys on every push, or the command line.
Either way, [claim your server](#claim-your-server) as soon as it is up.

## Deploy with the button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/gateweavehq/id)

The button copies this repository to your GitHub or GitLab account and connects the copy to Workers Builds,
so every push to its main branch deploys. On the form:

- **Git account** is the first field, the account the copy goes to. If nothing is connected yet, connect GitHub or
  GitLab there.
- **Project name** names the Worker. It answers on `<project name>.<your subdomain>.workers.dev`.
- **D1 database** and **Queue**: choose **Create new**, unless you are moving a server you already run. Each then
  shows a name field that starts with this repository's name. On a Cloudflare account that already runs ID, give
  both names of their own. There the form starts with the existing queue chosen, and two servers cannot share one.
- **BETTER_AUTH_SECRET** signs sessions. Use a long random string, for example from
  `openssl rand -base64 32`, and keep it secret. Changing it later signs everyone out.
- Leave the build and deploy commands as they are. The deploy command applies the database migrations before
  the new code goes live.

Escape closes the whole form rather than one list, and what you filled in goes with it.

## Deploy from the command line

Requirements: Node.js 24 (22+ works) and pnpm 12.

```sh
git clone https://github.com/gateweavehq/id.git
cd id
pnpm install
pnpm wrangler login
pnpm run deploy
```

`pnpm wrangler` runs the Wrangler version ID pins, from the repository root. The Worker, its database and its
queue are named `gateweave-id`, `gateweave-id` and `gateweave-id-logouts`. To use other names, change `name`,
`database_name` and both `queue` lines at the top of `wrangler.jsonc` before the first deploy.

The first deploy creates the database and the queue, generates `BETTER_AUTH_SECRET` (it is never shown), then
applies the migrations. Every later `pnpm run deploy` builds, applies new migrations, and only then deploys.

## Claim your server

**Until a server has an account, whoever reaches it first owns it.** So open it as soon as it is up, and go to
`/signup`.

With neither email nor GitHub set up, which is how a new deployment starts, the page offers to claim the server:
a name, an address and a password. Nothing checks the address, since the server cannot write to it, so use your
real one. With [GitHub set up](#sign-in-with-github) and no email, the page offers only GitHub, and your first
sign-in with it claims the server. With email on, you sign up with a code like anyone else, and the first to do
so is the owner.

## Who can get in

Sign-up closes behind the first account. Your account page then has a **This server** section, which opens
`/server`, a page only the owner can find:

- **Invite someone to this server.** With email on, they get an email. Without it, you get a link to pass on
  yourself. It works once, for 7 days.
- **Open sign-up**, if the server is meant for anyone. Anyone who finds it can then make an account and a
  workspace. Closing it again stops new accounts, and leaves the ones already made.

While sign-up is closed, only the owner makes workspaces, because a workspace's invitation is a way in. Those
the owner makes admins of a workspace can invite to it, and so let people in. A workspace you are not an admin
of, made while sign-up was open, cannot invite anyone until it opens again. Its admins cannot make you an admin
of it meanwhile, since that would let it invite. To become one, open sign-up first.

To hand the server to someone else, who needs an account already, run this from the repository root:

```sh
pnpm wrangler d1 execute DB --remote --command \
  "UPDATE deployment SET owner_id = (SELECT id FROM user WHERE email = 'someone@example.com') WHERE id = 1"
```

The owner's account cannot be deleted until someone else runs the server. The same statement gives a server an
owner if it has none. Until then nobody can reach `/server`, and sign-up stays as it was.

## Without email

ID works without email, with less. Compared with a server that sends it:

- **Nothing checks an address.** The owner's word stands in for it: whoever opens an invitation link gets an
  account with that address, so send links only to the person they are for.
- **Nobody can reset a forgotten password.** Someone with no passkey and no GitHub to sign in with stays locked
  out. All you can do is delete their account and invite them again, which loses what the account had. The
  database refuses while they alone own a workspace:

  ```sh
  pnpm wrangler d1 execute DB --remote --command "DELETE FROM user WHERE email = 'someone@example.com'"
  ```

- **A workspace's invitations are not sent.** They wait for the person under Workspaces, once they have an
  account here, which only the owner can give them. Tell them yourself.
- **GitHub does not reach an account that already has its address.** Nothing proved that address, so whoever
  opened a stray link could otherwise share the account of the person who later signs in with GitHub. The person
  signs in with the account's password or a passkey instead, and the sign-in page says so.

## Settings

Everything except `BETTER_AUTH_SECRET` is optional. Set them in the Cloudflare dashboard (Workers & Pages › your
Worker › Settings › Variables and Secrets) or from the repository root:

```sh
pnpm wrangler secret put BETTER_AUTH_URL
```

| Name                       | What it does                                                             |
| -------------------------- | ------------------------------------------------------------------------ |
| `BETTER_AUTH_SECRET`       | Signs sessions. Required.                                                |
| `BETTER_AUTH_URL`          | The address people use, such as `https://id.example.com`. See below.     |
| `OIDC_PAIRWISE_SECRET`     | With `BETTER_AUTH_URL`, turns on the OpenID Connect provider. See below. |
| `EMAIL_FROM`               | Turns on email, such as `Gateweave ID <id@example.com>`.                 |
| `GITHUB_CLIENT_ID`         | Turns on "Continue with GitHub", with `GITHUB_CLIENT_SECRET`.            |
| `GITHUB_CLIENT_SECRET`     | The client secret of the same GitHub OAuth App.                          |
| `TURNSTILE_SITE_KEY`       | Turns on Turnstile, with `TURNSTILE_SECRET_KEY`.                         |
| `TURNSTILE_SECRET_KEY`     | The secret key of the same widget.                                       |
| `CHECK_BREACHED_PASSWORDS` | `1` refuses passwords known from breaches.                               |
| `LEGAL_NOTICE_URL`         | The address of your legal notice. See below.                             |
| `PRIVACY_POLICY_URL`       | The address of your privacy policy.                                      |
| `TERMS_URL`                | The address of your terms.                                               |

### Your own domain

Do this first. In the dashboard, open the Worker and add a custom domain under Settings › Domains & Routes. Or
add `"routes": [{ "pattern": "id.example.com", "custom_domain": true }]` to `wrangler.jsonc`.

### Turning on the provider

Accounts and workspaces work without this. Apps cannot sign anyone in until it is on, and passkeys are off too,
because each passkey is bound to the address for good.

1. Set `BETTER_AUTH_URL` to the address. It becomes the issuer that apps compare, so it **cannot change** once
   any app has signed anyone in, and neither can the passkeys made on it.
2. Generate `OIDC_PAIRWISE_SECRET`, keep a copy in your password manager, then set it. It gives each app its own
   id for each person. Changing or losing it gives everybody a new id in every app, and secrets cannot be read
   back:

   ```sh
   openssl rand -base64 48
   pnpm wrangler secret put OIDC_PAIRWISE_SECRET
   ```

`https://id.example.com/.well-known/openid-configuration` then answers, with your address as the issuer.

### Connecting apps

An owner or admin of a workspace can add an app from its page, and only that workspace's members can use it.
[connect-an-app.md](connect-an-app.md) has the steps.

An app for everyone on the server is registered from the repository root instead, and nobody is asked about it
before they sign in. Its secret is printed once:

```sh
pnpm --filter @gateweave/id-web apps:add --app wiki --name "Team wiki" \
  --redirect-uri https://wiki.example.com/oidc/callback
```

Add `--client-auth client_secret_post` if the app's library sends its secret in the body of the request, and
`--no-pkce` if it cannot do PKCE, in which case the app has to send a nonce and check it.

Add `--backchannel-logout-uri` if the app has one, and signing out of ID then ends the session there. An app that
is down when that happens gets it again for about 20 hours.

If the app is a Worker too, give each a
[Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/#worker-to-worker-communication).
A Worker cannot reach another on its own zone through a route, and two on `workers.dev` cannot reach each other at
all. Gateweave Track's [self-hosting guide](https://github.com/gateweavehq/track/blob/main/docs/self-hosting.md#sign-in-through-an-openid-connect-provider)
has what to do on its side.

### Email

1. Onboard a domain to [Cloudflare Email Sending](https://developers.cloudflare.com/email-service/):
   `pnpm wrangler email sending enable example.com`.
2. Set `EMAIL_FROM` to a sender on that domain, such as `Gateweave ID <id@example.com>`.

ID then sends sign-up codes, password resets and invitations. The form that claims a server without a code goes
away.

Nothing proved the addresses of accounts made before this, and GitHub links to an account by its address once email
is on. If a link you sent may have reached the wrong person, delete that account before you turn email on.

### Sign in with GitHub

Create a [GitHub OAuth App](https://github.com/settings/developers) with the callback URL
`https://id.example.com/api/auth/callback/github` (your address), then set `GITHUB_CLIENT_ID` and
`GITHUB_CLIENT_SECRET`. The form that claims a server goes away here too, since GitHub can prove an address and
the form cannot.

### Turnstile

Set this on any server open to the internet. It stands in front of password sign-in, of sending email and of the
form that claims a server. GitHub does not pass through it, so on a server with GitHub and no account yet, the
first person to sign in with a verified address there owns it.

1. In the Cloudflare dashboard, add a [Turnstile](https://developers.cloudflare.com/turnstile/) widget for your
   hostname (Managed mode).
2. Set `TURNSTILE_SITE_KEY` to its site key and `TURNSTILE_SECRET_KEY` to its secret key, the second as a secret.

### Breached passwords

With `CHECK_BREACHED_PASSWORDS` set to `1`, ID refuses passwords known from breaches. It sends the first five
characters of a password's SHA-1 to Have I Been Pwned, so it is yours to choose.

### Your legal pages

ID comes with no legal notice, privacy policy or terms, and never links to Gateweave's: whoever runs a copy decides
what applies to it. Set any of the three addresses, and it is linked from the sign-in pages, the page that asks to
allow an app, and the account and workspace pages. With `TERMS_URL` set, the sign-in pages also say that continuing
means agreeing to them.

## Someone who is locked out

Someone who has lost their authenticator and their recovery codes, and has no passkey or GitHub to get in with, can
have two-factor sign-in turned off. Be sure who is asking first, since this is what stands between a stolen password
and their account:

```sh
pnpm --filter @gateweave/id-web two-factor:remove --email someone@example.com
```

## Backups

D1 keeps [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) for you, always on, for 30 days
on the Paid plan. To go back, which overwrites the database in place:

```sh
pnpm wrangler d1 time-travel restore DB --timestamp=<unix time>
```

To keep a copy elsewhere, `pnpm wrangler d1 export DB --remote --output=id.sql`. It holds password hashes and everyone's
addresses, so keep it as safe as the database.

## Updating

**Command line:** `git pull`, `pnpm install`, `pnpm run deploy`.

**Button:** your copy does not follow this repository on its own, and shares no history with it, so `git pull`
refuses. This takes the latest release into your copy instead, as one commit on top of it. A copy can skip releases,
however old it is:

```sh
git remote add upstream https://github.com/gateweavehq/id.git   # once
git fetch upstream
git show upstream/main:scripts/update-copy.mjs | node --input-type=module
git push
```

The script pushes nothing, and `git reset --hard HEAD~1` undoes it until you do. The push is what deploys: Workers
Builds builds it and applies the D1 migrations.

If GitHub refuses the push with `push declined due to email privacy restrictions`, the commit carries the address
your GitHub settings keep private. Use the `noreply` address those settings show you, and make the commit again:

```sh
git config user.email "<your noreply address>"
git commit --amend --reset-author --no-edit
git push
```

What your copy changed stays: the Worker's, database's and queue's names in `wrangler.jsonc`, the name in
`package.json`, and having no workflows. If something else you changed conflicts with the release, the script names
the files for you to fix before committing. To take a release other than the latest, end the third line with
`node --input-type=module - --to v1.2.3`.

ID is in early development. Read [CHANGELOG.md](../CHANGELOG.md) before updating, as some releases change how things
work.
