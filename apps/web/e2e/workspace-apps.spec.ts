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

test("an admin keeps an app to a group, and each person is told what is theirs", async ({
	page,
	baseURL,
}) => {
	const problems = await watch(page);
	const workspaceName = `Crew ${Date.now()}`;
	const bobEmail = address("bob");
	const carolEmail = address("carol");
	const bob = await newDevice(page, baseURL);
	const carol = await newDevice(page, baseURL);

	await signUp(page, "Ada", address("ada"));
	await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
	const slug = await makeWorkspace(page, workspaceName);

	for (const [person, name, email] of [
		[bob, "Bob", bobEmail],
		[carol, "Carol", carolEmail],
	] as const) {
		await signUp(person, name, email);
		await expect(person.getByRole("heading", { name: "Your account" })).toBeVisible();
		const since = Date.now() - 1000;
		await page.getByLabel("Their email").fill(email);
		await page.getByRole("button", { name: "Send invitation" }).click();
		await expect(page.getByText(`An invitation is on its way to ${email}.`)).toBeVisible();
		await person.goto(await linkSentSince(since, email), { waitUntil: "networkidle" });
		await person.getByRole("button", { name: "Join workspace" }).click();
		await expect(person.getByRole("heading", { name: "Your workspaces" })).toBeVisible();
	}
	await page.reload({ waitUntil: "networkidle" });

	const groups = page.getByRole("list", { name: "Groups", exact: true });

	await test.step("a group, with someone in it", async () => {
		await page.getByLabel("Group name").fill("!!!");
		await page.getByRole("button", { name: "Add group" }).click();
		await expect(page.getByRole("alert")).toHaveText("A name needs a letter or a digit.");

		await page.getByLabel("Group name").fill("Engineers");
		await page.getByRole("button", { name: "Add group" }).click();
		await expect(groups).toContainText("Engineers");
		await expect(groups).toContainText("No app uses it yet.");

		await page.getByLabel("Add someone to Engineers").selectOption({ label: `Bob (${bobEmail})` });
		await page.getByRole("button", { name: "Add to Engineers" }).click();
		await expect(page.getByRole("list", { name: "People in Engineers" })).toContainText("Bob");
	});

	const clientId = await test.step("an app, kept to it", async () => {
		await page.getByLabel("App name").fill("Field Notes");
		await page.getByLabel(/^Redirect URIs/).fill(APP.redirectUri);
		await page.getByRole("button", { name: "Add app" }).click();
		const added = await page.getByLabel("Client ID").inputValue();
		await page.getByRole("button", { name: "I have saved it" }).click();

		const apps = page.getByRole("list", { name: "Apps" });
		await expect(apps).toContainText(`Everyone in ${workspaceName} can use it.`);
		await page.getByRole("button", { name: "Change who can use Field Notes" }).click();
		await page.getByLabel("Only people in these groups").check();
		const save = page.getByRole("button", { name: "Save who can use Field Notes" });
		await expect(save).toBeDisabled();
		await page.getByLabel("Engineers", { exact: true }).check();
		await expect(page.getByText("That includes you.")).toBeVisible();
		await save.click();
		await expect(apps).toContainText("Only Engineers can use it.");
		await expect(groups).toContainText("Used by Field Notes.");
		return added;
	});

	await test.step("deleting the group would open the app, so it says why not", async () => {
		await page.getByRole("button", { name: "Delete Engineers", exact: true }).click();
		await page.getByRole("button", { name: "Yes, delete Engineers" }).click();
		await expect(page.getByRole("alert")).toContainText("Used by Field Notes");
		await expect(groups).toContainText("Engineers");
		await expect(page.getByRole("button", { name: "Yes, delete Engineers" })).toHaveCount(0);
	});

	await test.step("it fits on a phone", async () => {
		await page.setViewportSize({ width: 360, height: 740 });
		expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
		await page.setViewportSize({ width: 1280, height: 720 });
	});

	await test.step("a member sees their own group, and no one else's", async () => {
		await bob.goto(`/workspaces/${slug}`, { waitUntil: "networkidle" });
		await expect(bob.getByRole("heading", { name: "Your groups" })).toBeVisible();
		await expect(bob.locator("main")).toContainText("Engineers");
		await expect(bob.getByRole("button", { name: "Add group" })).toHaveCount(0);

		await carol.goto(`/workspaces/${slug}`, { waitUntil: "networkidle" });
		await expect(carol.getByRole("heading", { name: workspaceName, exact: true })).toBeVisible();
		await expect(carol.getByRole("heading", { name: "Your groups" })).toHaveCount(0);
		await expect(carol.locator("body")).not.toContainText("Engineers");
	});

	await test.step("someone in the workspace but not the group hears nothing of the app", async () => {
		await goToSignIn(carol, clientId);
		await expect(carol).toHaveURL(/\/no-access/);
		await expect(carol.locator("body")).not.toContainText("Field Notes");
		await expect(carol.locator("body")).not.toContainText("localhost:4733");
	});

	await test.step("someone in the group is asked, in words, and gets in", async () => {
		await goToSignIn(bob, clientId, { scope: "openid groups" });
		await expect(bob.getByText("See which of this workspace's groups you are in")).toBeVisible();
		await bob.getByRole("button", { name: "Allow" }).click();
		await expect(appHeading(bob)).toBeVisible();
	});

	await test.step("taken out, they are turned away, and asked again when put back", async () => {
		await expect(groups).toContainText("Taking someone out ends their access");
		await page.getByRole("button", { name: "Take Bob out of Engineers" }).click();
		await expect(page.getByRole("list", { name: "People in Engineers" })).toHaveCount(0);
		await expect(page.getByRole("list", { name: "Apps" })).toContainText(
			"Only Engineers can use it, and nobody is in it yet.",
		);
		await goToSignIn(bob, clientId, { scope: "openid groups" });
		await expect(bob).toHaveURL(/\/no-access/);

		await page.getByLabel("Add someone to Engineers").selectOption({ label: `Bob (${bobEmail})` });
		await page.getByRole("button", { name: "Add to Engineers" }).click();
		await expect(page.getByRole("list", { name: "People in Engineers" })).toContainText("Bob");
		await goToSignIn(bob, clientId, { scope: "openid groups" });
		await expect(bob.getByRole("button", { name: "Allow" })).toBeVisible();
	});

	await test.step("opened again, everyone can use it, and the group can go", async () => {
		await page.getByRole("button", { name: "Change who can use Field Notes" }).click();
		await page.getByLabel(`Everyone in ${workspaceName}`).check();
		await page.getByRole("button", { name: "Save who can use Field Notes" }).click();
		await expect(page.getByRole("list", { name: "Apps" })).toContainText(
			`Everyone in ${workspaceName} can use it.`,
		);
		await goToSignIn(carol, clientId);
		await expect(carol.getByRole("button", { name: "Allow" })).toBeVisible();

		await page.getByRole("button", { name: "Delete Engineers", exact: true }).click();
		await page.getByRole("button", { name: "Yes, delete Engineers" }).click();
		await expect(groups).toHaveCount(0);
	});

	expect(problems).toEqual([]);
	await bob.context().close();
	await carol.context().close();
});

