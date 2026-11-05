// Starts the built app for the browser tests: `vite preview` on port 4732 with its own empty local
// database. It runs from Playwright's `webServer`, so it works the same on a laptop and in CI, where
// there is no .dev.vars. Run `vite build` first.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { hashPassword } from "better-auth/crypto";
import { appRow, insertStatement } from "../src/server/auth/app-row.ts";
import { APP, PERSON } from "./fixtures.ts";

const root = resolve(import.meta.dirname, "..");
process.chdir(root);

// Kept apart from `pnpm dev` data, and wiped on every start so each run begins empty.
const state = resolve(root, ".wrangler", "e2e-state");
rmSync(state, { recursive: true, force: true });

// Only the secret matters: a preview reads nothing else from here. An existing .dev.vars (at the
// repository root, next to wrangler.jsonc) is left alone.
const devVars = resolve(root, "../../.dev.vars");
if (!existsSync(devVars)) {
	const secret = randomBytes(32).toString("base64");
	const template = readFileSync(resolve(root, "../../.dev.vars.example"), "utf8");
	writeFileSync(
		devVars,
		template.replace(/^BETTER_AUTH_SECRET=.*$/m, `BETTER_AUTH_SECRET=${secret}`),
	);
}

// Run the tools with this Node, not through a shell: Playwright stops the server by killing this
// process, and a shell in between would leave the server running (and Playwright waiting).
function wrangler(...args) {
	const run = spawnSync(
		process.execPath,
		[
			resolve(root, "node_modules/wrangler/bin/wrangler.js"),
			...args,
			"--local",
			"--persist-to",
			state,
		],
		{ stdio: "inherit" },
	);
	if (run.status !== 0) process.exit(run.status ?? 1);
}

wrangler("d1", "migrations", "apply", "DB");

// What the tests cannot make for themselves. Nothing offers registering an app, by design, and a
// person made by signing up would take a code from each test that needs one. The second app has lost
// its name, which the check for who may sign in takes as refusing everyone, so a test can be refused.
const app = appRow({ app: "browser-tests", name: APP.name, redirectUris: [APP.redirectUri] });
const refusing = appRow({ app: "refusing", name: "Refusing", redirectUris: [APP.redirectUri] });
const now = Date.now();
const seed = [
	insertStatement(app.row),
	insertStatement({ ...refusing.row, metadata: "{}" }),
	`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
		VALUES ('seeded-person', '${PERSON.name}', '${PERSON.email}', 1, ${now}, ${now});`,
	`INSERT INTO "account" (id, account_id, provider_id, user_id, password, created_at, updated_at)
		VALUES ('seeded-account', 'seeded-person', 'credential', 'seeded-person',
		'${await hashPassword(PERSON.password)}', ${now}, ${now});`,
].join("\n");
mkdirSync(state, { recursive: true });
const seedFile = resolve(state, "seed.sql");
writeFileSync(seedFile, seed);
wrangler("d1", "execute", "DB", "--file", seedFile);
writeFileSync(
	resolve(state, "apps.json"),
	JSON.stringify({
		normal: { clientId: app.clientId, clientSecret: app.clientSecret },
		refusing: { clientId: refusing.clientId, clientSecret: refusing.clientSecret },
	}),
);

createServer((_request, response) => {
	response.setHeader("content-type", "text/html");
	response.end("<h1>Back at the app</h1>");
}).listen(APP.port);

const server = spawn(
	process.execPath,
	[resolve(root, "node_modules/vite/bin/vite.js"), "preview", "--port", "4732", "--strictPort"],
	{ stdio: "inherit", env: { ...process.env, ID_STATE_DIR: state } },
);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill(signal));
server.on("exit", (code) => process.exit(code ?? 0));
