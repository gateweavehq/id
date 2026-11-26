# Quickstart

About N minutes from a fresh clone gets you Gateweave ID on your own Cloudflare account, at a
workers.dev address, deployed from the command line, with you as its first account and owner, the
OpenID Connect provider turned on and a first app registered, ready to be connected as
[connect-an-app.md](connect-an-app.md) describes.

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
   Packages: +388
   ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
   Progress: resolved 388, reused 0, downloaded 387, added 388, done

   devDependencies:
   + @biomejs/biome 2.6.8
   + typescript 7.0.2

   Done in 17.3s using pnpm v12.4.2
   ```

   On a machine that has never installed these packages, pnpm downloads them, which is the
   `downloaded` count. The counts differ a little from release to release.

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

   ```sh
   pnpm run deploy
   ```

   Nothing needs setting first. The deploy builds ID, creates the database and the queue, makes the
   secret that signs sessions (`BETTER_AUTH_SECRET`) and never shows it, and then applies the
   database migrations. Answer **yes** when Wrangler asks whether to continue with the migrations.
   If your account has no workers.dev subdomain yet, Wrangler offers to register one: say yes
   to that too.

   The Worker, the database and the queue are called `gateweave-id`, `gateweave-id` and
   `gateweave-id-logouts`, from `name`, `database_name` and the two `queue` lines at the top of
   `wrangler.jsonc`. To use other names, change those four before this step, and leave the `env`
   blocks further down, which are Gateweave's own deployments. The Worker's name is also the first
   part of its address. An earlier ID under these names is updated in place: the deploy keeps its
   secrets and applies the migrations to its database. A different Worker under the name, one with
   no `BETTER_AUTH_SECRET`, or a queue that another Worker already consumes, makes the deploy fail,
   since a queue has one consumer. Choose unused names to keep a new ID apart from either.

   <details>
   <summary>Expected output</summary>

   ```text
   $ node scripts/deploy.mjs
   (!) Your Vite config uses features that are unsupported by `configLoader: 'native'`, ...
   vite v8.3.8 building client environment for production...
   ✓ built in 3s
   vite v8.3.8 building ssr environment for production...
   ✓ built in 19s
   ...
   WARNING  Missing required secrets: BETTER_AUTH_SECRET. Add them to .dev.vars, .env, or set as environment variables.
   ...
   ⛅️ wrangler 4.166.0
   ...
   Total Upload: 4304.01 KiB / gzip: 961.73 KiB
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
   Worker Startup Time: 51 ms
   Your Worker has access to the following bindings:
   Binding                                        Resource
   env.RATE_LIMITER (RateLimiter)                 Durable Object
   env.EMAIL (unrestricted)                       Send Email
   env.LOGOUTS (gateweave-id-logouts)             Queue
   env.DB (gateweave-id)                          D1 Database
   env.BETTER_AUTH_SECRET ("(hidden)")            Environment Variable
   Uploaded gateweave-id (17.55 sec)
   Deployed gateweave-id triggers (4.07 sec)
     https://gateweave-id.<your-subdomain>.workers.dev
     schedule: */5 * * * *
     schedule: 17 3 * * *
     Producer for gateweave-id-logouts
     Consumer for gateweave-id-logouts
   Current Version ID: 0f3c1a52-7d4e-4b8a-9c61-2e5b8d7a1f34
   ...
   ? About to apply 22 migration(s)
   Your database may not be available to serve requests during the migration, continue?
   ...
   │ 0021_robust_misty_knight.sql      │ ✅     │
   ```

   Vite may print its yellow notice about its config, and the build may warn that
   `BETTER_AUTH_SECRET` is missing: both can be ignored, since the deploy makes that secret next.
   The address on the line after `Deployed` is yours, and the next steps call it your address. The
   migration table lists every migration with a tick; the last one is shown above. The deploy takes
   about a minute, most of it the build and the upload.

   </details>

5. Claim the server. Open your address followed by `/signup` in your browser. Enter a name, an
   email address and a password of at least 8 characters twice, then choose **Claim this server**.
   The server sends no email, so nothing checks the address.

   **Until a server has an account, whoever reaches it first owns it.** Do this step before you
   share the address. Sign-up closes behind the first account, so after it only people you invite
   can make one: see [Who can get in](self-hosting.md#who-can-get-in).

   <details>
   <summary>Expected output</summary>

   The page before you submit is titled **Claim this server**, with the fields **Name**, **Email**,
   **Password** and **Repeat it**. You are signed in at once, and the page that opens is titled
   **This server**. Under **Who can make an account** it says "Only people you invite can make an
   account here. Only you can make workspaces." and goes on to say that opening sign-up takes
   email or GitHub, which this server has neither of.

   </details>

6. Tell the server its address. If this server already has a `BETTER_AUTH_URL`, keep it and skip this
   step: changing it breaks the issuer apps compare and every passkey. Otherwise run this and paste
   your address, such as `https://gateweave-id.<your-subdomain>.workers.dev`, with nothing after the
   `.dev`, when Wrangler asks for the value.

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
   WARNING  Multiple environments are defined in the Wrangler configuration file, but no target environment was specified for the secret put command.
   ...
   🌀 Creating the secret for the Worker "gateweave-id"
   ✨ Success! Uploaded secret BETTER_AUTH_URL
   ```

   The warning is about Gateweave's own `env` blocks in `wrangler.jsonc`; the secret goes to the
   Worker you deployed. Setting the address also signs you out in the browser, because the session
   cookie changes name. The later steps don't need the browser. Sign in again at `/login` with the
   email and password you chose whenever you next need the server.

   </details>

7. If this server already has an `OIDC_PAIRWISE_SECRET`, keep it and skip steps 7 and 8: setting it
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

8. Set it. Paste the line from the last step when Wrangler asks for the value.

   ```sh
   pnpm wrangler secret put OIDC_PAIRWISE_SECRET
   ```

   <details>
   <summary>Expected output</summary>

   ```text
   WARNING  Multiple environments are defined in the Wrangler configuration file, but no target environment was specified for the secret put command.
   ...
   🌀 Creating the secret for the Worker "gateweave-id"
   ✨ Success! Uploaded secret OIDC_PAIRWISE_SECRET
   ```

   </details>

9. Check that the provider answers. Replace the address with yours, or open it in your browser.

   ```sh
   curl https://gateweave-id.<your-subdomain>.workers.dev/.well-known/openid-configuration
   ```

   <details>
   <summary>Expected output</summary>

   ```text
   {"scopes_supported":["openid","profile","email","offline_access","groups"],"issuer":"https://gateweave-id.<your-subdomain>.workers.dev","authorization_endpoint":"https://gateweave-id.<your-subdomain>.workers.dev/api/auth/oauth2/authorize", ...
   ```

   One line of JSON that carries your address as the `issuer`. Until both values are set, the same
   address answers "Not found"; if you still see that a few seconds after step 8, try again.

   </details>

10. Register your first app. Use your app's own callback address in place of the example, since the
    host of the first one sets the ids people get in that app and an app keeps it for good. The
    command prints the app's **client secret once**: **keep a copy** of it with the client id. Only
    its hash is stored, so nothing can show it again, and an app without it cannot sign anyone in.

    ```sh
    pnpm --filter @gateweave/id-web apps:add --app my-app --name "My app" \
      --redirect-uri https://app.example.com/callback
    ```

    <details>
    <summary>Expected output</summary>

    ```text
    WARNING  This process may take some time, during which your D1 database will be unavailable to serve queries.

    Registered My app. The secret is shown this once, and only its hash is kept.
    client id:     k3Vx9QmT7wLpZ2aHnR8cYdE5uJbF1sGo
    client secret: gwid_cs_Zr4vNq8TxK2mBw7LcYh3JdPs9AeUf6GtR1oVi5XnMkE
    ```

    The ids are made up here. The issuer to give your app is your address, and
    [connect-an-app.md](connect-an-app.md) has the rest of its settings. An app registered this way
    is first-party: nobody is asked before it signs them in. Admins of a workspace can add apps of
    their own from its page instead, which only that workspace's members can use.

    </details>

## Next

- [connect-an-app.md](connect-an-app.md): put the issuer, client id and secret into your app, with
  the scopes, the client authentication and the PKCE it takes.
- [self-hosting.md](self-hosting.md): your own domain, email, GitHub sign-in, Turnstile, who may sign
  up, updating and backups.
