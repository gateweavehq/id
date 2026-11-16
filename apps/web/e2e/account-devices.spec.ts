import { expect, type Page, test } from "@playwright/test";
import { totp } from "../test/totp";
import { signIn, watch } from "./helpers";
import { address, clientAddress, newDevice, PASSWORD, signUp } from "./people";

// The parts of the account page about what has been going on: the browsers someone is signed in on,
// and what happened lately. What the server allows is in the Worker tests. This covers what a person
// with a keyboard or a screen reader is left with after each press.

test.beforeEach(async ({ context }) => {
	// Three sign-ins in ten seconds is all one address gets, and tests run side by side.
	await context.setExtraHTTPHeaders({ "cf-connecting-ip": clientAddress() });
});

/** Someone with a password, on their account page. */
async function newPerson(page: Page) {
	const email = address("devices");
	await signUp(page, "Ada Lovelace", email);
	await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
	await page.waitForLoadState("networkidle");
	return email;
}

const sessionsOf = (page: Page) => page.getByRole("region", { name: "Where you are signed in" });
const activityOf = (page: Page) => page.getByRole("region", { name: "Recent activity" });

test("ending a session says so, and leaves the focus somewhere", async ({ page, baseURL }) => {
	const problems = await watch(page);
	const email = await newPerson(page);
	const elsewhere = await newDevice(page, baseURL);
	const problemsElsewhere = await watch(elsewhere);
	await signIn(elsewhere, email, PASSWORD);
	await page.reload({ waitUntil: "networkidle" });

	const sessions = sessionsOf(page);
	const rows = sessions.getByRole("listitem");
	await expect(rows).toHaveCount(2);
	// This one came from the sign-up code, and the other from the password.
	await expect(rows.first()).toContainText("Chrome on Windows · with a code sent by email");
	await expect(rows.first()).toContainText("This browser");
	await expect(rows.last()).toContainText("Chrome on Windows · with a password");
	await expect(rows.last()).toContainText("Last active");
	const status = sessions.locator("[aria-live=polite]");
	await expect(status).toBeEmpty();

	// A name of its own, since "Sign out" is also what the top of the page says.
	const end = rows.last().getByRole("button", { name: /^Sign out Chrome on Windows, signed in / });
	await end.focus();
	await page.keyboard.press("Enter");

	await expect(rows).toHaveCount(1);
	await expect(status).toHaveText("Chrome on Windows is signed out.");
	// It used to be left on nothing, so the next Tab started from the top of the page.
	await expect(page.getByRole("heading", { name: "Where you are signed in" })).toBeFocused();
	await elsewhere.reload();
	await expect(elsewhere).toHaveURL(/\/login/);

	await elsewhere.context().close();
	expect(problems).toEqual([]);
	expect(problemsElsewhere).toEqual([]);
});

test("signing out other browsers asks first, and can be taken back", async ({ page, baseURL }) => {
	const problems = await watch(page);
	const email = await newPerson(page);
	const [second, third] = [await newDevice(page, baseURL), await newDevice(page, baseURL)];
	const problemsElsewhere = [await watch(second), await watch(third)];
	await signIn(second, email, PASSWORD);
	await signIn(third, email, PASSWORD);
	await page.reload({ waitUntil: "networkidle" });

	const sessions = sessionsOf(page);
	const rows = sessions.getByRole("listitem");
	await expect(rows).toHaveCount(3);
	const opener = sessions.getByRole("button", { name: "Sign out other browsers", exact: true });

	await opener.click();
	await expect(
		sessions.getByText("This signs you out in 2 other browsers. You stay signed in here."),
	).toBeVisible();
	// The button that changes nothing has the focus, and gives it back to the one that asked.
	await expect(sessions.getByRole("button", { name: "Cancel" })).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(opener).toBeFocused();
	await expect(rows).toHaveCount(3);
	await second.reload();
	await expect(second.getByRole("heading", { name: "Your account" })).toBeVisible();

	await opener.click();
	await sessions.getByRole("button", { name: "Yes, sign out other browsers" }).click();
	await expect(rows).toHaveCount(1);
	await expect(sessions.locator("[aria-live=polite]")).toHaveText(
		"Your other browsers are signed out.",
	);
	await expect(opener).toHaveCount(0);
	await expect(page.getByRole("heading", { name: "Where you are signed in" })).toBeFocused();
	for (const device of [second, third]) {
		await device.reload();
		await expect(device).toHaveURL(/\/login/);
		await device.context().close();
	}
	expect(problems).toEqual([]);
	expect(problemsElsewhere).toEqual([[], []]);
});

