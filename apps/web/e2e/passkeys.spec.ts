import { expect, type Page, test } from "@playwright/test";
import {
	addAuthenticator,
	addPasskey,
	passkeyCeremonyAsked,
	passkeySignIn,
	pressSignOut,
	signOut,
	signUpWithoutAPassword,
	withoutTheOfferInTheEmailField,
} from "./authenticator";
import { watch } from "./helpers";

// Passkeys with Chromium's own WebAuthn. `test/passkeys.test.ts` holds what the server accepts and
// refuses. This covers what only a browser shows: that the pages take someone through the ceremony,
// that the browser agrees to the options, and that no policy gets in the way.

const PASSWORD = "a-long-password-for-tests";

let clients = 0;

test.beforeEach(async ({ context }, testInfo) => {
	// Sign-ins are limited per address, and tests run side by side.
	await context.setExtraHTTPHeaders({
		"cf-connecting-ip": `198.51.${testInfo.workerIndex + 1}.${++clients}`,
	});
});

async function toAccount(page: Page) {
	await page.goto("/account", { waitUntil: "networkidle" });
	await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
}

test("from adding a passkey to signing in with it", async ({ page }) => {
	const problems = await watch(page);
	await withoutTheOfferInTheEmailField(page);
	await addAuthenticator(page);
	await signUpWithoutAPassword(page);
	await toAccount(page);

	const passkeys = await addPasskey(page);

	await test.step("it is named after the device, and can be renamed", async () => {
		const row = passkeys.getByRole("listitem");
		await expect(row.getByText(/Chrome|Headless/)).toBeVisible();
		await row.getByRole("button", { name: "Rename" }).click();
		await row.getByLabel("Name").fill("Work laptop");
		await row.getByRole("button", { name: "Save" }).click();
		await expect(row.getByText("Work laptop")).toBeVisible();
		await page.reload({ waitUntil: "networkidle" });
		await expect(passkeys.getByText("Work laptop")).toBeVisible();
	});

	await test.step("it signs in, with no address and no password", async () => {
		await signOut(page);
		await page.waitForLoadState("networkidle");
		const signedIn = passkeySignIn(page);
		await page.getByRole("button", { name: "Use a passkey" }).click();
		await signedIn;
		await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
		await page.reload({ waitUntil: "networkidle" });
		await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
	});

	expect(problems).toEqual([]);
});

test("the browser's offer in the email field signs someone in", async ({ page }) => {
	const problems = await watch(page);
	await addAuthenticator(page);
	await signUpWithoutAPassword(page);
	await toAccount(page);
	await addPasskey(page);

	const signedIn = passkeySignIn(page);
	await pressSignOut(page);
	await signedIn;

	await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
	await page.reload({ waitUntil: "networkidle" });
	await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
	expect(problems).toEqual([]);
});

test("the browser's offer in the email field does not get in the way of a password", async ({
	page,
}) => {
	const problems = await watch(page);
	// It has no passkey to answer with, so the offer keeps waiting.
	await addAuthenticator(page);
	const email = await signUpWithoutAPassword(page);
	await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
	await page.getByLabel("Repeat it").fill(PASSWORD);
	await page.getByRole("button", { name: "Continue" }).click();
	await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();

	const offered = passkeyCeremonyAsked(page);
	await signOut(page);
	await offered;

	await expect(page.getByLabel("Email")).toHaveAttribute("autocomplete", "email webauthn");
	await page.getByLabel("Email").fill(email);
	await page.getByLabel("Password").fill(PASSWORD);
	await page.getByRole("button", { name: "Sign in" }).click();

	await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
	expect(problems).toEqual([]);
});

