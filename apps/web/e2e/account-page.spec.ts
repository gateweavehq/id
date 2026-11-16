import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import * as oauth from "oauth4webapi";
import { totp } from "../test/totp";
import { APP } from "./fixtures";
import { watch } from "./helpers";
import { address, clientAddress, PASSWORD, signUp, signUpWithNoPassword } from "./people";

// What the account page shows and how it is laid out: which products use the account, a password row
// that opens, and the dead ends a failed request used to leave. `e2e/account.spec.ts` takes one person
// through the page, and the Worker tests hold what the server lets through.

const ISSUER = new URL("http://localhost:4732");

const registered = JSON.parse(
	readFileSync(resolve(import.meta.dirname, "../.wrangler/e2e-state/apps.json"), "utf8"),
) as Record<"normal" | "refusing", { clientId: string; clientSecret: string }>;

const onThisMachine = { [oauth.allowInsecureRequests]: true };

test.beforeEach(async ({ context }) => {
	// Three sign-ins in ten seconds is all one address gets, and tests run side by side.
	await context.setExtraHTTPHeaders({ "cf-connecting-ip": clientAddress() });
});

async function toAccount(page: Page) {
	await page.goto("/account", { waitUntil: "networkidle" });
	await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
}

/** Someone with a password, on their account page. */
async function newPerson(page: Page, name = "Ada Lovelace") {
	const email = address("account-page");
	await signUp(page, name, email);
	await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
	await page.waitForLoadState("networkidle");
	return email;
}

/** Signs in to the server's own app as its server would, all the way to the tokens. */
async function signInToTheApp(page: Page) {
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
	await page.goto(url.href);
	await expect(page.getByRole("heading", { name: "Back at the app" })).toBeVisible();

	const client = { client_id: registered.normal.clientId };
	const response = await oauth.authorizationCodeGrantRequest(
		as,
		client,
		oauth.ClientSecretBasic(registered.normal.clientSecret),
		oauth.validateAuthResponse(as, client, new URL(page.url()), state),
		APP.redirectUri,
		verifier,
		onThisMachine,
	);
	await oauth.processAuthorizationCodeResponse(as, client, response, {
		expectedNonce: nonce,
		requireIdToken: true,
	});
}

test("the page says whose account it is, and leads to each of its parts", async ({ page }) => {
	const problems = await watch(page);
	const email = await newPerson(page, "Ada Lovelace");

	const top = page.locator("main > header");
	await expect(top.getByText("Ada Lovelace")).toBeVisible();
	await expect(top.getByText(email)).toBeVisible();
	await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);

	const parts = page.getByRole("navigation", { name: "On this page" });
	await expect(parts.getByRole("link")).toHaveText([
		"Profile",
		"Sign-in",
		"Devices",
		"Apps",
		"Activity",
	]);
	for (const part of ["Profile", "Sign-in", "Devices", "Apps", "Activity"]) {
		await expect(page.getByRole("heading", { level: 2, name: part, exact: true })).toBeVisible();
	}
	await parts.getByRole("link", { name: "Activity" }).click();
	await expect(page).toHaveURL(/#activity$/);
	await expect(page.getByRole("heading", { name: "Recent activity" })).toBeInViewport();
	// Still the same page, with what it had loaded.
	await expect(page.getByRole("region", { name: "Recent activity" })).toContainText(
		"Created this account",
	);

	// A new name reaches the top of the page too.
	await page.getByLabel("Name").fill("Ada King");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByText("Saved.")).toBeVisible();
	await expect(top.getByText("Ada King")).toBeVisible();
	expect(problems).toEqual([]);
});

