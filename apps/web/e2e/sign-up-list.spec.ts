import { expect, test } from "@playwright/test";
import { PERSON } from "./fixtures";
import { signIn, watch } from "./helpers";
import { address, clientAddress } from "./people";

// The owner's list of who may make an account while sign-up is closed. What the server holds to is in
// test/deployment.test.ts; sign-up stays open here, as in deployment.spec.ts, so only the page is tried.

test.beforeEach(async ({ context }) => {
	await context.setExtraHTTPHeaders({ "cf-connecting-ip": clientAddress() });
});

test("the owner adds, finds and removes entries on the list", async ({ page }) => {
	const problems = await watch(page);
	await signIn(page, PERSON.email, PERSON.password);
	await page.goto("/server", { waitUntil: "networkidle" });
	await expect(page.getByRole("heading", { name: "Who is on the list" })).toBeVisible();

	const listed = address("listed");
	const domain = `@${crypto.randomUUID().slice(0, 8)}.example.org`;
	await page.getByLabel("Address or @domain").fill(listed.toUpperCase());
	await page.getByLabel("Note, if you like").fill("from the waitlist");
	await page.getByRole("button", { name: "Add to the list" }).click();
	await expect(page.getByRole("status").filter({ hasText: "is on the list." })).toContainText(
		listed,
	);
	await page.getByLabel("Address or @domain").fill(domain);
	await page.getByRole("button", { name: "Add to the list" }).click();

	const list = page.getByRole("list", { name: "The list" });
	await expect(list).toContainText(listed);
	await expect(list).toContainText("from the waitlist");
	await expect(list).toContainText("No account yet");
	await expect(list).toContainText("No account at this domain yet");

	await page.getByLabel("Search the list").fill("waitlist");
	await expect(list.getByRole("listitem")).toHaveCount(1);
	await expect(list).toContainText(listed);
	await page.getByLabel("Search the list").fill("");

	// Words that are not an address are refused in words, and add nothing.
	await page.getByLabel("Address or @domain").fill("everyone");
	await page.getByRole("button", { name: "Add to the list" }).click();
	await expect(page.getByRole("alert")).toContainText("Enter an email address");

	await page.getByRole("button", { name: `Remove ${listed} from the list` }).click();
	await expect(page.getByText(listed)).toHaveCount(0);
	await page.getByRole("button", { name: `Remove ${domain} from the list` }).click();
	await expect(page.getByRole("list", { name: "The list" })).toHaveCount(0);
	expect(problems).toEqual([]);
});
