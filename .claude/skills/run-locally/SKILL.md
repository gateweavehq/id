---

name: run-locally
description: Start Gateweave ID locally (Workers, D1 and Durable Objects via Vite) and check a change in a real browser - sign up, verify the address, sign in, and see the account page. Use for UI changes and for confirming a flow end to end.
---

# Run Gateweave ID locally and check a change

## Start

```sh
pnpm doctor       # toolchain, setup and port check, with fixes
pnpm dev:setup    # first time only: .dev.vars + local D1 migrations
pnpm dev          # http://localhost:4730
```

- Gateweave products use 47xx ports (site 4700, Track 4710, Agents 4720, ID 4730), and `pnpm dev`
  fails instead of moving when 4730 is taken. Check whether an ID dev server is already running
  and reuse it. Otherwise pick another port outside the other products' blocks:
  `pnpm --filter @gateweave/id-web exec vite dev --port 4732 --strictPort`.
- Don't run two dev servers at once. They would share the local state in
  `apps/web/.wrangler/state`.
- Server code reloads on save. After installing a dependency, restart the server.
- A server you start from a shell outlives it. Stop it with `taskkill /T /F /PID <pid>` on Windows
  (the pid listening on the port) or `kill` elsewhere.

## Walk through the app

1. Open `/login?mode=sign-up` and create an account. `pnpm dev:setup` turns email on in
   `.dev.vars`, and ID refuses to sign in an address that is not verified, so the account has no
   session yet.
2. Nothing is sent in local dev. Each email is saved under `apps/web/.wrangler/tmp/email`, and the
   terminal running `pnpm dev` prints its path; open the verification link from the `.txt` file. It signs you in and lands on `/account`.
3. Sign out, then sign in again with the same password. Try `/forgot-password` the same way: its
   link is saved the same way.

Without `EMAIL_FROM` in `.dev.vars`, nothing is sent, nobody is verified and new accounts are
signed in at once. That is only for trying the pages out.

## Reset local data

Stop the dev server first. To start over, delete `apps/web/.wrangler/state` (all local accounts)
and run `pnpm dev:setup` again.