test("a product is listed once someone has signed in to it, with a way back", async ({ page }) => {
	const problems = await watch(page);
	await newPerson(page);
	const products = page.getByRole("region", { name: "Products you use" });
	await expect(
		products.getByText("These are part of this service, so they do not ask first."),
	).toBeVisible();
	await expect(products.getByText("You have not signed in to a product")).toBeVisible();
	await expect(products.getByRole("listitem")).toHaveCount(0);

	await signInToTheApp(page);
	await toAccount(page);

	const row = products.getByRole("listitem");
	await expect(row).toHaveCount(1);
	await expect(row).toContainText(APP.name);
	await expect(row).toContainText(`localhost:${APP.port}`);
	await expect(row).toContainText("Last signed in");
	// Where the app is registered, and not the address the sign-in came back to.
	await expect(row.getByRole("link", { name: `Open ${APP.name}` })).toHaveAttribute(
		"href",
		`http://localhost:${APP.port}`,
	);
	// It does not ask, so there is nothing to take back, and it is not among the apps that did ask.
	await expect(row.getByRole("button")).toHaveCount(0);
	await expect(page.getByRole("region", { name: "Other apps you allowed" })).not.toContainText(
		APP.name,
	);
	expect(problems).toEqual([]);
});

test("the password is a row that opens, and says what went wrong in its own words", async ({
	page,
}) => {
	const problems = await watch(page);
	await newPerson(page);
	const password = page.getByRole("region", { name: "Password", exact: true });
	const opener = password.getByRole("button", { name: "Change password" });
	// There before it has anything to say, and while the form is open, so that what it says is heard.
	const said = password.locator("[aria-live=polite]");
	await expect(said).toHaveCount(1);
	await expect(said).toBeEmpty();

	await expect(password.getByLabel("Current password")).toHaveCount(0);
	await opener.click();
	await expect(password.getByLabel("Current password")).toBeFocused();
	await expect(
		password.getByText("At least 8 characters. Changing it signs you out on your other devices."),
	).toBeVisible();

	await password.getByRole("button", { name: "Cancel" }).click();
	await expect(password.getByLabel("Current password")).toHaveCount(0);
	await expect(opener).toBeFocused();

	await opener.click();
	await password.getByLabel("Current password").fill("not-the-password");
	await password.getByLabel("New password").fill("another-long-password");
	await password.getByLabel("Repeat it").fill("another-long-password");
	await password.getByRole("button", { name: "Save password" }).click();
	await expect(password.getByRole("alert")).toHaveText("That password is wrong.");
	// It was about what they typed, so it goes once that changes.
	await password.getByLabel("Current password").fill(PASSWORD);
	await expect(password.getByRole("alert")).toHaveCount(0);

	await expect(said).toHaveCount(1);
	await expect(said).toBeEmpty();
	await password.getByRole("button", { name: "Save password" }).click();
	await expect(said).toContainText("Your password is changed");
	await expect(password.getByLabel("Current password")).toHaveCount(0);
	await expect(opener).toBeFocused();
	expect(problems).toEqual([]);
});

test("an account with no password is told what it has, and can add one", async ({ page }) => {
	const problems = await watch(page);
	await signUpWithNoPassword(page, "Katherine Johnson", address("no-password"));
	await toAccount(page);

	const summary = page.getByRole("region", { name: "How you sign in" });
	await expect(summary).toContainText("This account has nothing to sign in with again yet.");
	await expect(summary.getByRole("definition")).toHaveText([
		"Not set",
		"Needs a password",
		"None",
		"Not connected",
	]);

	const password = page.getByRole("region", { name: "Password", exact: true });
	await expect(password.getByLabel("New password")).toHaveCount(0);
	await password.getByRole("button", { name: "Add password" }).click();
	await expect(password.getByLabel("New password")).toBeFocused();
	await password.getByLabel("New password").fill(PASSWORD);
	await password.getByLabel("Repeat it").fill(PASSWORD);
	await password.getByRole("button", { name: "Save password" }).click();
	await expect(password.locator("[aria-live=polite]")).toContainText("Your password is set.");

	await expect(summary).toContainText("You sign in with your password.");
	await expect(summary.getByRole("definition").first()).toHaveText("Set");
	await expect(page.getByRole("region", { name: "Two-factor sign-in" })).toBeVisible();
	expect(problems).toEqual([]);
});

