// Registers a first-party app in a deployment's database, and prints its client id and secret, once.
//
//   pnpm --filter @gateweave/id-web apps:add --app track --name "Gateweave Track" \
//     --redirect-uri https://track.example.com/api/auth/callback/oidc \
//     --backchannel-logout-uri https://track.example.com/api/auth/backchannel-logout/oidc \
//     --env staging
//
// Without --env it uses the top-level environment. With --local it uses the local dev database.
// Nothing else can add a first-party app: no route offers it, on purpose. A workspace's admins add
// apps of their own, which only its members can use, through `src/server/auth/workspace-apps.ts`.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
	appAddedStatement,
	appRow,
	insertStatement,
	problemWithRedirectUri,
} from "../src/server/auth/app-row.ts";

const { values } = parseArgs({
	options: {
		app: { type: "string" },
		name: { type: "string" },
		"redirect-uri": { type: "string", multiple: true },
		"post-logout-uri": { type: "string", multiple: true },
		"backchannel-logout-uri": { type: "string" },
		env: { type: "string" },
		local: { type: "boolean", default: false },
	},
});

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

const { app, name } = values;
const redirectUris = values["redirect-uri"];
if (!app || !name || !redirectUris?.length) {
	fail("--app, --name and at least one --redirect-uri are required.");
}
// The check for who may sign in goes by this id.
if (!/^[a-z0-9][a-z0-9-]*$/.test(app)) fail("--app takes lowercase letters, digits and hyphens.");

const hosts = new Set(redirectUris.map((uri) => URL.canParse(uri) && new URL(uri).host));
// Each person's id in an app is derived from the host of its first redirect URI, so more than one
// would make that URI matter in a way nobody would guess. Register one host per app.
if (hosts.size > 1) fail("All of an app's redirect URIs must be on one host.");

const logoutUri = values["backchannel-logout-uri"];
for (const uri of [...redirectUris, ...(values["post-logout-uri"] ?? []), logoutUri ?? ""]) {
	const problem = uri ? problemWithRedirectUri(uri) : undefined;
	if (problem) fail(problem);
}

const { row, clientId, clientSecret } = appRow({
	app,
	name,
	redirectUris,
	postLogoutRedirectUris: values["post-logout-uri"],
	backchannelLogoutUri: logoutUri,
});

const dir = mkdtempSync(join(tmpdir(), "gateweave-id-app-"));
try {
	const file = join(dir, "app.sql");
	writeFileSync(file, `${insertStatement(row)}\n${appAddedStatement(app)}\n`);
	const where = values.local
		? ["--local", "--persist-to", ".wrangler/state"]
		: ["--remote", ...(values.env ? ["--env", values.env] : [])];
	// With this Node and no shell, so that no value here is ever parsed as a command.
	execFileSync(
		process.execPath,
		["node_modules/wrangler/bin/wrangler.js", "d1", "execute", "DB", ...where, "--file", file],
		{ stdio: ["ignore", "ignore", "inherit"] },
	);
} finally {
	rmSync(dir, { recursive: true, force: true });
}

console.log(`Registered ${name}. The secret is shown this once, and only its hash is kept.`);
console.log(`client id:     ${clientId}`);
console.log(`client secret: ${clientSecret}`);
