import { expect, type Page, test } from "@playwright/test";
import * as oauth from "oauth4webapi";
import { APP } from "./fixtures";
import { linkSentSince, watch } from "./helpers";
import { address, clientAddress, makeWorkspace, newDevice, PASSWORD, signUp } from "./people";

// An app a workspace adds, from the form to a member signing in. `test/workspace-apps.test.ts` covers
// the rules; this covers that the pages keep to them, with real redirects and a real OIDC client.

const ISSUER = new URL("http://localhost:4732");
const SCOPE = "openid profile email offline_access";
const onThisMachine = { [oauth.allowInsecureRequests]: true };

test.beforeEach(async ({ context }) => {
	await context.setExtraHTTPHeaders({ "cf-connecting-ip": clientAddress() });
});

async function server() {
	const response = await oauth.discoveryRequest(ISSUER, { algorithm: "oidc", ...onThisMachine });
	return oauth.processDiscoveryResponse(ISSUER, response);
}

/** Sends the browser to ID the way this app would, and remembers what its server has to check. */
async function goToSignIn(page: Page, clientId: string, params: Record<string, string> = {}) {
	const as = await server();
	const state = oauth.generateRandomState();
	const nonce = oauth.generateRandomNonce();
	const verifier = oauth.generateRandomCodeVerifier();
	const url = new URL(as.authorization_endpoint ?? "");
	url.search = new URLSearchParams({
		client_id: clientId,
		redirect_uri: APP.redirectUri,
		response_type: "code",
		scope: SCOPE,
		state,
		nonce,
		code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
		code_challenge_method: "S256",
		...params,
	}).toString();
	await page.goto(url.href, { waitUntil: "networkidle" });
	return { as, state, nonce, verifier };
}

function appHeading(page: Page) {
	return page.getByRole("heading", { name: "Back at the app" });
}

