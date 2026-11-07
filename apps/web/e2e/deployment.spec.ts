import { expect, test } from "@playwright/test";
import { PERSON } from "./fixtures";
import { linkSentSince, resetTokenSentSince, signIn, watch } from "./helpers";
import { address, clientAddress, makeWorkspace, newDevice, PASSWORD, signUp } from "./people";

// Who runs a server, inviting someone to it. What the server holds to is in test/deployment.test.ts.
// The first account in this server's database is the seeded person, so they own it. Sign-up stays as
// it is here: a test that closed it would change it for all the others running beside it.

test.beforeEach(async ({ context }) => {
	await context.setExtraHTTPHeaders({ "cf-connecting-ip": clientAddress() });
});

test("the owner invites someone, who makes their account from the link", async ({
	page,
	baseURL,
}) => {
	const problems = await watch(page);
	await signIn(page, PERSON.email, PERSON.password);
	await page.getByRole("link", { name: "Open settings" }).click();
	await expect(page.getByRole("heading", { name: "This server", exact: true })).toBeVisible();
	await expect(page.getByText("Anyone can make an account here")).toBeVisible();
	// A server that sends email has no such thing.
	await expect(page.getByRole("region", { name: "Help someone back in" })).toHaveCount(0);

	const email = address("invited");
	const since = Date.now() - 1000;
	await page.getByLabel("Their email").fill(email);
	await page.getByRole("button", { name: "Invite", exact: true }).click();
	await expect(page.getByText(`An invitation is on its way to ${email}.`)).toBeVisible();
	await expect(page.getByRole("list", { name: "Open invitations" })).toContainText(email);
	const link = await linkSentSince(since, email);

	const person = await newDevice(page, baseURL);
	const theirProblems = await watch(person);
	await person.goto(link, { waitUntil: "networkidle" });
	await expect(person.getByText(`For ${email}`)).toBeVisible();
	await person.getByLabel("Name").fill("Invited Person");
	await person.getByLabel("Password", { exact: true }).fill(PASSWORD);
	await person.getByLabel("Repeat it").fill("something else entirely");
	await person.getByRole("button", { name: "Make my account" }).click();
	await expect(person.getByRole("alert")).toHaveText("The passwords do not match");
	await person.getByLabel("Repeat it").fill(PASSWORD);
	await person.getByRole("button", { name: "Make my account" }).click();
	await expect(person.getByRole("heading", { name: "Workspaces", exact: true })).toBeVisible();

	// It has been used, so it now says so, and signing out is the way to find that out.
	await person.goto(link, { waitUntil: "networkidle" });
	await expect(person.getByRole("heading", { name: "You are signed in" })).toBeVisible();
	await person.getByRole("button", { name: "Sign out" }).click();
	await expect(
		person.getByRole("heading", { name: "This invitation does not work" }),
	).toBeVisible();

	await page.reload({ waitUntil: "networkidle" });
	await expect(page.getByRole("list", { name: "Open invitations" })).toHaveCount(0);
	expect(problems).toEqual([]);
	expect(theirProblems).toEqual([]);
});

test("the owner can withdraw an invitation, and the link stops working", async ({
	page,
	baseURL,
}) => {
	await signIn(page, PERSON.email, PERSON.password);
	await page.goto("/server", { waitUntil: "networkidle" });
	const email = address("withdrawn");
	const since = Date.now() - 1000;
	await page.getByLabel("Their email").fill(email);
	await page.getByRole("button", { name: "Invite", exact: true }).click();
	await expect(page.getByRole("list", { name: "Open invitations" })).toContainText(email);
	const link = await linkSentSince(since, email);

	await page.getByRole("button", { name: `Withdraw the invitation to ${email}` }).click();
	await expect(page.getByText(email)).toHaveCount(0);

	const person = await newDevice(page, baseURL);
	await person.goto(link, { waitUntil: "networkidle" });
	await expect(
		person.getByRole("heading", { name: "This invitation does not work" }),
	).toBeVisible();
});

test("anyone else finds no such page, and no way to it from their account", async ({ page }) => {
	await signUp(page, "Someone Else", address("someone"));
	await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
	await expect(page.getByRole("link", { name: "Open settings" })).toHaveCount(0);

	await page.goto("/server", { waitUntil: "networkidle" });
	await expect(page.getByRole("heading", { name: "This server", exact: true })).toHaveCount(0);
	await expect(page.getByLabel("Their email")).toHaveCount(0);
});

