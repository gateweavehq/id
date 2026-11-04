import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import * as oauth from "oauth4webapi";
import { totp, wrongCode } from "../test/totp";
import {
	addAuthenticator,
	addPasskey,
	passkeySignIn,
	signOut,
	signUpWithoutAPassword,
	withoutTheOfferInTheEmailField,
} from "./authenticator";
import { APP } from "./fixtures";
import { watch } from "./helpers";

// Two-factor sign-in on the real pages: turning it on, signing in with it, and going on to an app.
// `test/two-factor.test.ts` covers the rules. This covers what only a browser shows: that the code on
// the page is the one an app would read, that the second page keeps an app's signed request, and that
// none of it is against the page's policy.

const ISSUER = new URL("http://localhost:4732");
const PASSWORD = "a-long-password-for-tests";

const registered = JSON.parse(
	readFileSync(resolve(import.meta.dirname, "../.wrangler/e2e-state/apps.json"), "utf8"),
) as Record<"normal" | "refusing", { clientId: string; clientSecret: string }>;

const onThisMachine = { [oauth.allowInsecureRequests]: true };

let clients = 0;

test.beforeEach(async ({ context }, testInfo) => {
	// Three sign-ins in ten seconds is all one address gets, and tests run side by side.
	await context.setExtraHTTPHeaders({
		"cf-connecting-ip": `203.1.${testInfo.workerIndex + 1}.${++clients}`,
	});
});

/** Makes an account with a password, and lands on the account page. */
async function signUp(page: Page) {
	const email = await signUpWithoutAPassword(page);
	await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
	await page.getByLabel("Repeat it").fill(PASSWORD);
	await page.getByRole("button", { name: "Continue" }).click();
	await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
	return email;
}

const twoFactor = (page: Page) => page.getByRole("region", { name: "Two-factor sign-in" });

/** Turns it on from the account page, and leaves the page as it was. */
async function turnOn(page: Page) {
	const section = twoFactor(page);
	await section.getByRole("button", { name: "Turn on" }).click();
	await section.getByLabel("Your password").fill(PASSWORD);
	await section.getByRole("button", { name: "Continue" }).click();
	await expect(section.getByRole("img", { name: /QR code/ })).toBeVisible();

	await section.getByText("Can't scan it?").click();
	const key = (await section.getByTestId("two-factor-key").textContent()) ?? "";
	await section.getByLabel("The code your app shows").fill(totp(key));
	await section.getByRole("button", { name: "Turn on" }).click();

	await expect(section.getByRole("status")).toContainText("Two-factor sign-in is on");
	const recoveryCodes = await section.getByTestId("recovery-code").allTextContents();
	await section.getByRole("button", { name: "I have saved them" }).click();
	await expect(section.getByText("On", { exact: true })).toBeVisible();
	return { key, recoveryCodes };
}

async function givePassword(page: Page, email: string) {
	await page.getByLabel("Email").fill(email);
	await page.getByLabel("Password").fill(PASSWORD);
	await page.getByRole("button", { name: "Sign in" }).click();
	await expect(page.getByRole("heading", { name: "Enter your code" })).toBeVisible();
}

test("turning it on, then signing in with a code", async ({ page }) => {
	const problems = await watch(page);
	const email = await signUp(page);
	const { key } = await turnOn(page);

	await signOut(page);
	await givePassword(page, email);

	await page.getByLabel("Code").fill(wrongCode(key));
	await page.getByRole("button", { name: "Continue" }).click();
	await expect(page.getByRole("alert")).toContainText("That code is wrong");

	await page.getByLabel("Code").fill(totp(key, { steps: 1 }));
	await page.getByRole("button", { name: "Continue" }).click();
	await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
	await expect(page.getByText("Signed in with an authenticator app")).toBeVisible();

	expect(problems).toEqual([]);
});

test("a recovery code signs someone in once", async ({ page }) => {
	const problems = await watch(page);
	const email = await signUp(page);
	const { recoveryCodes } = await turnOn(page);
	expect(recoveryCodes).toHaveLength(10);

	await signOut(page);
	await givePassword(page, email);
	await page.getByRole("button", { name: "I can't use my authenticator app" }).click();
	// In capitals, as someone might type one in from a piece of paper.
	await page.getByLabel("Recovery code").fill((recoveryCodes[0] ?? "").toUpperCase());
	await page.getByRole("button", { name: "Continue" }).click();
	await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();

	await signOut(page);
	await givePassword(page, email);
	await page.getByRole("button", { name: "I can't use my authenticator app" }).click();
	await page.getByLabel("Recovery code").fill(recoveryCodes[0] ?? "");
	await page.getByRole("button", { name: "Continue" }).click();
	await expect(page.getByRole("alert")).toContainText("already been used");

	expect(problems).toEqual([]);
});

