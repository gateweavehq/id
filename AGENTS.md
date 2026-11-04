# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository. It is the single source
of truth for how the project is built; `CLAUDE.md` and other tool-specific files only add to it.

## The project

Gateweave ID is an OpenID Connect provider that runs entirely on Cloudflare, with no server to run:
one Worker, one D1 database and a Durable Object for rate limits. It is part of
[Gateweave](https://gateweave.com), next to [Gateweave Track](https://github.com/gateweavehq/track)
and [Gateweave Agents](https://github.com/gateweavehq/agents), which will sign people in with it.

It is early. Today it has accounts (sign-up, email verification, sign-in, passkeys, two-factor,
password reset and an account page), the OIDC provider, for first-party apps a deployment registers
itself, and workspaces with members and invitations. Groups and workspace apps come in later issues.

Read [docs/architecture.md](docs/architecture.md) before changing sign-in, tokens or who may use an
app. A mistake in those places signs the wrong person in to someone else's app.

## Repository map

| Path              | What lives there                                                          |
| ----------------- | ------------------------------------------------------------------------- |
| `apps/web`        | The Worker: TanStack Start UI, Better Auth, rate limiting, email, D1      |
| `docs/`           | The architecture notes, including the values that may never change        |
| `scripts/`        | Repository tooling (`doctor`)                                             |
| `.claude/skills/` | Step-by-step playbooks for recurring tasks (plain Markdown, any agent)    |
| `wrangler.jsonc`  | The Worker's config, at the root because the Deploy button reads it there |

There is no sync engine and no per-workspace Durable Object: identity data is relational, read at
sign-in and written rarely, so it lives in D1. The Durable Object only counts rate limits.

Wrangler commands that use the build output (`deploy`, `versions upload`, `preview`) must run
from the repository root, where the build leaves its pointer next to `wrangler.jsonc`. Use
`pnpm wrangler …`, which does that.

## Commands

Requirements: Node.js 24 (see `.node-version`; 22+ works) and pnpm 12. Run from the repository
root unless noted.

| Command           | Purpose                                                                      |
| ----------------- | ---------------------------------------------------------------------------- |
| `pnpm install`    | Install dependencies                                                         |
| `pnpm doctor`     | Check the local toolchain and setup, with fixes for anything missing         |
| `pnpm dev:setup`  | One-time: create `.dev.vars` and migrate the local D1 database               |
| `pnpm dev`        | Run the app on http://localhost:4730 (Workers, D1 and Durable Objects local) |
| `pnpm check`      | Biome lint and format check (`pnpm format` fixes most findings)              |
| `pnpm typecheck`  | Type-check every package (regenerates Wrangler and route types first)        |
| `pnpm test`       | Run every test suite                                                         |
| `pnpm test:e2e`   | Build, then run the browser tests (Playwright, Chromium) on port 4732        |
| `pnpm build`      | Production build                                                             |
| `pnpm verify`     | Everything CI runs: check, typecheck, test, build                            |
| `pnpm run deploy` | Build, apply D1 migrations, deploy                                           |
| `pnpm wrangler`   | The pinned Wrangler, run from the repository root                            |

Gateweave's own deployments are the `staging` and `cloud` environments in `wrangler.jsonc`:
`pnpm --filter @gateweave/id-web deploy:staging` and `db:migrate:staging` for staging; production
deploys from a published release (`.github/workflows/deploy.yml`).

A deployment registers its first-party apps with `pnpm --filter @gateweave/id-web apps:add`; see
"Registering an app" in [docs/architecture.md](docs/architecture.md). `two-factor:remove` turns two-factor
sign-in off for someone who has lost every other way in; see "Two-factor sign-in" there.

Scope a command to one package with `pnpm --filter <name> <script>`, for example
`pnpm --filter @gateweave/id-web test`. Run `pnpm verify` before you consider a change done.

Gateweave's products use ports in the 47xx range locally: Track 4710, Agents 4720, ID 4730 (preview
4731). Never use a port from another product's block, or one in the 3000s.

## Invariants

These are load-bearing. Breaking one breaks users' data or security, usually silently.

1. **The check for who may sign in fails closed.** When it cannot name the app or the person, it
   refuses. Its tests always include someone who is refused: a version of it once let everyone
   through while every test for permitted people still passed.
2. **No account exists with an unverified address.** Apps and Cloudflare Access trust the `email`
   claim. An address is proven before its account exists, and a password comes only after that, so
   nobody can prepare an account on someone else's address. A sign-up code never opens an account that
   already exists. See "Sign-up" in [docs/architecture.md](docs/architecture.md).
3. **The permanent values change only by a deliberate, documented decision.** The issuer, the signing
   algorithm, pairwise subjects and their secret, token prefixes and the passkey `rpID` are in
   [docs/architecture.md](docs/architecture.md). Changing one signs everybody out of every app or
   breaks every integration. Record the decision there in the same pull request.
4. **A deployed Worker cannot fetch its own hostname.** Server code never fetches its own URL; it
   calls the code directly. The Worker tests fail every outbound request to catch this.
5. **Server code never reaches the browser bundle.** In server functions, import server modules
   dynamically inside the handler, as `apps/web/src/lib/session.ts` does.
6. **Migrations are append-only.** Generate them with Drizzle Kit and commit them. Never edit a
   migration that has been merged. When another branch's migration lands first, regenerate yours
   after it rather than renaming it. Follow `.claude/skills/schema-change/SKILL.md`.
7. **Secrets stay local.** Never commit `.dev.vars` or print its contents.
8. **Admin rights are granted, never assumed.** Never decide what only owners and admins may do by
   comparing a role with `member`; ask what the role is allowed (`can` in `apps/web/src/lib/workspace.ts`).
9. **The organization plugin is reached only through the gate.** Every path under `/organization/` needs
   a rule in `apps/web/src/server/auth/workspaces.ts`, with a strict body, or it answers 404. To someone
   outside a workspace, it does not exist. See "Workspaces" in [docs/architecture.md](docs/architecture.md).

Also: one Better Auth instance per isolate, built on first use (`getAuth()`). workerd forbids I/O in
global scope, and `test/startup-logs.test.ts` fails if a cold start logs an error.

## Code shared with Agents and Track

Auth, rate limiting, email, the Worker test harness and the UI primitives were copied from
[gateweavehq/agents](https://github.com/gateweavehq/agents) at `9644177` (v0.11.0), which took them
from Track, and are owned here now, the way shadcn/ui components are. When you fix a bug in one of
them, check whether the others have the same bug, especially in auth and rate limiting.

## Code style

- TypeScript is strict, with `noUncheckedIndexedAccess`. Avoid `any` and non-null assertions.
- Biome formats: tabs, 100 columns, double quotes. Don't hand-format; run `pnpm format`.
- Validate untrusted input at the boundary with zod. Inside, trust the types.
- Prefer `#private` fields, named exports and small modules. Default exports only where a
  framework requires them.
- Comments explain why, not what. Match the tone and density of the file you are editing.
- Generated files are not edited by hand: `routeTree.gen.ts`, `worker-configuration.d.ts`,
  `apps/web/src/server/db/auth-schema.ts` (`pnpm --filter @gateweave/id-web auth:schema`), and
  everything under `apps/web/migrations/`.
- Dependencies are pinned to exact versions. Shared ones go in the `catalog:` of
  `pnpm-workspace.yaml`. `drizzle-orm` stays on 0.45: the 1.0 migration format does not work
  with Wrangler's D1 migrations. `patches/` holds one fix to `@better-auth/oauth-provider`, which
  an upgrade has to look at again (see "A patched dependency" in the architecture notes).
- UI code copied into the repository (components, blocks, hooks) must come from an MIT or
  Apache-2.0 source, such as shadcn/ui, Magic UI or SmoothUI. Note the source and keep its
  copyright notice in a comment at the top of the file, and in `THIRD_PARTY_NOTICES.md`. Paid or
  restricted kits (Aceternity UI, shadcn.io blocks, shadcnstudio Pro) cannot ship in an AGPL
  repository.

## Testing

- Test behavior through public APIs, not internals.
- `apps/web` has unit tests in `src/` and `scripts/`, and Worker tests in `test/`. The Worker tests
  build the app and run it in workerd through Miniflare, with every outbound request failing as a
  deployed Worker's request to its own hostname does; see `test/id-worker.ts`. Email lands in an
  outbox the tests read. Give each person in a test a `cf-connecting-ip` of their own, or the rate
  limits will stop them.
- `apps/web/e2e` has browser tests: Playwright drives Chromium against the production build, its
  own empty local database and port 4732. They cover what the other suites cannot: a page's Content
  Security Policy, because a blocked script leaves the same HTML. Every page they visit fails on a
  policy violation. `pnpm test:e2e` builds and runs them; the first time, run
  `pnpm --filter @gateweave/id-web exec playwright install chromium`. They are not part of
  `pnpm verify`; CI runs them as the `e2e` job. A preview reads only the required secrets from
  `.dev.vars`, so `e2e/build.mjs` turns email and the provider on for these tests. `e2e/server.mjs`
  seeds what tests cannot make themselves (`e2e/fixtures.ts`), and answers for the app they play on
  port 4733, because `page.route` does not see where a redirect leads. Sign-up codes land in local
  files that name the address in their text, so tests can wait for their own side by side.
  `e2e/authenticator.ts` gives a page Chromium's virtual authenticator. It answers the offer under
  the email field by itself, so once it holds a passkey, signing out signs that person back in.
  Say `withoutTheOfferInTheEmailField` first in any test that is about something else.
- Every bug fix gets a test that fails without the fix. Never weaken or skip a test to make a
  change pass.

## Git and pull requests

- `main` is protected: changes land through pull requests with a green `check`, squash or rebase
  merged. Branch from `main` as `feat/…`, `fix/…`, `docs/…` or `chore/…`.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org), with a
  scope when it helps: `fix(auth): refuse a person removed from the workspace`. Explain why in the
  body.
- Commits, pull requests, comments and release notes carry no AI attribution: no
  `Co-authored-by` trailer naming an AI, no "Generated with" line and no session link. If your
  tool adds them, take them out before you push, and out of the message of a squash merge,
  which GitHub fills from the commits. History already merged stays as it is.
- Fill in the pull request template. A CLA bot asks first-time contributors to sign once.
- Follow `.claude/skills/open-pull-request/SKILL.md` for the full flow.
- Pull requests leave `CHANGELOG.md` alone, so parallel branches do not conflict there. A
  maintainer adds each version's entry when releasing: merge it to `main`, then publish a GitHub
  release of that commit with the same notes. Publishing deploys Gateweave Cloud's production.

## Playbooks

Each folder in `.claude/skills/` holds a `SKILL.md` for a recurring task. They are plain Markdown,
so any agent can follow them:

| Skill               | Use it to                                                  |
| ------------------- | ---------------------------------------------------------- |
| `schema-change`     | Change the D1 schema with a migration                      |
| `run-locally`       | Start the app and check a change in a real browser         |
| `open-pull-request` | Take a change from a branch to a merged-ready pull request |