test("a blank name is told it is blank, and Save waits for a change", async ({ page }) => {
	const problems = await watch(page);
	await newPerson(page);
	const save = page.getByRole("button", { name: "Save", exact: true });
	await expect(save).toBeDisabled();

	await page.getByLabel("Name").fill("   ");
	await save.click();
	await expect(page.getByRole("alert")).toHaveText("Enter a name.");
	await page.getByLabel("Name").fill("Ada");
	await expect(page.getByRole("alert")).toHaveCount(0);
	await page.getByLabel("Name").fill("Ada Lovelace");
	await expect(save).toBeDisabled();
	expect(problems).toEqual([]);
});

for (const list of [
	{ region: "Where you are signed in", path: "**/api/auth/list-sessions", row: "This browser" },
	{
		region: "Passkeys",
		path: "**/api/auth/passkey/list-user-passkeys",
		row: "Sign in with your fingerprint",
	},
	{ region: "Recent activity", path: "**/api/auth/account/activity", row: "Created this account" },
]) {
	test(`a failed request for "${list.region}" offers to try again, and recovers`, async ({
		page,
	}) => {
		const problems = await watch(page);
		await newPerson(page);
		const region = page.getByRole("region", { name: list.region });
		const heading = page.getByRole("heading", { name: list.region });

		let failing = true;
		await page.route(list.path, (route) => (failing ? route.abort() : route.continue()));
		await page.reload({ waitUntil: "networkidle" });

		// It used to stay on "Loading…" for good.
		await expect(region.getByText("Loading…")).toHaveCount(0);
		await expect(region.getByRole("alert")).toContainText("could not be loaded");
		const again = region.getByRole("button", { name: "Try again" });

		// Still failing: the way to try stays.
		await again.click();
		await expect(again).toBeVisible();
		await expect(region.getByRole("alert")).toContainText("could not be loaded");

		failing = false;
		await again.click();
		await expect(region.getByText(list.row)).toBeVisible();
		await expect(region.getByRole("alert")).toHaveCount(0);
		await expect(again).toHaveCount(0);
		// The button went with the failure, and the focus must not go with it.
		await expect(heading).toBeFocused();
		expect(problems).toEqual([]);
	});
}

test("recovery codes can be downloaded, and a refused copy says so", async ({ page }) => {
	const problems = await watch(page);
	await page.addInitScript(() => {
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText: () => Promise.reject(new DOMException("Refused", "NotAllowedError")) },
		});
	});
	await newPerson(page);

	const section = page.getByRole("region", { name: "Two-factor sign-in" });
	await section.getByRole("button", { name: "Turn on" }).click();
	await section.getByLabel("Your password").fill(PASSWORD);
	await section.getByRole("button", { name: "Continue" }).click();
	await section.getByText("Can't scan it?").click();
	const key = (await section.getByTestId("two-factor-key").textContent()) ?? "";
	await section.getByLabel("The code your app shows").fill(totp(key));
	await section.getByRole("button", { name: "Turn on" }).click();
	await expect(section.getByTestId("recovery-code")).toHaveCount(10);
	const codes = await section.getByTestId("recovery-code").allTextContents();

	// It used to do nothing, and these codes are shown once.
	await section.getByRole("button", { name: "Copy" }).click();
	await expect(section.getByRole("alert")).toContainText("did not let this page copy them");
	await expect(section.getByRole("button", { name: "Copied" })).toHaveCount(0);

	const downloading = page.waitForEvent("download");
	await section.getByRole("button", { name: "Download" }).click();
	const download = await downloading;
	expect(download.suggestedFilename()).toBe("gateweave-id-recovery-codes.txt");
	expect(
		readFileSync(await download.path(), "utf8")
			.trim()
			.split("\n"),
	).toEqual(codes);
	expect(problems).toEqual([]);
});
