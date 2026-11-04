import { defineConfig, devices } from "@playwright/test";

// Port 4732 keeps clear of `pnpm dev` (4730) and `pnpm preview` (4731). The tests run against the
// production build, because the page's policy is only sent there.
const PORT = 4732;

export default defineConfig({
	testDir: "e2e",
	timeout: 60_000,
	expect: { timeout: 10_000 },
	fullyParallel: true,
	forbidOnly: Boolean(process.env.CI),
	retries: 0,
	workers: process.env.CI ? 2 : undefined,
	reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
	use: {
		baseURL: `http://localhost:${PORT}`,
		trace: "retain-on-failure",
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: {
		command: "node e2e/server.mjs",
		url: `http://localhost:${PORT}/login`,
		reuseExistingServer: false,
		timeout: 120_000,
		stdout: "pipe",
		stderr: "pipe",
	},
});
