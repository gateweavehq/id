// Starts the built app for the browser tests: `vite preview` on port 4732 with its own empty local
// database. It runs from Playwright's `webServer`, so it works the same on a laptop and in CI, where
// there is no .dev.vars. Run `vite build` first.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// Only the secret matters. A preview reads it from beside the built Worker, where a build leaves a
// copy of .dev.vars if there is one, and CI has none. A Worker without it serves nothing, so the tests
// have their own wherever they run. The .dev.vars at the repository root is left alone.
writeFileSync(
	resolve(root, "dist/server/.dev.vars"),
	`BETTER_AUTH_SECRET=${randomBytes(32).toString("hex")}\n`,
);

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
	// A new deployment takes accounts by invitation, and each test here makes its own by signing up.
	`UPDATE "deployment" SET sign_up = 'open' WHERE id = 1;`,
	insertStatement(app.row),
	insertStatement({ ...refusing.row, metadata: "{}" }),
	`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
		VALUES ('seeded-person', '${PERSON.name}', '${PERSON.email}', 1, ${now}, ${now});`,
	`INSERT INTO "account" (id, account_id, provider_id, user_id, password, created_at, updated_at)
		VALUES ('seeded-account', 'seeded-person', 'credential', 'seeded-person',
		'${await hashPassword(PERSON.password)}', ${now}, ${now});`,
	// The apps of a conformance run (conformance/run.mjs).
	...(process.env.ID_E2E_SEED ? [readFileSync(process.env.ID_E2E_SEED, "utf8")] : []),
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
	[
		resolve(root, "node_modules/vite/bin/vite.js"),
		"preview",
		"--port",
		"4732",
		"--strictPort",
		// The conformance suite runs in a container, which reaches this machine by another address.
		...(process.env.ID_E2E_HOST ? ["--host", process.env.ID_E2E_HOST] : []),
	],
	{ stdio: "inherit", env: { ...process.env, ID_STATE_DIR: state } },
);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill(signal));
server.on("exit", (code) => process.exit(code ?? 0));
