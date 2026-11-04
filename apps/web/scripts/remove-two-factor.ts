// Turns off two-factor sign-in for someone who has lost their authenticator and their recovery codes,
// and has no passkey or GitHub to get in with. Nothing else can: email is not a way around it, or a
// mailbox alone would be enough. Whoever runs this has to be sure who is asking first.
//
//   pnpm --filter @gateweave/id-web two-factor:remove --email someone@example.com --env cloud
//
// Without --env it uses the top-level environment. With --local it uses the local dev database.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { removeTwoFactorStatements, twoFactorStateQuery } from "./two-factor-row.ts";

const { values } = parseArgs({
	options: {
		email: { type: "string" },
		env: { type: "string" },
		local: { type: "boolean", default: false },
	},
});

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

const email = values.email?.trim().toLowerCase();
if (!email) fail("--email is required.");

const where = values.local
	? ["--local", "--persist-to", ".wrangler/state"]
	: ["--remote", ...(values.env ? ["--env", values.env] : [])];

/** With this Node and no shell, so that no value here is ever parsed as a command. */
function wrangler(args: string[], stdout: "pipe" | "ignore") {
	return execFileSync(
		process.execPath,
		["node_modules/wrangler/bin/wrangler.js", "d1", "execute", "DB", ...where, ...args],
		{ stdio: ["ignore", stdout, "inherit"], encoding: "utf8" },
	);
}

const answer = JSON.parse(
	wrangler(["--json", "--command", twoFactorStateQuery(email)], "pipe"),
) as {
	results: { two_factor_enabled: number | null }[];
}[];
const person = answer[0]?.results[0];
if (!person) fail("Nobody here has that address.");
if (!person.two_factor_enabled) fail("That person does not have two-factor sign-in turned on.");

const dir = mkdtempSync(join(tmpdir(), "gateweave-id-two-factor-"));
try {
	const file = join(dir, "remove.sql");
	writeFileSync(file, `${removeTwoFactorStatements(email).join("\n")}\n`);
	wrangler(["--file", file], "ignore");
} finally {
	rmSync(dir, { recursive: true, force: true });
}

console.log("Two-factor sign-in is off for that person. Their password alone signs them in now.");
