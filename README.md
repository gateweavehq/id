<p align="center">
  <img src=".github/logo.svg" width="96" height="96" alt="">
</p>

<h1 align="center">Gateweave ID</h1>

An OpenID Connect provider that runs entirely on Cloudflare, with no server to run: one Worker, one
D1 database, a Durable Object for rate limits and a Queue for logouts an app missed. It is meant to
let people hold one account and sign in to any app that supports OIDC.

Gateweave ID is part of [Gateweave](https://gateweave.com), the family of open-source business tools
that run on Cloudflare, next to [Gateweave Track](https://github.com/gateweavehq/track) and
[Gateweave Agents](https://github.com/gateweavehq/agents).

> **Status: early.** It is not certified. The OpenID conformance suite's Basic OP and Config OP plans
> pass, and [docs/conformance.md](docs/conformance.md) says what differs and why, so check that it does
> what you need before you rely on it. [docs/architecture.md](docs/architecture.md) describes what it is
> being built to be, including what is decided and what is still unproven.

## What works today

- **Accounts.** Sign up with a code sent to your email, sign in with a password, GitHub or a passkey,
  reset a password, and see an account page with its recent activity.
- **First-party apps.** Tokens for apps that a deployment registers itself. Gateweave's own products
  sign in through it, next to their own sign-in. When someone signs out of ID, an app that gave a
  back-channel logout address is told, and a logout it missed is tried again from a queue for about 20
  hours.
- **Workspaces.** People can make workspaces, invite each other and
  [connect their own apps](docs/connect-an-app.md), which only that workspace's members can use. Groups
  decide who in a workspace may sign in to which app, and an app can ask for them as a `groups` claim.
  These apps do not hear about a sign-out yet. One of them can be
  [Cloudflare Access](docs/cloudflare-access.md), which puts an internal app behind ID through a tunnel,
  with no server of your own to run.
- **Your own server.** The first account owns it. Sign-up stays closed until you open it, and while it
  is closed only people who are invited get in. It also runs without email, with less.

## Tech stack

[TanStack Start](https://tanstack.com/start) · React 19 · Tailwind CSS 4 ·
[Better Auth](https://better-auth.com) · [Drizzle ORM](https://orm.drizzle.team) ·
Cloudflare Workers, Durable Objects and D1 · TypeScript 7 · Vitest · Biome

## Running it locally

Requirements: Node.js 24 (22+ works) and pnpm 12.

```sh
pnpm install
pnpm doctor      # checks your toolchain and setup, and explains how to fix anything missing
pnpm dev:setup   # creates .dev.vars with a random secret, migrates the local database
pnpm dev         # http://localhost:4730
```

Sign up at `/signup`. Signing up takes a code sent by email, so `pnpm dev:setup` turns email on.
Nothing is sent locally: each email is saved as a file under `apps/web/.wrangler/tmp/email`, and the
terminal that runs `pnpm dev` prints its path. The code is in the `.txt` file.

To enable "Continue with GitHub", [create an OAuth App](https://github.com/settings/applications/new)
with the callback URL `http://localhost:4730/api/auth/callback/github`, then uncomment and fill in
`GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in `.dev.vars`.

`pnpm verify` runs everything CI does: lint, types, tests and a build. See
[CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) for how the code is organized and
what must never break.

## Running your own

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/gateweavehq/id)

[docs/self-hosting.md](docs/self-hosting.md) has the steps and every setting, including what you give
up without email. The first account owns a new server and sign-up closes behind it, so claim yours as
soon as it is up.

## License

[AGPL-3.0](LICENSE). Contributors sign a [CLA](CLA.md) once, which covers every Gateweave project.
Third-party code is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Report security
problems as [SECURITY.md](SECURITY.md) describes.