test("a page left open cannot undo what someone else just chose", async ({ page, context }) => {
	const workspaceName = `Stale ${Date.now()}`;
	await signUp(page, "Ada", address("ada"));
	await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
	const slug = await makeWorkspace(page, workspaceName);
	await page.getByLabel("Group name").fill("Engineers");
	await page.getByRole("button", { name: "Add group" }).click();
	await expect(page.getByRole("list", { name: "Groups", exact: true })).toContainText("Engineers");
	await page.getByLabel("App name").fill("Field Notes");
	await page.getByLabel(/^Redirect URIs/).fill(APP.redirectUri);
	await page.getByRole("button", { name: "Add app" }).click();
	await page.getByRole("button", { name: "I have saved it" }).click();

	const other = await context.newPage();
	await other.goto(`/workspaces/${slug}`, { waitUntil: "networkidle" });
	await other.getByRole("button", { name: "Change who can use Field Notes" }).click();
	await other.getByLabel("Only people in these groups").check();
	await other.getByLabel("Engineers", { exact: true }).check();
	await expect(other.getByText("Nobody is in these groups yet")).toBeVisible();
	await other.getByRole("button", { name: "Save who can use Field Notes" }).click();
	await expect(other.getByRole("list", { name: "Apps" })).toContainText(
		"Only Engineers can use it",
	);

	await page.getByRole("button", { name: "Change who can use Field Notes" }).click();
	await expect(page.getByLabel(`Everyone in ${workspaceName}`)).toBeChecked();
	await page.getByRole("button", { name: "Save who can use Field Notes" }).click();

	await expect(page.getByRole("alert")).toContainText("Someone else has just changed");
	await expect(page.getByLabel("Only people in these groups")).toBeChecked();
	await expect(page.getByLabel("Engineers", { exact: true })).toBeChecked();
	await expect(page.getByRole("list", { name: "Apps" })).toContainText("Only Engineers can use it");
});

