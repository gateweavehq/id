import { expect, test } from "@playwright/test";
import { watch } from "./helpers";
import {
	address,
	makeWorkspace,
	newDevice,
	PASSWORD,
	signUp,
	signUpWithNoPassword,
} from "./people";

// The Worker tests cover the rules. This covers that the page uses them, and that what it shows at the
// end does not depend on a session that has just gone.

test("deleting an account asks for the password, then means it", async ({ page, baseURL }) => {
	const device = await newDevice(page, baseURL);
	const problems = await watch(device);
	const email = address("leaving");
	await signUp(device, "Ada Lovelace", email);
	await expect(device.getByRole("heading", { name: "Your account" })).toBeVisible();

	const section = device.getByRole("region", { name: "Delete account" });

	await test.step("changing your mind leaves it as it was", async () => {
		await section.getByRole("button", { name: "Delete account" }).click();
		await expect(section.getByText("It cannot be undone.")).toBeVisible();
		await section.getByRole("button", { name: "Keep it" }).click();
		await expect(section.getByText("It cannot be undone.")).toBeHidden();
	});

	await test.step("a wrong password changes nothing", async () => {
		await section.getByRole("button", { name: "Delete account" }).click();
		await section.getByLabel("Your password").fill("not-the-password");
		await section.getByRole("button", { name: "Delete my account" }).click();
		await expect(section.getByRole("alert")).toHaveText("That password is not right.");
		await device.reload({ waitUntil: "networkidle" });
		await expect(device.getByRole("heading", { name: "Your account" })).toBeVisible();
	});

	await test.step("the right one deletes it, and the page says so", async () => {
		await section.getByRole("button", { name: "Delete account" }).click();
		await section.getByLabel("Your password").fill(PASSWORD);
		await section.getByRole("button", { name: "Delete my account" }).click();
		await expect(device.getByRole("heading", { name: "Your account is deleted" })).toBeVisible();
		await expect(device.getByRole("status")).toContainText("delete your account in each of them");
	});

	await test.step("nothing is left to sign in to", async () => {
		await device.getByRole("link", { name: "Go to sign-in" }).click();
		await expect(device).toHaveURL(/\/login/);
		await device.getByLabel("Email").fill(email);
		await device.getByLabel("Password").fill(PASSWORD);
		await device.getByRole("button", { name: "Sign in" }).click();
		await expect(device.getByRole("alert")).toBeVisible();
		await device.goto("/account", { waitUntil: "networkidle" });
		await expect(device).toHaveURL(/\/login/);
	});

	await device.context().close();
	expect(problems).toEqual([]);
});

test("an account with no password types its address instead", async ({ page, baseURL }) => {
	const device = await newDevice(page, baseURL);
	const problems = await watch(device);
	const email = address("no-password");
	await signUpWithNoPassword(device, "Katherine Johnson", email);
	await device.goto("/account", { waitUntil: "networkidle" });

	const section = device.getByRole("region", { name: "Delete account" });
	const confirm = section.getByLabel("Type your email address to confirm");

	await test.step("another address changes nothing", async () => {
		await section.getByRole("button", { name: "Delete account" }).click();
		await expect(section.getByLabel("Your password")).toBeHidden();
		await confirm.fill("someone-else@example.com");
		await section.getByRole("button", { name: "Delete my account" }).click();
		await expect(section.getByRole("alert")).toHaveText("That is not the address of this account.");
		await device.reload({ waitUntil: "networkidle" });
		await expect(device.getByRole("heading", { name: "Your account" })).toBeVisible();
	});

	await test.step("its own deletes it, however it is written", async () => {
		await section.getByRole("button", { name: "Delete account" }).click();
		await confirm.fill(email.toUpperCase());
		await section.getByRole("button", { name: "Delete my account" }).click();
		await expect(device.getByRole("heading", { name: "Your account is deleted" })).toBeVisible();
	});

	await device.context().close();
	expect(problems).toEqual([]);
});

test("the only owner of a workspace is told which one to see to, before any password", async ({
	page,
	baseURL,
}) => {
	const device = await newDevice(page, baseURL);
	const problems = await watch(device);
	await signUp(device, "Grace Hopper", address("owner"));
	await expect(device.getByRole("heading", { name: "Your account" })).toBeVisible();
	const slug = await makeWorkspace(device, "Only Mine");
	const deletions: string[] = [];
	device.on("request", (request) => {
		if (request.url().endsWith("/account/delete")) deletions.push(request.method());
	});

	await device.goto("/account", { waitUntil: "networkidle" });
	const section = device.getByRole("region", { name: "Delete account" });
	// The card is marked for what it does before anyone presses anything.
	await expect(section.getByText("Cannot be undone")).toBeVisible();
	const opener = section.getByRole("button", { name: "Delete account" });
	await opener.click();

	// They used to give their password to find this out.
	await expect(section.getByText("This account cannot be deleted yet.")).toBeVisible();
	await expect(
		section.getByText(
			"You are the only owner of Only Mine. Make someone else an owner, or delete it, first.",
		),
	).toBeVisible();
	await expect(section.getByLabel("Your password")).toHaveCount(0);
	await expect(section.getByRole("button", { name: "Delete my account" })).toHaveCount(0);
	await expect(section.getByRole("link", { name: "Open Only Mine" })).toHaveAttribute(
		"href",
		`/workspaces/${slug}`,
	);

	await section.getByRole("button", { name: "Close" }).click();
	await expect(section.getByText("This account cannot be deleted yet.")).toHaveCount(0);
	await expect(opener).toBeFocused();
	expect(deletions).toEqual([]);

	await test.step("once the workspace has gone, the same button asks for the password", async () => {
		await opener.click();
		await section.getByRole("link", { name: "Open Only Mine" }).click();
		await expect(device.getByRole("heading", { name: "Only Mine", exact: true })).toBeVisible();
		await device.getByLabel("Type its name to confirm").fill("Only Mine");
		await device.getByRole("button", { name: "Delete workspace" }).click();
		await expect(device.getByRole("heading", { name: "Your workspaces" })).toBeVisible();

		await device.goto("/account", { waitUntil: "networkidle" });
		await opener.click();
		await expect(section.getByLabel("Your password")).toBeFocused();
		await expect(section.getByText("This account cannot be deleted yet.")).toHaveCount(0);
		await section.getByRole("button", { name: "Keep it" }).click();
	});

	await device.reload({ waitUntil: "networkidle" });
	await expect(device.getByRole("heading", { name: "Your account" })).toBeVisible();

	await device.context().close();
	expect(problems).toEqual([]);
});
