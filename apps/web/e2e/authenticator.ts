import { expect, type Page } from "@playwright/test";
import { codeSentSince } from "./helpers";

/** Gives this page a passkey authenticator: Chromium's own, in software, that says yes by itself. */
export async function addAuthenticator(page: Page, { userVerified = true } = {}) {
	const devtools = await page.context().newCDPSession(page);
	await devtools.send("WebAuthn.enable");
	const { authenticatorId } = await devtools.send("WebAuthn.addVirtualAuthenticator", {
		options: {
			protocol: "ctap2",
			transport: "internal",
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: userVerified,
			automaticPresenceSimulation: true,
		},
	});
	return {
		/** With false it fails to check who is there, as when someone closes the browser's window. */
		setUserVerified: (isUserVerified: boolean) =>
			devtools.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified }),
		/** With false nobody answers: a ceremony keeps waiting, as for someone who has not chosen. */
		setAnswering: (enabled: boolean) =>
			devtools.send("WebAuthn.setAutomaticPresenceSimulation", { authenticatorId, enabled }),
	};
}

/**
 * The authenticator above answers the browser's offer in the email field the moment a page makes it,
 * where a person would have to choose it from a list, so someone who has signed out is signed back
 * in. A test of anything else on the sign-in page has to do without the offer, like a browser that
 * cannot make it.
 */
export async function withoutTheOfferInTheEmailField(page: Page) {
	await page.addInitScript(() => {
		PublicKeyCredential.isConditionalMediationAvailable = async () => false;
	});
}

/** Makes an account through the pages and stops on the way to choosing a password. */
export async function signUpWithoutAPassword(page: Page) {
	const email = `passkey-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
	const since = Date.now() - 1000;
	await page.goto("/signup", { waitUntil: "networkidle" });
	await page.getByLabel("Name").fill("Ada Lovelace");
	await page.getByLabel("Email").fill(email);
	await page.getByRole("button", { name: "Send me a code" }).click();
	await expect(page.getByRole("heading", { name: "Enter the code" })).toBeVisible();
	await page.getByLabel("Code").fill(await codeSentSince(since, email));
	await page.getByRole("button", { name: "Create account" }).click();
	await expect(page.getByRole("heading", { name: "Choose a password" })).toBeVisible();
	return email;
}

/** On the account page, adds a passkey with this page's authenticator. */
export async function addPasskey(page: Page) {
	const passkeys = page.getByRole("region", { name: "Passkeys" });
	const before = await passkeys.getByRole("listitem").count();
	await passkeys.getByRole("button", { name: "Add a passkey" }).click();
	await expect(passkeys.getByRole("listitem")).toHaveCount(before + 1);
	return passkeys;
}

export function pressSignOut(page: Page) {
	return page.getByRole("button", { name: "Sign out", exact: true }).first().click();
}

/** Signs out from the account page, and waits for the sign-in page. */
export async function signOut(page: Page) {
	await pressSignOut(page);
	await expect(page.getByRole("heading", { name: "Sign in to Gateweave ID" })).toBeVisible();
}

/** Whether a passkey sign-in has been answered, for a test that presses nothing to start one. */
export function passkeySignIn(page: Page) {
	return page.waitForResponse(
		(response) => response.url().endsWith("/passkey/verify-authentication") && response.ok(),
	);
}

/** Whether the page has started the offer in the email field, or any other ceremony. */
export function passkeyCeremonyAsked(page: Page) {
	return page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname.endsWith("/passkey/generate-authenticate-options") &&
			response.ok(),
	);
}
