# Quickstart

Following this page on 27 November 2026 took about 3 minutes, from a fresh clone to Gateweave ID on
your own Cloudflare account, at a workers.dev address, deployed from the command line, with you as
its first account and owner, the OpenID Connect provider turned on and a first app registered, ready
to be connected as [connect-an-app.md](connect-an-app.md) describes. It started from an empty
package cache, and did not count installing the tools below or signing in to Cloudflare.

This is the shortest path: no custom domain and no email. You claim the server with a password, so
nothing here needs a passkey. The rest is in [self-hosting.md](self-hosting.md).

## What you need

- A Cloudflare account on the Workers Paid plan. The Free plan gives a request 10 ms of CPU, and checking
  a password takes about 100 ms; [self-hosting.md](self-hosting.md) has the numbers.
- [Git](https://git-scm.com/downloads).
- [Node.js](https://nodejs.org) 24, the version in `.node-version`, and [pnpm](https://pnpm.io/installation) 12.
- A browser, for signing in to Cloudflare and for claiming the server.
- Somewhere safe to keep two values, such as a password manager. Steps 7 and 10 make them.

## Steps

1. Get the code.

   ```sh
   git clone https://github.com/gateweavehq/id.git
   cd id
   ```

   <details>
   <summary>Expected output</summary>

   ```text
   Cloning into 'id'...
   ```

   </details>

2. Install the dependencies.

   ```sh
   pnpm install
   ```

   <details>
   <summary>Expected output</summary>

   ```text
   Scope: all … workspace projects
   ✓ Lockfile passes supply-chain policies ...
   Lockfile is up to date, resolution step is skipped
   Downloading @cloudflare/workerd-…: 0.00 B/… MB
   ...
   Progress: resolved …, reused 0, downloaded …, added …
   ...
   Packages: +…
   ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
   Progress: resolved …, reused 0, downloaded …, added …, done
   .../node_modules/workerd postinstall$ node install.js
   .../node_modules/esbuild postinstall$ node install.js
   ...
   .../node_modules/workerd postinstall: Done
   .../node_modules/esbuild postinstall: Done

   devDependencies:
   + @biomejs/biome …
   + typescript …

   Done in …s using pnpm v…
   ```

   This is what a machine with an empty package cache prints. pnpm downloads each package, which is
   the `Downloading` and `Progress` lines and the `downloaded` count, and runs the install scripts of
   `workerd` and `esbuild`. If the cache already holds them, `reused` is high and there is less to
   read. The counts, versions and times differ from release to release.

   </details>

3. Sign in to Cloudflare. Wrangler, the Cloudflare command-line tool, opens your browser; approve
   its request there.

   ```sh
   pnpm wrangler login
   ```

   <details>
   <summary>Expected output</summary>

   ```text
   Attempting to login via OAuth...
   Opening a link in your default browser: https://dash.cloudflare.com/oauth2/auth?...
   Successfully logged in.
   ```

   </details>

4. Deploy. If your Cloudflare login can reach more than one account, first run `pnpm wrangler whoami`
   to see them with their ids, then `export CLOUDFLARE_ACCOUNT_ID=<id>` (in PowerShell,
   `$env:CLOUDFLARE_ACCOUNT_ID = "<id>"`) for the one to deploy to. The deploy runs Wrangler where it
   cannot ask which.

   The Worker, the database and the queue are called `gateweave-id`, `gateweave-id` and
   `gateweave-id-logouts`, from `name`, `database_name` and the two `queue` lines at the top of
   `wrangler.jsonc`, before `"env"`. To use other names, change all four in one pass before this
   step. Leave the names under `env`: those are Gateweave's own deployments, and `gateweave-id`
   appears there too, so a find-and-replace over the whole file would change them. The Worker's name
   is also the first part of its address.

   **Choose unused names for all three resources before you deploy.** Check the Worker, D1 and
   Queue lists in the selected Cloudflare account. Deploying to an existing Worker can replace
   its code. If a D1 database already has the configured `database_name`, the deploy reuses it
   and applies pending ID migrations before checking the Worker name.

   To update an ID you already run, follow [Updating](self-hosting.md#updating) from its existing
   checkout. Keep its Worker name, database name and binding ID (if set), and queue name together.
   To retry a partial deployment from this guide, use the same checkout and names after you
   confirm that the resources under those names came from your earlier attempt.

   ```sh
   pnpm run deploy
   ```

   On a fresh installation, the deploy builds ID, creates the database and the queue, makes the
   secret that signs sessions (`BETTER_AUTH_SECRET`) and never shows it, and then applies the
   database migrations. Answer **yes** when Wrangler asks whether to continue with the migrations.
   If your account has no workers.dev subdomain yet, Wrangler offers to register one: say yes
   to that too. If the deploy stops with an error, read it and do what it says.

   <details>
   <summary>Expected output</summary>

   ```text
   $ pnpm --filter @gateweave/id-web run deploy
   $ node scripts/deploy.mjs
   (!) Your Vite config uses features that are unsupported by `configLoader: 'native'`, ...
   (!) Your Vite config uses features that are unsupported by `configLoader: 'native'`, ...
   (!) Your Vite config uses features that are unsupported by `configLoader: 'native'`, ...
   vite v… building client environment for production...
   ...
   ✓ built in …s
   vite v… building ssr environment for production...
   ...
   Using secrets defined in process.env
   ▲ [WARNING] Missing required secrets: BETTER_AUTH_SECRET. Add them to .dev.vars, .env, or set as environment variables.
   ...
   ✓ built in …s
    ⛅️ wrangler 4.… (update available 4.…)
   ───────────────────────────────────────────────
   Using redirected Wrangler configuration.
   ...
   Attaching additional modules:
   ┌──────────────────────────────┬──────┬────────────┐
   │ Name                         │ Type │ Size       │
   ├──────────────────────────────┼──────┼────────────┤
   │ assets/account-….js          │ esm  │ … KiB      │
   ├──────────────────────────────┼──────┼────────────┤
   │ ...                          │      │            │
   └──────────────────────────────┴──────┴────────────┘
   Total Upload: … KiB / gzip: … KiB
   The following bindings need to be provisioned:
   Binding             Resource
   env.LOGOUTS         Queue
   env.DB              D1 Database

   Provisioning DB (D1 Database)...
   Resource name found in config: gateweave-id
   🌀 Creating new D1 Database "gateweave-id"...
   ✨ DB provisioned 🎉

   Provisioning LOGOUTS (Queue)...
   Resource name found in config: gateweave-id-logouts
   🌀 Creating new Queue "gateweave-id-logouts"...
   ✨ LOGOUTS provisioned 🎉

   🎉 Resources provisioned, continuing with deployment...
   Durable Object exports reconciliation:
     Created: RateLimiter
   Worker Startup Time: … ms
   Your Worker has access to the following bindings:
   Binding                                        Resource
   env.RATE_LIMITER (RateLimiter)                 Durable Object
   env.EMAIL (unrestricted)                       Send Email
   env.LOGOUTS (gateweave-id-logouts)             Queue
   env.DB (gateweave-id)                          D1 Database
   env.BETTER_AUTH_SECRET ("(hidden)")            Environment Variable
   Uploaded gateweave-id (… sec)
   Deployed gateweave-id triggers (… sec)
     https://gateweave-id.<your-subdomain>.workers.dev
     schedule: */5 * * * *
     schedule: 17 3 * * *
     Producer for gateweave-id-logouts
     Consumer for gateweave-id-logouts
   Current Version ID: …
    ⛅️ wrangler 4.… (update available 4.…)
   ───────────────────────────────────────────────
   Resource location: remote
   Migrations to be applied:
   ┌───────────────────────────────────┐
   │ name                              │
   │ 0000_….sql                        │
   │ ...                               │
   └───────────────────────────────────┘
   ? About to apply … migration(s)
   Your database may not be available to serve requests during the migration, continue?
   ```

   At that question, answer **yes**: press Enter, or type `y` and Enter. Where nothing can answer,
   as when a script has closed the input, Wrangler prints
   `🤖 Using fallback value in non-interactive context: yes` and goes on. Then it applies the
   migrations, with a table of their names and a status each:

   ```text
   🌀 Executing on remote database DB (…):
   ...
   ┌───────────────────────────────────┬────────┐
   │ name                              │ status │
   │ 0000_….sql                        │ ✅     │
   │ ...                               │ ✅     │
   └───────────────────────────────────┴────────┘
   ```

   The table prints more than once, and the last one has a tick on every line.

   Vite prints its yellow notice about its config, and Wrangler's banner may say that an update is
   available: both can be ignored. ID pins the Wrangler it was checked with, so don't update it. The
   build also warns that `BETTER_AUTH_SECRET` is missing, which can be ignored too: it runs before
   the deploy makes that secret. The deploy makes it right after the build, and never prints it.
   Look for `env.BETTER_AUTH_SECRET ("(hidden)")` in the list of bindings. The address on the line
   after `Deployed` is yours, and the next steps call it your address. The versions, sizes, counts
   and times differ from what is shown. The deploy takes a minute or two, most of it the build and
   the upload.

   </details>

5. Claim the server. Open your address followed by `/signup` in your browser. Enter a name, an
   email address and a password of at least 8 characters twice, then choose **Claim this server**.
   The server sends no email and nothing checks the address, so type one that is yours. It is what
   you sign in with, and apps get it as your verified email.

   **Until a server has an account, whoever reaches it first owns it.** Do this step before you
   share the address. Sign-up closes behind the first account, so after it only people you invite
   can make one: see [Who can get in](self-hosting.md#who-can-get-in).

   If `/signup` shows **Create your account** instead of **Claim this server**, the server already
   has an account. If you claimed it on an earlier attempt, sign in at `/login` and continue.
   Otherwise, check that you opened the address from step 4. If it matches, stop and deploy again
   under three unused names.

   <details>
   <summary>Expected output</summary>

   Before you submit, the tab is titled **Create your account · Gateweave ID** and the page's
   heading is **Claim this server**. It says "It has no accounts yet. The first one owns it, and
   decides who else can join. This server does not send email, so nothing checks the address: use
   your real one." The fields are **Name**, **Email**, **Password** and **Repeat it**.

   You are signed in at once, and the page that opens is `/server`, in a tab titled **This server ·
   Gateweave ID**. Under **Who can make an account** it says "Only people you invite can make an
   account here. Only you can make workspaces. Opening sign-up takes email or GitHub, to prove an
   address with, and this server has neither. The list below has no effect until one of them is set
   up."

   </details>

6. Tell the server its address. If you are resuming a setup, check **Variables and Secrets** for
   your Worker in the Cloudflare dashboard. If it already has a `BETTER_AUTH_URL`, keep it and skip
   this step: changing it breaks the issuer apps compare and every passkey. Otherwise run this and paste
   your address, such as `https://gateweave-id.<your-subdomain>.workers.dev`, with nothing after the
   `.dev`, when Wrangler asks `Enter a secret value:`.

   ```sh
   pnpm wrangler secret put BETTER_AUTH_URL
   ```

   **This address is permanent.** Once it is set, it is the issuer that apps compare and the address
   every passkey is bound to, and neither can move: choosing your own domain later means starting
   again with it. If you will move to one, do that first, as
   [Your own domain](self-hosting.md#your-own-domain) and
   [Turning on the provider](self-hosting.md#turning-on-the-provider) say.

   <details>
   <summary>Expected output</summary>

   ```text
   $ pnpm --filter @gateweave/id-web exec wrangler --cwd ../.. "secret" "put" "BETTER_AUTH_URL"

    ⛅️ wrangler 4.… (update available 4.…)
   ───────────────────────────────────────────────
   ▲ [WARNING] Multiple environments are defined in the Wrangler configuration file, but no target environment was specified for the secret put command.
   ...
   ? Enter a secret value: ›
   🌀 Creating the secret for the Worker "gateweave-id"
   ✨ Success! Uploaded secret BETTER_AUTH_URL
   ```

   Wrangler waits at the `Enter a secret value:` line. Paste the value and press Enter. Nothing
   shows as you paste: that is on purpose, since it is a secret. If the value comes from a pipe,
   Wrangler reads it without asking.

   The warning is about Gateweave's own `env` blocks in `wrangler.jsonc`; the secret goes to the
   Worker you deployed. Setting the address also signs you out in the browser, because the session
   cookie changes name. The later steps don't need the browser. Sign in again at `/login` with the
   email and password you chose whenever you next need the server.

   </details>

7. Check **Variables and Secrets** for `OIDC_PAIRWISE_SECRET` if you are resuming a setup. If the
   Worker already has it, keep it and skip steps 7 and 8: setting it
   again gives everybody a new id in every app. Otherwise generate `OIDC_PAIRWISE_SECRET` and **keep a copy of it** in your password manager before you go
   on. It gives each app its own id for each person, so without your copy you cannot set it again
   after a mistake, and changing or losing it gives everybody a new id in every app. Wrangler cannot
   read a secret back.

   ```sh
   node -e "console.log(require('crypto').randomBytes(36).toString('base64'))"
   ```

   <details>
   <summary>Expected output</summary>

   ```text
   Qm7vXk2LrT9aWc4YhN1sBpEzJf8dUo3GyKtA6iHxMnVbDe5R
   ```

   A line of 48 letters, digits, `+` and `/`. Yours is different.

   </details>

8. Set it. Paste the line from the last step when Wrangler asks `Enter a secret value:`.

   ```sh
   pnpm wrangler secret put OIDC_PAIRWISE_SECRET
   ```

   <details>
   <summary>Expected output</summary>

   ```text
   $ pnpm --filter @gateweave/id-web exec wrangler --cwd ../.. "secret" "put" "OIDC_PAIRWISE_SECRET"

    ⛅️ wrangler 4.… (update available 4.…)
   ───────────────────────────────────────────────
   ▲ [WARNING] Multiple environments are defined in the Wrangler configuration file, but no target environment was specified for the secret put command.
   ...
   ? Enter a secret value: ›
   🌀 Creating the secret for the Worker "gateweave-id"
   ✨ Success! Uploaded secret OIDC_PAIRWISE_SECRET
   ```

   As in step 6, nothing shows as you paste.

   </details>

9. Check that the provider answers. Replace the example address with the origin you set in step 6,
   or the origin of the existing `BETTER_AUTH_URL` if you kept it. That can be a custom domain.
   If you are resuming and do not know the configured origin, try the Worker's address from
   step 4 and read the `issuer` from the response. You can also open the discovery URL in your
   browser. In Windows PowerShell, use `curl.exe`.

   ```sh
   curl https://gateweave-id.<your-subdomain>.workers.dev/.well-known/openid-configuration
   ```

   <details>
   <summary>Expected output</summary>

   ```text
   {"scopes_supported":["openid","profile","email","offline_access","groups"],"issuer":"https://gateweave-id.<your-subdomain>.workers.dev","authorization_endpoint":"https://gateweave-id.<your-subdomain>.workers.dev/api/auth/oauth2/authorize", ...
   ```

   One line of JSON that carries the configured origin as the `issuer`. Keep that exact value for
   step 10. "Not found" means the provider is still off, which it is until both `BETTER_AUTH_URL` and
   `OIDC_PAIRWISE_SECRET` are set. Wait a few seconds after step 8 and try again, and if it stays,
   check that steps 6 and 8 each ended with `Success!`.

   </details>

10. Register your first app. Use your app's own callback address in place of the example, since the
    host of the first one sets the ids people get in that app and an app keeps it for good. The
    command prints the app's **client secret once**: **keep a copy** of it with the client id. Only
    its hash is stored, so nothing can show it again, and an app without it cannot sign anyone in.

    ```sh
    pnpm --filter @gateweave/id-web apps:add --app my-app --name "My app" --redirect-uri https://app.example.com/callback
    ```

    <details>
    <summary>Expected output</summary>

    ```text
    $ node scripts/add-app.ts …
    ▲ [WARNING] ⚠️ This process may take some time, during which your D1 database will be unavailable to serve queries.

    Registered My app. The secret is shown this once, and only its hash is kept.
    client id:     <32 characters>
    client secret: gwid_cs_…
    ```

    The client id is 32 characters, and the secret starts with `gwid_cs_`: both are different each
    time. Give your app the exact `issuer` from the discovery document in step 9. See
    [connect-an-app.md](connect-an-app.md) for its other settings. An app registered this way
    is first-party: nobody is asked before it signs them in. Admins of a workspace can add apps of
    their own from its page instead, which only that workspace's members can use. If the command
    stops with an error, read it and do what it says.

    </details>

## Next

- [connect-an-app.md](connect-an-app.md): put the issuer, client id and secret into your app, with
  the scopes, the client authentication and the PKCE it takes.
- [self-hosting.md](self-hosting.md): your own domain, email, GitHub sign-in, Turnstile, who may sign
  up, updating and backups.
