import { expect, test } from "@playwright/test";
import { PERSON } from "./fixtures";
import { linkSentSince, signIn, watch } from "./helpers";
import { address, clientAddress, newDevice, PASSWORD, signUp } from "./people";

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
	await expect(page.getByRole("heading", { name: "This server" })).toBeVisible();
	await expect(page.getByText("Anyone can make an account here")).toBeVisible();

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
	await expect(page.getByRole("heading", { name: "This server" })).toHaveCount(0);
	await expect(page.getByLabel("Their email")).toHaveCount(0);
});

test("a link with nothing in it says it does not work", async ({ page }) => {
	await page.goto("/join", { waitUntil: "networkidle" });
	await expect(page.getByRole("heading", { name: "This invitation does not work" })).toBeVisible();
});