test("names with nowhere to break stay on a phone, whatever is open", async ({ page }) => {
	const workspaceName = "W".repeat(60);
	const groupName = "G".repeat(60);
	const appName = "A".repeat(60);
	await signUp(page, "Ada", address("ada"));
	await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
	await makeWorkspace(page, workspaceName);

	await page.getByLabel("Group name").fill(groupName);
	await page.getByRole("button", { name: "Add group" }).click();
	await expect(page.getByRole("list", { name: "Groups", exact: true })).toContainText(groupName);
	await page.getByLabel("App name").fill(appName);
	await page.getByLabel(/^Redirect URIs/).fill(APP.redirectUri);
	await page.getByRole("button", { name: "Add app" }).click();
	await page.getByRole("button", { name: "I have saved it" }).click();

	await page.setViewportSize({ width: 360, height: 740 });
	const sticksOut = () =>
		page.evaluate(() =>
			[...document.querySelectorAll("main *")]
				.filter((element) => element.getBoundingClientRect().right > innerWidth + 1)
				.map((element) => `${element.tagName} ${element.textContent?.slice(0, 40)}`),
		);
	expect(await sticksOut()).toEqual([]);

	await page.getByRole("button", { name: `Change who can use ${appName}` }).click();
	await page.getByLabel("Only people in these groups").check();
	await page.getByLabel(groupName, { exact: true }).check();
	await expect(page.getByRole("button", { name: `Save who can use ${appName}` })).toBeEnabled();
	expect(await sticksOut()).toEqual([]);

	await page.getByRole("button", { name: `Rename ${groupName}` }).click();
	await expect(page.getByRole("button", { name: `Save ${groupName}` })).toBeVisible();
	expect(await sticksOut()).toEqual([]);
	await page.getByRole("button", { name: "Cancel" }).first().click();
	await page.getByRole("button", { name: "Cancel" }).click();

	await page.getByRole("button", { name: `Edit ${appName}` }).click();
	await expect(page.getByRole("button", { name: `Save ${appName}` })).toBeVisible();
	expect(await sticksOut()).toEqual([]);
	await page.getByRole("button", { name: "Cancel" }).first().click();

	await page.getByRole("button", { name: `Replace the secret of ${appName}` }).click();
	await expect(
		page.getByRole("button", { name: `Yes, replace the secret of ${appName}` }),
	).toBeVisible();
	expect(await sticksOut()).toEqual([]);
	await page.getByRole("button", { name: "Keep it" }).click();

	await page.getByRole("button", { name: `Delete ${appName}`, exact: true }).click();
	await expect(page.getByRole("button", { name: `Yes, delete ${appName}` })).toBeVisible();
	expect(await sticksOut()).toEqual([]);
	await page.getByRole("button", { name: "Keep it" }).click();

	await page.getByRole("button", { name: `Delete ${groupName}`, exact: true }).click();
	await expect(page.getByRole("button", { name: `Yes, delete ${groupName}` })).toBeVisible();
	expect(await sticksOut()).toEqual([]);
});

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

	await test.step("they can take it back, and it has to ask again", async () => {
		// By a link an app could send, whose made-up signature would make the button fail if it stayed.
		await bob.goto("/account?sig=made-up&ba_param=sig", { waitUntil: "networkidle" });
		await expect(bob).toHaveURL(/\/account$/);
		const allowed = bob.getByRole("list", { name: "Apps you allowed" });
		await expect(allowed).toContainText("Field Notes");
		await expect(allowed).toContainText(workspaceName);
		await expect(allowed).toContainText("localhost:4733");
		await expect(allowed).toContainText("See your email address");

		const opener = bob.getByRole("button", { name: "Take back Field Notes", exact: true });
		await opener.click();
		await expect(bob.getByText("What it has already seen stays with it")).toBeVisible();
		await bob.getByRole("button", { name: "Keep it" }).click();
		await expect(bob.getByText("What it has already seen stays with it")).toHaveCount(0);
		await expect(opener).toBeFocused();
		await expect(allowed).toContainText("Field Notes");

		await opener.click();
		await bob.getByRole("button", { name: "Yes, take back Field Notes" }).click();
		await expect(allowed).toHaveCount(0);
		await expect(bob.getByRole("status")).toHaveText("Field Notes can no longer see your account.");
		await expect(bob.getByRole("heading", { name: "Apps you allowed" })).toBeFocused();

		await bob.reload({ waitUntil: "networkidle" });
		await expect(bob.getByText("The ones you allow are listed here")).toBeVisible();
		await expect(bob.getByText("Stopped allowing Field Notes to see this account")).toBeVisible();

		await goToSignIn(bob, clientId);
		await expect(
			bob.getByRole("heading", { name: "Allow Field Notes to use your account?" }),
		).toBeVisible();
		await bob.getByRole("button", { name: "Allow" }).click();
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
