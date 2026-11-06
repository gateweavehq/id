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

test("the only owner of a workspace is told which one to see to", async ({ page, baseURL }) => {
	const device = await newDevice(page, baseURL);
	const problems = await watch(device);
	await signUp(device, "Grace Hopper", address("owner"));
	await expect(device.getByRole("heading", { name: "Your account" })).toBeVisible();
	await makeWorkspace(device, "Only Mine");

	await device.goto("/account", { waitUntil: "networkidle" });
	const section = device.getByRole("region", { name: "Delete account" });
	await section.getByRole("button", { name: "Delete account" }).click();
	await section.getByLabel("Your password").fill(PASSWORD);
	await section.getByRole("button", { name: "Delete my account" }).click();
	await expect(section.getByRole("alert")).toContainText("Only Mine");

	await device.reload({ waitUntil: "networkidle" });
	await expect(device.getByRole("heading", { name: "Your account" })).toBeVisible();

	await device.context().close();
	expect(problems).toEqual([]);
});
