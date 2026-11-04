// One-time local setup: creates .dev.vars at the repository root (next to wrangler.jsonc) with a
// random secret and a sender for email, and applies D1 migrations to the local database. Safe to
// re-run: an existing .dev.vars is left alone.
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const DEV_VARS = "../../.dev.vars";

if (existsSync(DEV_VARS)) {
	console.log(".dev.vars already exists, leaving it alone.");
} else {
	const secret = randomBytes(32).toString("base64");
	const template = readFileSync("../../.dev.vars.example", "utf8");
	writeFileSync(
		DEV_VARS,
		template
			.replace(/^BETTER_AUTH_SECRET=.*$/m, `BETTER_AUTH_SECRET=${secret}`)
			// Signing up takes a code sent by email, so local dev has email on. Nothing is sent: each
			// message is saved to a file under apps/web/.wrangler/tmp/email.
			.replace(/^# EMAIL_FROM=.*$/m, "EMAIL_FROM=Gateweave ID <id@example.com>")
			// Local dev is an OIDC provider too, so an app under development can sign in against it.
			.replace(/^# BETTER_AUTH_URL=.*$/m, "BETTER_AUTH_URL=http://localhost:4730")
			.replace(
				/^# OIDC_PAIRWISE_SECRET=.*$/m,
				`OIDC_PAIRWISE_SECRET=${randomBytes(32).toString("base64")}`,
			),
	);
	console.log("Created .dev.vars with fresh secrets, email on and the OIDC provider on.");
}

// The `db:migrate:local` script, without a second pnpm in between. Wrangler is on the PATH
// because this runs as a package script.
execSync("wrangler d1 migrations apply DB --local --persist-to .wrangler/state", {
	stdio: "inherit",
});