test("a workspace that cannot invite says why, and offers no form", async ({ page }) => {
	const problems = await watch(page);
	await signUp(page, "Their Own Workspace", address("no-invites"));
	const slug = await makeWorkspace(page, "Closed Door");
	await expect(page.getByLabel("Their email")).toBeVisible();

	// Sign-up stays open here, as above, so the server's answer is what changes.
	await page.route("**/api/auth/workspaces/get*", async (route) => {
		const response = await route.fetch();
		await route.fulfill({ response, json: { ...(await response.json()), mayInvite: false } });
	});
	await page.goto(`/workspaces/${slug}`);
	await expect(page.getByText("so it cannot invite anyone for now")).toBeVisible();
	await expect(page.getByLabel("Their email")).toBeHidden();
	expect(problems).toEqual([]);
});

test("a link with nothing in it says it does not work", async ({ page }) => {
	await page.goto("/join", { waitUntil: "networkidle" });
	await expect(page.getByRole("heading", { name: "This invitation does not work" })).toBeVisible();
});

test("the owner of a server with no email makes a link to pass on", async ({ page }) => {
	const problems = await watch(page);
	await signIn(page, PERSON.email, PERSON.password);

	// This server sends email, so its answers are what change, as above. What the server holds to is
	// in test/deployment.test.ts.
	const asked: unknown[] = [];
	await page.route("**/api/auth/deployment/get", async (route) => {
		const response = await route.fetch();
		await route.fulfill({ response, json: { ...(await response.json()), sendsEmail: false } });
	});
	await page.route("**/api/auth/deployment/password-link", async (route) => {
		asked.push(route.request().postDataJSON());
		if (asked.length === 1) {
			await route.fulfill({
				status: 400,
				json: { code: "INVALID_PASSWORD", message: "That password is not right." },
			});
			return;
		}
		await route.fulfill({
			json: { link: "https://id.example/reset-password#a-token", expiresAt: new Date() },
		});
	});
	await page.goto("/server", { waitUntil: "networkidle" });

	const help = page.getByRole("region", { name: "Help someone back in" });
	await help.getByLabel("The email they sign in with").fill("someone@example.com");
	await help.getByLabel("Your password").fill("not the one");
	await help.getByRole("button", { name: "Make a link" }).click();
	await expect(help.getByRole("alert")).toHaveText("That password is not right.");
	await expect(help.getByLabel("The email they sign in with")).toHaveValue("someone@example.com");

	await help.getByLabel("Your password").fill(PERSON.password);
	await help.getByRole("button", { name: "Make a link" }).click();
	await expect(help.getByLabel("Send them this link")).toHaveValue(
		"https://id.example/reset-password#a-token",
	);
	await expect(help.getByRole("alert")).toHaveCount(0);
	await expect(help.getByLabel("Your password")).toHaveValue("");
	expect(asked.at(-1)).toEqual({ email: "someone@example.com", password: PERSON.password });
	expect(problems).toEqual([]);
});

test("someone chooses a new password from a link that keeps its token after the #", async ({
	page,
	baseURL,
}) => {
	const problems = await watch(page);
	const email = address("back-in");
	await signUp(page, "Back In", email);

	// A reset email's token, moved to where a link from the owner of a server with no email keeps it.
	const person = await newDevice(page, baseURL);
	const theirProblems = await watch(person);
	const since = Date.now() - 1000;
	await person.goto("/forgot-password", { waitUntil: "networkidle" });
	await person.getByLabel("Email").fill(email);
	await person.getByRole("button", { name: "Send reset link" }).click();
	await expect(person.getByRole("heading", { name: "Check your email" })).toBeVisible();
	const link = `/reset-password#${await resetTokenSentSince(since)}`;

	const newPassword = `${PASSWORD}-and-more`;
	await person.goto(link, { waitUntil: "networkidle" });
	await person.getByLabel("New password").fill(newPassword);
	await person.getByLabel("Repeat it").fill(newPassword);
	await person.getByRole("button", { name: "Change password" }).click();
	await expect(person.getByRole("heading", { name: "Password changed" })).toBeVisible();
	await signIn(person, email, newPassword);

	// It has been used, so it says so once it is tried.
	const later = await newDevice(page, baseURL);
	await later.goto(link, { waitUntil: "networkidle" });
	await later.getByLabel("New password").fill(newPassword);
	await later.getByLabel("Repeat it").fill(newPassword);
	await later.getByRole("button", { name: "Change password" }).click();
	await expect(later.getByRole("heading", { name: "This link no longer works" })).toBeVisible();

	await later.goto("/reset-password", { waitUntil: "networkidle" });
	await expect(later.getByRole("heading", { name: "This link no longer works" })).toBeVisible();
	expect(problems).toEqual([]);
	expect(theirProblems).toEqual([]);
});
