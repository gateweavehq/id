// Removes every passkey of someone who has lost the one they would need to remove it themselves.
// Removing a passkey takes a sign-in with two factors, so a person whose only second factor was a
// passkey cannot replace it with their password or GitHub alone: that is what keeps whoever holds
// only one of those from doing the same. Whoever runs this has to be sure who is asking first.
//
//   pnpm --filter @gateweave/id-web passkeys:remove --email someone@example.com --env cloud
//
// Without --env it uses the top-level environment. With --local it uses the local dev database.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { passkeyStateQuery, removePasskeysStatements } from "./passkey-rows.ts";

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

const answer = JSON.parse(wrangler(["--json", "--command", passkeyStateQuery(email)], "pipe")) as {
	results: { passkeys: number | null }[];
}[];
const person = answer[0]?.results[0];
if (!person) fail("Nobody here has that address.");
if (!person.passkeys) fail("That person has no passkeys.");

const dir = mkdtempSync(join(tmpdir(), "gateweave-id-passkeys-"));
try {
	const file = join(dir, "remove.sql");
	writeFileSync(file, `${removePasskeysStatements(email).join("\n")}\n`);
	wrangler(["--file", file], "ignore");
} finally {
	rmSync(dir, { recursive: true, force: true });
}

console.log(
	"That person's passkeys are removed. They sign in another way now, and add one again from their account.",
);