test("new recovery codes replace the old ones, and turning it off asks for the password", async ({
	page,
}) => {
	const email = await signUp(page);
	await turnOn(page);
	const section = twoFactor(page);

	await section.getByRole("button", { name: "New recovery codes" }).click();
	await section.getByLabel("Your password").fill(PASSWORD);
	await section.getByRole("button", { name: "Replace my recovery codes" }).click();
	await expect(section.getByTestId("recovery-code")).toHaveCount(10);
	await expect(section.getByRole("status")).toHaveCount(0);
	await section.getByRole("button", { name: "I have saved them" }).click();

	await section.getByRole("button", { name: "Turn off" }).click();
	await section.getByLabel("Your password").fill("not-the-password");
	await section.getByRole("button", { name: "Turn off" }).click();
	await expect(section.getByRole("alert")).toContainText("That password is wrong");

	await section.getByLabel("Your password").fill(PASSWORD);
	await section.getByRole("button", { name: "Turn off" }).click();
	await expect(section.getByRole("button", { name: "Turn on" })).toBeVisible();

	await signOut(page);
	await page.getByLabel("Email").fill(email);
	await page.getByLabel("Password").fill(PASSWORD);
	await page.getByRole("button", { name: "Sign in" }).click();
	await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
});

test("someone with no password is not offered it, as it would protect nothing they have", async ({
	page,
}) => {
	await signUpWithoutAPassword(page);
	await page.goto("/account", { waitUntil: "networkidle" });
	await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
	await expect(twoFactor(page)).toHaveCount(0);
});

test("a passkey does not ask, having two factors of its own", async ({ page }) => {
	await withoutTheOfferInTheEmailField(page);
	await addAuthenticator(page);
	await signUp(page);
	await turnOn(page);
	await addPasskey(page);
	await signOut(page);
	await page.waitForLoadState("networkidle");
	const signedIn = passkeySignIn(page);
	await page.getByRole("button", { name: "Use a passkey" }).click();
	await signedIn;
	await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
});

test("on the way to an app, the code takes someone on to it", async ({ page }) => {
	const problems = await watch(page);
	const email = await signUp(page);
	const { key } = await turnOn(page);
	await signOut(page);

	const as = await oauth.processDiscoveryResponse(
		ISSUER,
		await oauth.discoveryRequest(ISSUER, { algorithm: "oidc", ...onThisMachine }),
	);
	const state = oauth.generateRandomState();
	const nonce = oauth.generateRandomNonce();
	const verifier = oauth.generateRandomCodeVerifier();
	const url = new URL(as.authorization_endpoint ?? "");
	url.search = new URLSearchParams({
		client_id: registered.normal.clientId,
		redirect_uri: APP.redirectUri,
		response_type: "code",
		scope: "openid email",
		state,
		nonce,
		code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
		code_challenge_method: "S256",
	}).toString();
	await page.goto(url.href, { waitUntil: "networkidle" });

	await givePassword(page, email);
	expect(new URL(page.url()).searchParams.has("sig")).toBe(true);

	await page.getByLabel("Code").fill(totp(key, { steps: 1 }));
	await page.getByRole("button", { name: "Continue" }).click();
	await page.waitForURL((at) => at.origin === new URL(APP.redirectUri).origin);

	const client = { client_id: registered.normal.clientId };
	const auth = oauth.ClientSecretBasic(registered.normal.clientSecret);
	const params = oauth.validateAuthResponse(as, client, new URL(page.url()), state);
	const response = await oauth.authorizationCodeGrantRequest(
		as,
		client,
		auth,
		params,
		APP.redirectUri,
		verifier,
		onThisMachine,
	);
	const tokens = await oauth.processAuthorizationCodeResponse(as, client, response, {
		expectedNonce: nonce,
		requireIdToken: true,
	});
	expect(oauth.getValidatedIdTokenClaims(tokens)?.email).toBe(email);
	expect(problems).toEqual([]);
});
