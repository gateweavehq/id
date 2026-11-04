import { expect, test } from "@playwright/test";
import { watch } from "./helpers";

// The Worker tests cover what ID does with GitHub's answer. This covers the trip itself: leaving for
// another site and coming back is what a page's policy and a cookie's SameSite can break.

test("going to GitHub and choosing not to agree comes back explained", async ({ page }) => {
	const problems = await watch(page);
	let asked: URL | undefined;
	// GitHub's side of it: sends the browser back the way it does when someone presses Cancel.
	await page.route("https://github.com/**", (route) => {
		asked = new URL(route.request().url());
		const back = new URL(asked.searchParams.get("redirect_uri") ?? "");
		back.searchParams.set("error", "access_denied");
		back.searchParams.set("state", asked.searchParams.get("state") ?? "");
		return route.fulfill({ status: 302, headers: { location: back.href } });
	});

	await page.goto("/login?redirect=/welcome", { waitUntil: "networkidle" });
	await page.getByRole("button", { name: "Continue with GitHub" }).click();

	await expect(page.getByRole("alert")).toHaveText("You chose not to sign in with GitHub.");
	expect(asked?.pathname).toBe("/login/oauth/authorize");
	expect(asked?.searchParams.get("scope")).toBe("user:email");
	// Where they were headed is still ahead of them.
	expect(new URL(page.url()).searchParams.get("redirect")).toBe("/welcome");
	expect(problems).toEqual([]);
});

test("a refusal goes away once someone tries the form", async ({ page }) => {
	await page.goto("/login?error=EMAIL_NOT_VERIFIED", { waitUntil: "networkidle" });
	await expect(page.getByRole("alert")).toContainText("verified email address");

	await page.getByLabel("Email").fill("nobody@example.com");
	await page.getByLabel("Password").fill("not-the-password");
	await page.getByRole("button", { name: "Sign in" }).click();

	await expect(page.getByRole("alert")).toHaveCount(1);
	await expect(page.getByRole("alert")).not.toContainText("verified email address");
});
