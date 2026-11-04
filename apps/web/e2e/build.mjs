// Builds the app for the browser tests. It is the normal build, plus ID_E2E, which makes
// vite.config.ts turn email on, because signing up takes a code. (Run through Node so the variable
// is set the same way on every platform.)
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const built = spawnSync(
	process.execPath,
	[resolve(root, "node_modules/vite/bin/vite.js"), "build"],
	{
		cwd: root,
		stdio: "inherit",
		env: { ...process.env, ID_E2E: "1" },
	},
);
process.exit(built.status ?? 1);
