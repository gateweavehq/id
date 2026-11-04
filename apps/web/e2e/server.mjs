// Starts the built app for the browser tests: `vite preview` on port 4732 with its own empty local
// database. It runs from Playwright's `webServer`, so it works the same on a laptop and in CI, where
// there is no .dev.vars. Run `vite build` first.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

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
const migrated = spawnSync(
	process.execPath,
	[
		resolve(root, "node_modules/wrangler/bin/wrangler.js"),
		...["d1", "migrations", "apply", "DB", "--local", "--persist-to", state],
	],
	{ stdio: "inherit" },
);
if (migrated.status !== 0) process.exit(migrated.status ?? 1);

const server = spawn(
	process.execPath,
	[resolve(root, "node_modules/vite/bin/vite.js"), "preview", "--port", "4732", "--strictPort"],
	{ stdio: "inherit", env: { ...process.env, ID_STATE_DIR: state } },
);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill(signal));
server.on("exit", (code) => process.exit(code ?? 0));
