---

name: schema-change
description: Change the database schema of Gateweave ID with a proper migration - the D1 database (accounts, sessions and, later, the provider's tables, via Better Auth). Use when adding or altering tables, columns or indexes.
---

# Change a schema

ID has one database: D1, which holds everything. Its schema is generated from the Better Auth
configuration (`apps/web/src/server/auth/config.ts`), so a plugin, an `additionalFields` entry or a
provider option is what changes it. The Durable Object holds rate limits only and keeps no schema.

Migrations are append-only. Never edit or delete a migration that has been merged; write a new
one that moves the schema forward. When another branch's migration lands on `main` first,
regenerate yours after it rather than renaming it.

## Steps

1. Change the Better Auth configuration.
2. Regenerate the Drizzle schema, then the migration. Never write either by hand:

   ```sh
   pnpm --filter @gateweave/id-web auth:schema
   pnpm --filter @gateweave/id-web db:generate
   ```

   `auth:schema` runs the Better Auth CLI (pinned to the `better-auth` version) against
   `src/server/auth/cli.ts`, and never connects to a database.
3. Read the SQL in `apps/web/migrations/`. SQLite cannot alter some columns in place, so Drizzle
   may rebuild a table; make sure existing rows survive.
4. Apply it locally and run the app:

   ```sh
   pnpm --filter @gateweave/id-web db:migrate:local
   ```
5. Deploys apply D1 migrations before the new code goes live (`apps/web/scripts/deploy.mjs`), for
   Gateweave Cloud and self-hosters alike. Old code still runs against the new schema until the
   deploy finishes, so say in the pull request whether it can.

## Verify

```sh
pnpm verify
```