test("an admin adds an app, and only members get in, once they agree", async ({
	page,
	baseURL,
}) => {
	const problems = await watch(page);
	const workspaceName = `Guild ${Date.now()}`;
	const bobEmail = address("bob");
	const bob = await newDevice(page, baseURL);
	const stranger = await newDevice(page, baseURL);

	await signUp(page, "Ada", address("ada"));
	await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
	const slug = await makeWorkspace(page, workspaceName);

	await test.step("the form says what is wrong with an address", async () => {
		await page.getByLabel("App name").fill("Field Notes");
		await page.getByLabel(/^Redirect URIs/).fill(`${ISSUER.origin}/callback`);
		await page.getByRole("button", { name: "Add app" }).click();
		await expect(page.getByRole("alert")).toHaveText(
			"An app cannot send people back to this server.",
		);
	});

	const { clientId, clientSecret } = await test.step("adding shows the secret once", async () => {
		await page.getByLabel(/^Redirect URIs/).fill(APP.redirectUri);
		await page.getByRole("button", { name: "Add app" }).click();
		await expect(
			page.getByRole("heading", { name: "Save the secret for Field Notes now" }),
		).toBeVisible();
		await expect(page.getByLabel("Issuer")).toHaveValue(ISSUER.origin);
		const made = {
			clientId: await page.getByLabel("Client ID").inputValue(),
			clientSecret: await page.getByLabel("Client secret").inputValue(),
		};
		expect(made.clientSecret).toMatch(/^gwid_cs_/);

		await page.getByRole("button", { name: "I have saved it" }).click();
		await expect(page.getByLabel("Client secret")).toHaveCount(0);
		await page.reload({ waitUntil: "networkidle" });
		await expect(page.getByRole("list", { name: "Apps" })).toContainText("Field Notes");
		await expect(page.getByRole("list", { name: "Apps" })).toContainText(made.clientId);
		expect(await page.content()).not.toContain(made.clientSecret);
		return made;
	});

	await test.step("someone outside is turned away, and told nothing of it", async () => {
		await signUp(stranger, "Mallory", address("mallory"));
		await expect(stranger.getByRole("heading", { name: "Your account" })).toBeVisible();
		await goToSignIn(stranger, clientId);
		await expect(stranger).toHaveURL(/\/no-access/);
		await expect(stranger.locator("body")).not.toContainText("Field Notes");
		await expect(stranger.locator("body")).not.toContainText(workspaceName);
		await expect(stranger.locator("body")).not.toContainText("localhost:4733");
		await expect(stranger.getByRole("button", { name: /^Back to/ })).toHaveCount(0);

		await stranger.goto(`/consent?client_id=${clientId}`, { waitUntil: "networkidle" });
		await expect(stranger).toHaveURL(/\/no-access/);
		await expect(stranger.getByRole("button", { name: "Allow" })).toHaveCount(0);
		await expect(stranger.locator("body")).not.toContainText("Field Notes");
		await expect(stranger.locator("body")).not.toContainText(workspaceName);
		await expect(stranger.locator("body")).not.toContainText("localhost:4733");
	});

	const link = await test.step("invite someone", async () => {
		await signUp(bob, "Bob", bobEmail);
		await expect(bob.getByRole("heading", { name: "Your account" })).toBeVisible();
		const since = Date.now() - 1000;
		await page.getByLabel("Their email").fill(bobEmail);
		await page.getByRole("button", { name: "Send invitation" }).click();
		await expect(page.getByText(`An invitation is on its way to ${bobEmail}.`)).toBeVisible();
		return linkSentSince(since, bobEmail);
	});

	await test.step("a member sees no apps in the workspace", async () => {
		await bob.goto(link, { waitUntil: "networkidle" });
		await bob.getByRole("button", { name: "Join workspace" }).click();
		await expect(bob.getByRole("heading", { name: "Your workspaces" })).toBeVisible();
		await bob.goto(`/workspaces/${slug}`, { waitUntil: "networkidle" });
		await expect(bob.getByRole("heading", { name: workspaceName, exact: true })).toBeVisible();
		await expect(bob.getByRole("heading", { name: "Apps" })).toHaveCount(0);
		await expect(bob.locator("body")).not.toContainText(clientId);
	});

	await test.step("a member is asked, told whose it is and where it goes, and gets in", async () => {
		const flow = await goToSignIn(bob, clientId);
		await expect(
			bob.getByRole("heading", { name: "Allow Field Notes to use your account?" }),
		).toBeVisible();
		await expect(bob.getByText(`An admin of ${workspaceName} added this app`)).toBeVisible();
		await expect(bob.getByText("Your answer takes you to localhost:4733")).toBeVisible();
		await bob.getByRole("button", { name: "Allow" }).click();
		await expect(appHeading(bob)).toBeVisible();

		const client = { client_id: clientId };
		const params = oauth.validateAuthResponse(flow.as, client, new URL(bob.url()), flow.state);
		const response = await oauth.authorizationCodeGrantRequest(
			flow.as,
			client,
			oauth.ClientSecretBasic(clientSecret),
			params,
			APP.redirectUri,
			flow.verifier,
			onThisMachine,
		);
		const tokens = await oauth.processAuthorizationCodeResponse(flow.as, client, response, {
			expectedNonce: flow.nonce,
			requireIdToken: true,
		});
		expect(oauth.getValidatedIdTokenClaims(tokens)?.email).toBe(bobEmail);
	});

	await test.step("they are not asked twice", async () => {
		await goToSignIn(bob, clientId);
		await expect(appHeading(bob)).toBeVisible();
	});

	await test.step("a wrong link leads nobody signed out to the app", async () => {
		const passerby = await newDevice(page, baseURL);
		await goToSignIn(passerby, clientId, { code_challenge: "", code_challenge_method: "" });
		await expect(passerby).toHaveURL(/^http:\/\/localhost:4732\/login$/);
		await expect(appHeading(passerby)).toHaveCount(0);
		await passerby.context().close();
	});

	await test.step("an app asking quietly gets a member signed in on another device", async () => {
		const device = await newDevice(page, baseURL);
		await goToSignIn(device, clientId, { prompt: "none" });
		await expect(device.getByRole("heading", { name: "Sign in to Gateweave ID" })).toBeVisible();
		await device.getByLabel("Email").fill(bobEmail);
		await device.getByLabel("Password", { exact: true }).fill(PASSWORD);
		await device.getByRole("button", { name: "Sign in", exact: true }).click();
		await expect(appHeading(device)).toBeVisible();
		await device.context().close();
	});

	await test.step("removed, they are turned away", async () => {
		await page.reload({ waitUntil: "networkidle" });
		await page.getByRole("button", { name: "Remove Bob" }).click();
		await page.getByRole("button", { name: "Yes, remove Bob" }).click();
		await expect(page.getByRole("button", { name: "Remove Bob" })).toHaveCount(0);
		await goToSignIn(bob, clientId);
		await expect(bob).toHaveURL(/\/no-access/);
	});

	await test.step("an app stays on its host, and its name and paths can change", async () => {
		await page.getByRole("button", { name: "Edit Field Notes" }).click();
		const form = page.getByRole("list", { name: "Apps" });
		await form.getByLabel(/^Redirect URIs/).fill("https://elsewhere.example.com/callback");
		await form.getByRole("button", { name: "Save Field Notes" }).click();
		await expect(form.getByRole("alert")).toHaveText(
			"An app stays on its host. To move, add a new app there and delete this one.",
		);
		await form.getByRole("button", { name: "Cancel" }).click();
		await expect(form.getByRole("alert")).toHaveCount(0);

		await page.getByRole("button", { name: "Edit Field Notes" }).click();
		await form.getByLabel("App name").fill("Field Book");
		await form.getByRole("button", { name: "Save Field Notes" }).click();
		await expect(form).toContainText("Field Book");
		await expect(form).not.toContainText("Field Notes");
	});

	await test.step("a new secret shows once, in sight, and fits on a phone", async () => {
		await page.setViewportSize({ width: 360, height: 740 });
		await page.getByRole("button", { name: "Replace the secret of Field Book" }).click();
		const confirm = page.getByRole("button", { name: "Yes, replace the secret of Field Book" });
		await confirm.scrollIntoViewIfNeeded();
		await confirm.click();
		const opened = page.getByRole("heading", { name: "Save the secret for Field Book now" });
		await expect(opened).toBeFocused();
		await expect(opened).toBeInViewport();
		const replaced = await page.getByLabel("Client secret").inputValue();
		expect(replaced).toMatch(/^gwid_cs_/);
		expect(replaced).not.toBe(clientSecret);
		expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
		await page.getByRole("button", { name: "I have saved it" }).click();
		await page.setViewportSize({ width: 1280, height: 720 });
	});

	await test.step("deleted, it is gone", async () => {
		await page.getByRole("button", { name: "Delete Field Book" }).click();
		await page.getByRole("button", { name: "Yes, delete Field Book" }).click();
		await expect(page.getByRole("list", { name: "Apps" })).toHaveCount(0);
	});

	expect(problems).toEqual([]);
	await bob.context().close();
	await stranger.context().close();
});