test("leaving the sign-in page ends the browser's offer in the email field", async ({ page }) => {
	const problems = await watch(page);
	// It has no passkey to answer with, so the offer keeps waiting.
	await addAuthenticator(page);
	await page.addInitScript(() => {
		const ask = navigator.credentials.get.bind(navigator.credentials);
		navigator.credentials.get = (options) => {
			if (options?.mediation === "conditional") Reflect.set(window, "offer", options.signal);
			return ask(options);
		};
	});
	const offerEnded = () =>
		page.evaluate(() => (Reflect.get(window, "offer") as AbortSignal | undefined)?.aborted);

	const offered = passkeyCeremonyAsked(page);
	await page.goto("/login", { waitUntil: "networkidle" });
	await offered;
	await expect.poll(offerEnded).toBe(false);

	// The router moves within the page, where a browser would keep the offer going by itself.
	await page.getByRole("link", { name: "Create an account" }).click();
	await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();

	await expect.poll(offerEnded).toBe(true);
	expect(problems).toEqual([]);
});

test("someone cannot remove their last way to sign in, until they add another", async ({
	page,
}) => {
	const problems = await watch(page);
	await addAuthenticator(page);
	await signUpWithoutAPassword(page);
	await toAccount(page);
	const passkeys = await addPasskey(page);
	const row = passkeys.getByRole("listitem");

	await row.getByRole("button", { name: "Remove" }).click();
	await row.getByRole("button", { name: "Keep" }).click();
	await expect(row).toHaveCount(1);

	await row.getByRole("button", { name: "Remove" }).click();
	await row.getByRole("button", { name: "Remove" }).click();
	await expect(passkeys.getByRole("alert")).toContainText("your only way to sign in");
	await expect(row).toHaveCount(1);

	await page.getByLabel("New password").fill(PASSWORD);
	await page.getByLabel("Repeat it").fill(PASSWORD);
	await page.getByRole("button", { name: "Add password" }).click();
	await expect(page.getByText("Your password is set.")).toBeVisible();

	await row.getByRole("button", { name: "Remove" }).click();
	await row.getByRole("button", { name: "Remove" }).click();
	await expect(row).toHaveCount(0);
	await expect(passkeys.getByRole("alert")).toHaveCount(0);
	expect(problems).toEqual([]);
});

test("a browser that cannot use passkeys is not offered them", async ({ page }) => {
	const problems = await watch(page);
	await page.addInitScript(() => {
		Reflect.deleteProperty(window, "PublicKeyCredential");
	});
	await signUpWithoutAPassword(page);
	await toAccount(page);

	const passkeys = page.getByRole("region", { name: "Passkeys" });
	await expect(passkeys).toBeVisible();
	await expect(passkeys.getByRole("button", { name: "Add a passkey" })).toHaveCount(0);

	await signOut(page);
	await page.waitForLoadState("networkidle");
	await expect(page.getByRole("button", { name: "Use a passkey" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
	expect(problems).toEqual([]);
});

test("turning down adding a passkey is not an error", async ({ page }) => {
	const problems = await watch(page);
	await addAuthenticator(page, { userVerified: false });
	await signUpWithoutAPassword(page);
	await toAccount(page);
	const passkeys = page.getByRole("region", { name: "Passkeys" });
	const add = passkeys.getByRole("button", { name: "Add a passkey" });

	await add.click();

	await expect(add).toBeEnabled();
	await expect(passkeys.getByRole("alert")).toHaveCount(0);
	await expect(passkeys.getByRole("listitem")).toHaveCount(0);
	expect(problems).toEqual([]);
});

test("turning down signing in is not an error, and they can try again", async ({ page }) => {
	const problems = await watch(page);
	await withoutTheOfferInTheEmailField(page);
	const authenticator = await addAuthenticator(page);
	await signUpWithoutAPassword(page);
	await toAccount(page);
	await addPasskey(page);
	await signOut(page);
	await page.waitForLoadState("networkidle");
	const use = page.getByRole("button", { name: "Use a passkey" });

	await authenticator.setUserVerified(false);
	const asked = passkeyCeremonyAsked(page);
	await use.click();
	await asked;

	await expect(use).toBeEnabled();
	await expect(page.getByRole("alert")).toHaveCount(0);

	await authenticator.setUserVerified(true);
	await use.click();
	await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
	expect(problems).toEqual([]);
});
