import { expect, type Page, test } from "@playwright/test";

// A page's policy can only be judged in a browser. A script it blocks leaves a page that looks right
// and does nothing, and the Worker tests see the same HTML either way.

const VIOLATION = "Policy violation:";

/** Everything the browser refused or that threw, from here on. */
async function watch(page: Page): Promise<string[]> {
	const problems: string[] = [];
	page.on("pageerror", (error) => problems.push(error.message));
	page.on("console", (message) => {
		if (message.text().startsWith(VIOLATION)) problems.push(message.text());
	});
	await page.addInitScript((prefix) => {
		document.addEventListener("securitypolicyviolation", (event) => {
			console.error(`${prefix} ${event.violatedDirective} blocked ${event.blockedURI}`);
		});
	}, VIOLATION);
	return problems;
}

for (const path of ["/", "/login", "/signup", "/forgot-password", "/does-not-exist"]) {
	test(`${path} loads with nothing refused`, async ({ page }) => {
		const problems = await watch(page);
		await page.goto(path, { waitUntil: "networkidle" });
		await expect(page.locator("main")).toBeVisible();
		expect(problems).toEqual([]);
	});
}

test("a form works without leaving the page", async ({ page }) => {
	const problems = await watch(page);
	await page.goto("/login", { waitUntil: "networkidle" });
	await page.getByLabel("Email").fill("nobody@example.com");
	await page.getByLabel("Password").fill("not-the-password");
	await page.getByRole("button", { name: "Sign in" }).click();

	await expect(page.getByRole("alert")).toBeVisible();
	// A page whose scripts were blocked would have sent the form the browser's way instead.
	expect(new URL(page.url()).search).toBe("");
	expect(problems).toEqual([]);
});

test("a link loads the next page's code in the same document", async ({ page }) => {
	const problems = await watch(page);
	await page.goto("/login", { waitUntil: "networkidle" });
	await page.evaluate(() => {
		document.documentElement.dataset.sameDocument = "yes";
	});
	await page.getByRole("link", { name: "Create an account" }).click();

	await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
	await expect(page.locator("html")).toHaveAttribute("data-same-document", "yes");
	expect(problems).toEqual([]);
});
