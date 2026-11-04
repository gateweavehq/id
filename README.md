<h1 align="center">Gateweave ID</h1>

An OpenID Connect provider that runs entirely on Cloudflare, with no server to run: one Worker, one
D1 database and a Durable Object for rate limits. It is meant to let people hold one account and
sign in to any app that supports OIDC.

Gateweave ID is part of [Gateweave](https://gateweave.com), the family of open-source business tools
that run on Cloudflare, next to [Gateweave Track](https://github.com/gateweavehq/track) and
[Gateweave Agents](https://github.com/gateweavehq/agents).

> **Status: early, and not usable yet.** What works today is accounts (sign up with a code sent to
> your email, sign in with a password, GitHub or a passkey, reset a password, see an account page) and
> tokens for first-party apps that a deployment registers itself. It has no workspaces, and nobody can
> register an app of their own. Do not put anything that matters behind it.
> [docs/architecture.md](docs/architecture.md) describes what it is being built to be, including
> what is decided and what is still unproven.

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

## License

[AGPL-3.0](LICENSE). Contributors sign a [CLA](CLA.md) once, which covers every Gateweave project.
Third-party code is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Report security
problems as [SECURITY.md](SECURITY.md) describes.
