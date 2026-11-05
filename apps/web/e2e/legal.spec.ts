import { expect, test } from "@playwright/test";
import { watch } from "./helpers";

// The end-to-end build sets the addresses (vite.config.ts). What the server sends is in
// test/legal-links.test.ts: this is what stays once the browser moves between pages on its own.

test("the legal pages stay linked from page to page", async ({ page }) => {
	const problems = await watch(page);
	await page.goto("/login", { waitUntil: "networkidle" });
	await page.getByRole("link", { name: "Create an account" }).click();
	await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();

	const legal = page.getByRole("navigation", { name: "Legal" });
	for (const [words, address] of [
		["Legal notice", "https://legal.example/notice"],
		["Privacy", "https://legal.example/privacy"],
		["Terms", "https://legal.example/terms"],
	] as const) {
		await expect(legal.getByRole("link", { name: words, exact: true })).toHaveAttribute(
			"href",
			address,
		);
	}
	expect(problems).toEqual([]);
});