test("signing out of everything asks first, and can be taken back", async ({ page }) => {
	const problems = await watch(page);
	await newPerson(page);
	const sessions = sessionsOf(page);
	const opener = sessions.getByRole("button", { name: "Sign out of everything", exact: true });

	await opener.click();
	await expect(
		sessions.getByText(
			"This signs you out everywhere, here too, and you will have to sign in again.",
		),
	).toBeVisible();
	await sessions.getByRole("button", { name: "Cancel" }).click();
	await expect(opener).toBeFocused();
	await page.reload({ waitUntil: "networkidle" });
	await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();

	await opener.click();
	await sessions.getByRole("button", { name: "Yes, sign out of everything" }).click();
	await expect(page.getByRole("heading", { name: "You are signed out everywhere" })).toBeVisible();
	await expect(page).toHaveTitle("Signed out · Gateweave ID");
	await page.goto("/account");
	await expect(page).toHaveURL(/\/login/);
	expect(problems).toEqual([]);
});

test("activity folds a code into its sign-in, and marks what failed", async ({ page }) => {
	const problems = await watch(page);
	const email = await newPerson(page);

	const twoFactor = page.getByRole("region", { name: "Two-factor sign-in" });
	await twoFactor.getByRole("button", { name: "Turn on" }).click();
	await twoFactor.getByLabel("Your password").fill("not-the-password");
	await twoFactor.getByRole("button", { name: "Continue" }).click();
	await expect(twoFactor.getByRole("alert")).toHaveText("That password is wrong.");
	await twoFactor.getByLabel("Your password").fill(PASSWORD);
	await twoFactor.getByRole("button", { name: "Continue" }).click();
	await twoFactor.getByText("Can't scan it?").click();
	const key = (await twoFactor.getByTestId("two-factor-key").textContent()) ?? "";
	await twoFactor.getByLabel("The code your app shows").fill(totp(key));
	await twoFactor.getByRole("button", { name: "Turn on" }).click();
	await twoFactor.getByRole("button", { name: "I have saved them" }).click();

	await page.getByRole("button", { name: "Sign out", exact: true }).first().click();
	await page.getByLabel("Email").fill(email);
	await page.getByLabel("Password").fill(PASSWORD);
	await page.getByRole("button", { name: "Sign in" }).click();
	await page.getByLabel("Code").fill(totp(key, { steps: 1 }));
	await page.getByRole("button", { name: "Continue" }).click();
	await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();

	const activity = activityOf(page);
	await expect(activity.getByRole("heading", { level: 4 })).toHaveText(["Today"]);
	await expect(activity.getByText("Signed in with an authenticator app")).toBeVisible();
	// The right password and the code after it were one sign-in, and are one row.
	await expect(activity.getByText("was asked for a code")).toHaveCount(0);

	const mistyped = activity
		.getByRole("listitem")
		.filter({ hasText: "Mistyped your password on the account page" });
	await expect(mistyped).toHaveCount(1);
	await expect(mistyped).toContainText("Not you? Change your password and sign out of everything.");
	// Only what failed says so.
	await expect(activity.getByText("Not you?")).toHaveCount(1);
	expect(problems).toEqual([]);
});

test("activity shows ten rows, and more a press at a time", async ({ page }) => {
	const problems = await watch(page);
	await newPerson(page);
	// Fifty real events would take a hundred presses to make. The page arranges what it is sent.
	const HOUR = 60 * 60 * 1000;
	const events = Array.from({ length: 25 }, (_, index) => ({
		id: `event-${index + 1}`,
		at: new Date(Date.now() - index * 7 * HOUR).toISOString(),
		type: "sign_in",
		app: null,
		ip: `203.0.113.${index + 1}`,
		device: "Chrome on Windows",
		detail: "password",
	}));
	await page.route("**/api/auth/account/activity", (route) => route.fulfill({ json: { events } }));
	await page.reload({ waitUntil: "networkidle" });

	const activity = activityOf(page);
	const rows = activity.getByRole("listitem");
	const more = activity.getByRole("button", { name: "Show more" });
	await expect(rows).toHaveCount(10);
	// Each day is said once, above its rows, and the rows say only the time.
	await expect(activity.getByRole("heading", { level: 4 }).first()).toHaveText("Today");
	expect(await activity.getByRole("heading", { level: 4 }).count()).toBeGreaterThan(1);

	await more.focus();
	await page.keyboard.press("Enter");
	await expect(rows).toHaveCount(20);
	// The first of what the press brought, so reading goes on from there.
	await expect(rows.nth(10)).toBeFocused();
	await expect(rows.nth(10)).toContainText("203.0.113.11");

	await more.click();
	await expect(rows).toHaveCount(25);
	await expect(more).toHaveCount(0);
	await expect(rows.nth(20)).toBeFocused();
	expect(problems).toEqual([]);
});
