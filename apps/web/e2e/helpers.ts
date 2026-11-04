import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, type Page } from "@playwright/test";

const VIOLATION = "Policy violation:";

/** Everything the browser refused or that threw on this page, from here on. */
export async function watch(page: Page): Promise<string[]> {
	const problems: string[] = [];
	page.on("pageerror", (error) => problems.push(error.message));
	page.on("console", (message) => {
		if (message.text().startsWith(VIOLATION)) problems.push(message.text());
	});
	await page.addInitScript((prefix) => {
		document.addEventListener("securitypolicyviolation", (event) => {
			console.error(`${prefix} ${event.violatedDirective} blocked ${event.blockedURI}`);
		});
	}, VIOLATION);
	return problems;
}

/** Where the local email binding saves each message, as a file named with a random id. */
const OUTBOX = resolve(import.meta.dirname, "../.wrangler/tmp/email");

/**
 * The code sent to `email` since `since`. The files do not say who a message is for, but what it
 * says does, so tests can wait for their own codes side by side.
 */
export async function codeSentSince(since: number, email: string): Promise<string> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const texts = readdirSync(OUTBOX, { recursive: true, encoding: "utf8" })
			.filter((file) => file.includes("email-text"))
			.map((file) => join(OUTBOX, file))
			.filter((file) => statSync(file).isFile() && statSync(file).mtimeMs >= since)
			.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
			.map((file) => readFileSync(file, "utf8"));
		const code = /\b\d{6}\b/.exec(texts.find((text) => text.includes(email)) ?? "")?.[0];
		if (code) return code;
		await new Promise((done) => setTimeout(done, 100));
	}
	throw new Error(`No code reached ${email}`);
}

/** Signs in on the page. It lands on the account page. */
export async function signIn(page: Page, email: string, password: string) {
	await page.goto("/login", { waitUntil: "networkidle" });
	await page.getByLabel("Email").fill(email);
	await page.getByLabel("Password").fill(password);
	await page.getByRole("button", { name: "Sign in" }).click();
	await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
}
