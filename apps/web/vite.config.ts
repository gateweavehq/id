import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { devSecrets } from "./scripts/dev-secrets";

export default defineConfig(({ command }) => ({
	resolve: { tsconfigPaths: true },
	plugins: [
		devtools(),
		cloudflare({
			// At the repository root, for the "Deploy to Cloudflare" button (see wrangler.jsonc).
			configPath: "../../wrangler.jsonc",
			viteEnvironment: { name: "ssr" },
			// The browser tests keep their data apart from `pnpm dev` (see e2e/server.mjs).
			persistState: process.env.ID_STATE_DIR ? { path: process.env.ID_STATE_DIR } : true,
			config: (config) => {
				// The browser tests' build has email on, because signing up takes a code (see
				// e2e/build.mjs). Nothing is sent: each message is saved to a file. It has GitHub on
				// too, and those tests stop the browser at GitHub's door.
				const e2e = process.env.ID_E2E
					? {
							vars: {
								...config.vars,
								EMAIL_FROM: "Gateweave ID <id@example.com>",
								GITHUB_CLIENT_ID: "client-for-browser-tests",
								GITHUB_CLIENT_SECRET: "secret-for-browser-tests",
							},
						}
					: {};
				if (command !== "serve") return e2e;
				// In dev only: `secrets.required` would drop the optional settings in .dev.vars.
				return { secrets: { required: devSecrets(config.secrets?.required ?? [], devVarsKeys()) } };
			},
		}),
		tailwindcss(),
		tanstackStart(),
		viteReact(),
		rootDeployConfig(),
	],
}));

/**
 * Wrangler finds the build output through .wrangler/deploy/config.json, which the Cloudflare
 * plugin writes next to this file. Workers Builds runs the commands people do not write, like
 * `npx wrangler preview` for a branch, from the repository root, so that needs a copy too.
 */
function rootDeployConfig(): Plugin {
	return {
		name: "id:root-deploy-config",
		apply: "build",
		applyToEnvironment: (environment) => environment.name === "ssr",
		writeBundle: {
			order: "post",
			sequential: true,
			handler() {
				const from = join(this.environment.config.root, ".wrangler", "deploy");
				const to = fileURLToPath(new URL("../../.wrangler/deploy", import.meta.url));
				const rebase = (path: string) => relative(to, resolve(from, path));
				const config = JSON.parse(readFileSync(join(from, "config.json"), "utf8"));
				config.configPath = rebase(config.configPath);
				if (config.prerenderWorkerConfigPath) {
					config.prerenderWorkerConfigPath = rebase(config.prerenderWorkerConfigPath);
				}
				config.auxiliaryWorkers = config.auxiliaryWorkers.map((worker: { configPath: string }) => ({
					configPath: rebase(worker.configPath),
				}));
				mkdirSync(to, { recursive: true });
				writeFileSync(join(to, "config.json"), JSON.stringify(config));
			},
		},
	};
}

/** The names (never the values) of the keys .dev.vars sets to something. */
function devVarsKeys(): Set<string> {
	try {
		const text = readFileSync(new URL("../../.dev.vars", import.meta.url), "utf8");
		return new Set(
			[...text.matchAll(/^\s*([A-Z0-9_]+)\s*=\s*\S/gm)].map((match) => match[1] ?? ""),
		);
	} catch {
		return new Set();
	}
}
