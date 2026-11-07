import { expect, test } from "@playwright/test";
import { codeSentSince, signIn, watch } from "./helpers";

// The whole of a person's account, in one go, on real pages. The Worker tests cover the rules; this
// covers that the pages use them, which only a browser can tell.

const PASSWORD = "a-long-password-for-tests";
const NEW_PASSWORD = "another-long-password";
const ELSEWHERE = "203.0.113.50";

test("from signing up to ending a session elsewhere", async ({ page, browser, baseURL }) => {
	const problems = await watch(page);
	const email = `person-${Date.now()}@example.com`;

	await test.step("sign up with a code, then choose a password", async () => {
		const since = Date.now() - 1000;
		await page.goto("/signup", { waitUntil: "networkidle" });
		await page.getByLabel("Name").fill("Ada Lovelace");
		await page.getByLabel("Email").fill(email);
		await page.getByRole("button", { name: "Send me a code" }).click();
		await expect(page.getByRole("heading", { name: "Enter the code" })).toBeVisible();

		await page.getByLabel("Code").fill(await codeSentSince(since, email));
		await page.getByRole("button", { name: "Create account" }).click();
		await expect(page.getByRole("heading", { name: "Choose a password" })).toBeVisible();

		await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
		await page.getByLabel("Repeat it").fill(PASSWORD);
		await page.getByRole("button", { name: "Continue" }).click();
		await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
	});

	await test.step("see what has happened to the account", async () => {
		const activity = page.getByRole("region", { name: "Recent activity" });
		await expect(activity.getByText("Created this account")).toBeVisible();
		await expect(activity.getByText("Signed in with a code sent by email")).toBeVisible();
		await expect(activity.getByText("Added a password")).toBeVisible();
	});

	await test.step("change the name, and it stays", async () => {
		await expect(page.getByLabel("Email")).toHaveValue(email);
		await page.getByLabel("Name").fill("Ada King");
		await page.getByRole("button", { name: "Save" }).click();
		await expect(page.getByText("Saved.")).toBeVisible();
		await page.reload({ waitUntil: "networkidle" });
		await expect(page.getByLabel("Name")).toHaveValue("Ada King");
	});

	const sessions = page.getByRole("region", { name: "Where you are signed in" });
	// Another device is another client. Tests run side by side from one address, and three sign-ins
	// in ten seconds is all it gets, which this test needs for itself.
	const elsewhereContext = await browser.newContext({
		baseURL,
		extraHTTPHeaders: { "cf-connecting-ip": ELSEWHERE },
	});
	const elsewhere = await elsewhereContext.newPage();

	await test.step("see another device, and sign it out", async () => {
		await signIn(elsewhere, email, PASSWORD);
		await page.reload({ waitUntil: "networkidle" });
		await expect(sessions.getByRole("listitem")).toHaveCount(2);
		await expect(sessions.getByText("This device")).toHaveCount(1);
		await expect(sessions.getByText(`from ${ELSEWHERE}`)).toBeVisible();
		// The newest session, and the one that is not this device, is the only one with a button.
		await sessions.getByRole("listitem").getByRole("button", { name: "Sign out" }).click();
		await expect(sessions.getByRole("listitem")).toHaveCount(1);

		await elsewhere.reload();
		await expect(elsewhere).toHaveURL(/\/login/);
	});

	await test.step("a wrong current password changes nothing", async () => {
		await page.getByLabel("Current password").fill("not-the-password");
		await page.getByLabel("New password").fill(NEW_PASSWORD);
		await page.getByLabel("Repeat it").fill(NEW_PASSWORD);
		await page.getByRole("button", { name: "Change password" }).click();
		await expect(page.getByRole("alert")).toBeVisible();
	});

	await test.step("change the password, which signs other devices out", async () => {
		await signIn(elsewhere, email, PASSWORD);
		await page.getByLabel("Current password").fill(PASSWORD);
		await page.getByLabel("New password").fill(NEW_PASSWORD);
		await page.getByLabel("Repeat it").fill(NEW_PASSWORD);
		await page.getByRole("button", { name: "Change password" }).click();
		await expect(page.getByText("Your password is changed")).toBeVisible();

		// This device has a new session now, and the list keeps up.
		await expect(sessions.getByText("This device")).toHaveCount(1);
		await expect(sessions.getByRole("listitem")).toHaveCount(1);

		await elsewhere.reload();
		await expect(elsewhere).toHaveURL(/\/login/);
		await signIn(elsewhere, email, NEW_PASSWORD);
	});

	await test.step("sign out everywhere, which ends a copy of this browser's cookie too", async () => {
		// Whoever stole this browser's cookie has the same session as this browser.
		const copyContext = await browser.newContext({
			baseURL,
			extraHTTPHeaders: { "cf-connecting-ip": "203.0.113.51" },
		});
		await copyContext.addCookies(await page.context().cookies());
		const copy = await copyContext.newPage();
		await copy.goto("/account", { waitUntil: "networkidle" });
		await expect(copy.getByRole("heading", { name: "Your account" })).toBeVisible();

		await sessions.getByRole("button", { name: "Sign out everywhere", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "You are signed out everywhere" }),
		).toBeVisible();

		for (const device of [copy, elsewhere]) {
			await device.goto("/account");
			await expect(device).toHaveURL(/\/login/);
		}
		await copyContext.close();

		await page.getByRole("link", { name: "Go to sign-in" }).click();
		await signIn(page, email, NEW_PASSWORD);
		await page.goto("/account", { waitUntil: "networkidle" });
		await expect(sessions.getByRole("listitem")).toHaveCount(1);
		await expect(
			page.getByRole("region", { name: "Recent activity" }).getByText("Signed out everywhere"),
		).toBeVisible();
	});

	await elsewhereContext.close();
	expect(problems).toEqual([]);
});
