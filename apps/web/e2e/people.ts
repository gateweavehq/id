import { expect, type Page, test } from "@playwright/test";
import { codeSentSince } from "./helpers";

export const PASSWORD = "a-long-password-for-tests";

/** No group of six digits in it, which is what a code in an email looks like. */
export function address(who: string) {
	return `${who}-${crypto.randomUUID()}@example.com`;
}

function slug() {
	return `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

let clients = 0;

/** Three sign-ins in ten seconds is all one address gets, and tests run side by side. */
export function clientAddress() {
	return `192.0.${test.info().workerIndex + 1}.${++clients}`;
}

/** Someone else, on a device of their own. */
export async function newDevice(page: Page, baseURL: string | undefined) {
	const context = await page
		.context()
		.browser()
		?.newContext({
			baseURL,
			extraHTTPHeaders: { "cf-connecting-ip": clientAddress() },
		});
	if (!context) throw new Error("There is no browser to open another device in");
	return context.newPage();
}

export async function signUp(page: Page, name: string, email: string) {
	const since = Date.now() - 1000;
	await page.goto("/signup", { waitUntil: "networkidle" });
	await page.getByLabel("Name").fill(name);
	await page.getByLabel("Email").fill(email);
	await page.getByRole("button", { name: "Send me a code" }).click();
	await expect(page.getByRole("heading", { name: "Enter the code" })).toBeVisible();
	await page.getByLabel("Code").fill(await codeSentSince(since, email));
	await page.getByRole("button", { name: "Create account" }).click();
	await expect(page.getByRole("heading", { name: "Choose a password" })).toBeVisible();
	await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
	await page.getByLabel("Repeat it").fill(PASSWORD);
	await page.getByRole("button", { name: "Continue" }).click();
}

export async function makeWorkspace(page: Page, name: string, address = slug()) {
	await page.goto("/workspaces", { waitUntil: "networkidle" });
	await page.getByLabel("Name").fill(name);
	await page.getByLabel("Address").fill(address);
	await page.getByRole("button", { name: "Make workspace" }).click();
	await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
	return address;
}
