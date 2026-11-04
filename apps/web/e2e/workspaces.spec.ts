import { expect, type Page, test } from "@playwright/test";
import { codeSentSince, linkSentSince, watch } from "./helpers";

// A workspace from making it to deleting it, as two people on real pages. The Worker tests cover the
// rules; this covers that the pages keep to them, which only a browser can tell.

const PASSWORD = "a-long-password-for-tests";

/** No group of six digits in it, which is what a code in an email looks like. */
function address(who: string) {
	return `${who}-${crypto.randomUUID()}@example.com`;
}

function slug() {
	return `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

let clients = 0;

/** Three sign-ins in ten seconds is all one address gets, and tests run side by side. */
function clientAddress() {
	return `192.0.${test.info().workerIndex + 1}.${++clients}`;
}

test.beforeEach(async ({ context }) => {
	await context.setExtraHTTPHeaders({ "cf-connecting-ip": clientAddress() });
});

/** Someone else, on a device of their own. */
async function newDevice(page: Page, baseURL: string | undefined) {
	const context = await page
		.context()
		.browser()
		?.newContext({
			baseURL,
			extraHTTPHeaders: { "cf-connecting-ip": clientAddress() },
		});
	if (!context) throw new Error("There is no browser to open another device in");
	return context.newPage();
}

async function signUp(page: Page, name: string, email: string) {
	const since = Date.now() - 1000;
	await page.goto("/signup", { waitUntil: "networkidle" });
	await page.getByLabel("Name").fill(name);
	await page.getByLabel("Email").fill(email);
	await page.getByRole("button", { name: "Send me a code" }).click();
	await expect(page.getByRole("heading", { name: "Enter the code" })).toBeVisible();
	await page.getByLabel("Code").fill(await codeSentSince(since, email));
	await page.getByRole("button", { name: "Create account" }).click();
	await expect(page.getByRole("heading", { name: "Choose a password" })).toBeVisible();
	await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
	await page.getByLabel("Repeat it").fill(PASSWORD);
	await page.getByRole("button", { name: "Continue" }).click();
}

async function makeWorkspace(page: Page, name: string, address = slug()) {
	await page.goto("/workspaces", { waitUntil: "networkidle" });
	await page.getByLabel("Name").fill(name);
	await page.getByLabel("Address").fill(address);
	await page.getByRole("button", { name: "Make workspace" }).click();
	await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
	return address;
}

test("from making a workspace to someone new joining, working in it and leaving", async ({
	page,
	baseURL,
}) => {
	const problems = await watch(page);
	const adaEmail = address("ada");
	const bobEmail = address("bob");
	const name = `Acme ${Date.now()}`;
	const bob = await newDevice(page, baseURL);
	const bobProblems = await watch(bob);

	await test.step("reach workspaces from the account page", async () => {
		await signUp(page, "Ada", adaEmail);
		await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
		await page.getByRole("link", { name: "Open workspaces" }).click();
		await expect(page.getByRole("heading", { name: "Workspaces", exact: true })).toBeVisible();
		await expect(page.getByText("You are not in a workspace yet")).toBeVisible();
	});

	const workspaceSlug =
		await test.step("make one, with the address following the name", async () => {
			await page.getByLabel("Name").fill("Çay & Kahve");
			await expect(page.getByLabel("Address")).toHaveValue("cay-kahve");
			await page.getByLabel("Name").fill("");
			return makeWorkspace(page, name);
		});

	await test.step("a name with a link is refused on the page", async () => {
		await page.getByLabel("Workspace name").fill("Win at https://evil.test");
		await page.getByRole("button", { name: "Save" }).click();
		await expect(page.getByRole("alert")).toHaveText("A name cannot hold a link.");
		await page.getByLabel("Workspace name").fill(name);
	});

	const link = await test.step("invite an address with no account yet", async () => {
		const since = Date.now() - 1000;
		await page.getByLabel("Their email").fill(bobEmail);
		await page.getByRole("button", { name: "Send invitation" }).click();
		await expect(page.getByText(`An invitation is on its way to ${bobEmail}.`)).toBeVisible();
		await expect(page.getByRole("list", { name: "Open invitations" })).toContainText(bobEmail);
		return linkSentSince(since, bobEmail);
	});

	await test.step("the link leads through making an account, back to the invitation", async () => {
		await bob.goto(link, { waitUntil: "networkidle" });
		await expect(bob.getByRole("heading", { name: "Sign in to Gateweave ID" })).toBeVisible();
		await expect(bob.getByLabel("Email")).toHaveValue(bobEmail);

		await bob.getByRole("link", { name: "Create an account" }).click();
		await expect(bob.getByRole("heading", { name: "Create your account" })).toBeVisible();
		await expect(bob.getByLabel("Email")).toHaveValue(bobEmail);

		const since = Date.now() - 1000;
		await bob.getByLabel("Name").fill("Bob");
		await bob.getByRole("button", { name: "Send me a code" }).click();
		await expect(bob.getByRole("heading", { name: "Enter the code" })).toBeVisible();
		await bob.getByLabel("Code").fill(await codeSentSince(since, bobEmail));
		await bob.getByRole("button", { name: "Create account" }).click();
		await expect(bob.getByRole("heading", { name: "Choose a password" })).toBeVisible();
		await bob.getByLabel("Password", { exact: true }).fill(PASSWORD);
		await bob.getByLabel("Repeat it").fill(PASSWORD);
		await bob.getByRole("button", { name: "Continue" }).click();

		await expect(bob.getByRole("heading", { name: "You have been invited" })).toBeVisible();
		await expect(bob.getByText(name)).toBeVisible();
		await expect(bob.getByText(adaEmail)).toBeVisible();
	});

	await test.step("joining lists the workspace", async () => {
		await bob.getByRole("button", { name: "Join workspace" }).click();
		await expect(bob.getByRole("heading", { name: "Your workspaces" })).toBeVisible();
		await bob.getByRole("link", { name }).click();
		await expect(bob.getByRole("heading", { name, exact: true })).toBeVisible();
	});

	await test.step("a plain member is shown nothing they cannot do", async () => {
		await expect(bob.getByRole("region", { name: "Members" })).toContainText(adaEmail);
		await expect(bob.getByRole("button", { name: /^Remove/ })).toHaveCount(0);
		await expect(bob.getByRole("combobox")).toHaveCount(0);
		await expect(bob.getByRole("heading", { name: "Invite someone" })).toHaveCount(0);
		await expect(bob.getByRole("heading", { name: "Delete this workspace" })).toHaveCount(0);
		await expect(bob.getByLabel("Workspace name")).toHaveCount(0);
	});

	await test.step("the last owner cannot leave", async () => {
		await page.reload({ waitUntil: "networkidle" });
		await page.getByRole("button", { name: "Leave", exact: true }).click();
		await page.getByRole("button", { name: `Yes, leave ${name}` }).click();
		await expect(page.getByRole("alert")).toContainText("A workspace needs an owner");
	});

	await test.step("an owner makes someone an admin, and they see more", async () => {
		await expect(page.getByRole("region", { name: "Members" })).toContainText(bobEmail);
		await page.getByLabel("Role of Bob").selectOption("admin");
		await expect(page.getByLabel("Role of Bob")).toHaveValue("admin");
		await bob.reload({ waitUntil: "networkidle" });
		await expect(bob.getByRole("heading", { name: "Invite someone" })).toBeVisible();
		await expect(bob.getByLabel("Workspace name")).toBeVisible();
		await expect(bob.getByRole("heading", { name: "Delete this workspace" })).toHaveCount(0);
		// An admin has nothing to choose about an owner.
		await expect(bob.getByLabel("Role of Ada")).toHaveCount(0);
		await expect(bob.getByRole("button", { name: "Remove Ada" })).toHaveCount(0);
	});

	await test.step("each sees it in their activity, in their own words", async () => {
		await page.goto("/account", { waitUntil: "networkidle" });
		await expect(
			page.getByRole("region", { name: "Recent activity" }).getByText(`Made Bob admin of ${name}`),
		).toBeVisible();
		await bob.goto("/account", { waitUntil: "networkidle" });
		await expect(
			bob
				.getByRole("region", { name: "Recent activity" })
				.getByText(`Ada made you admin of ${name}`),
		).toBeVisible();
	});

	await test.step("someone who was removed finds what a stranger finds", async () => {
		await page.goto(`/workspaces/${workspaceSlug}`, { waitUntil: "networkidle" });
		await page.getByRole("button", { name: "Remove Bob" }).click();
		await page.getByRole("button", { name: "Yes, remove Bob" }).click();
		await expect(page.getByRole("region", { name: "Members" })).not.toContainText(bobEmail);
		await bob.goto(`/workspaces/${workspaceSlug}`, { waitUntil: "networkidle" });
		await expect(bob.getByRole("heading", { name: "That workspace is not here" })).toBeVisible();
		await bob.goto("/workspaces/no-such-workspace", { waitUntil: "networkidle" });
		await expect(bob.getByRole("heading", { name: "That workspace is not here" })).toBeVisible();
	});

	await test.step("deleting asks for the name, and then it is gone", async () => {
		await page.goto(`/workspaces/${workspaceSlug}`, { waitUntil: "networkidle" });
		const remove = page.getByRole("button", { name: "Delete workspace" });
		await expect(remove).toBeDisabled();
		await page.getByLabel("Type its name to confirm").fill(`${name} x`);
		await expect(remove).toBeDisabled();
		await page.getByLabel("Type its name to confirm").fill(name);
		await remove.click();
		await expect(page.getByRole("heading", { name: "Your workspaces" })).toBeVisible();
		await expect(page.getByRole("link", { name })).toHaveCount(0);
	});

	expect(problems).toEqual([]);
	expect(bobProblems).toEqual([]);
	await bob.context().close();
});

test("an invitation for someone else says nothing, and says whose account this is", async ({
	page,
	baseURL,
}) => {
	const problems = await watch(page);
	const adaEmail = address("ada");
	const bobEmail = address("bob");
	const name = `Private ${Date.now()}`;
	const carol = await newDevice(page, baseURL);
	const carolEmail = address("carol");

	await signUp(page, "Ada", adaEmail);
	await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
	await makeWorkspace(page, name);
	const since = Date.now() - 1000;
	await page.getByLabel("Their email").fill(bobEmail);
	await page.getByRole("button", { name: "Send invitation" }).click();
	await expect(page.getByText(/is on its way/)).toBeVisible();
	const link = await linkSentSince(since, bobEmail);

	await signUp(carol, "Carol", carolEmail);
	await expect(carol.getByRole("heading", { name: "Your account" })).toBeVisible();
	await carol.goto(link, { waitUntil: "networkidle" });
	await expect(carol.getByRole("heading", { name: "That invitation is not here" })).toBeVisible();
	await expect(carol.getByText(carolEmail)).toBeVisible();
	await expect(carol.getByText(name)).toHaveCount(0);
	await expect(carol.getByText(adaEmail)).toHaveCount(0);
	await expect(carol.getByRole("button", { name: "Join workspace" })).toHaveCount(0);

	await test.step("an owner can withdraw it", async () => {
		await page.getByRole("button", { name: `Withdraw the invitation to ${bobEmail}` }).click();
		await expect(page.getByRole("list", { name: "Open invitations" })).toHaveCount(0);
	});

	expect(problems).toEqual([]);
	await carol.context().close();
});

test("fits a phone, and stays usable with long names", async ({ page }) => {
	const email = address("long");
	await page.setViewportSize({ width: 360, height: 780 });
	await signUp(page, "Someone with a rather long name indeed, as people have", email);
	await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
	await makeWorkspace(page, "A workspace with a name as long as it may be, x");

	await page.getByLabel("Their email").fill(address("someone-with-a-long-address"));
	await page.getByRole("button", { name: "Send invitation" }).click();
	await expect(page.getByRole("list", { name: "Open invitations" })).toBeVisible();

	const overflow = () =>
		page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
	expect(await overflow()).toBeLessThanOrEqual(0);

	await page.goto("/workspaces", { waitUntil: "networkidle" });
	expect(await overflow()).toBeLessThanOrEqual(0);
});

test("asks a person who is not signed in to sign in, and takes them back", async ({ page }) => {
	const email = address("back");
	await signUp(page, "Back", email);
	await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
	const workspace = await makeWorkspace(page, `Back ${Date.now()}`);
	await page.context().clearCookies();

	await page.goto(`/workspaces/${workspace}`, { waitUntil: "networkidle" });
	await expect(page).toHaveURL(/\/login\?redirect=/);
	await signInWithoutLanding(page, email);
	await expect(page).toHaveURL(new RegExp(`/workspaces/${workspace}$`));
});

async function signInWithoutLanding(page: Page, email: string) {
	await page.getByLabel("Email").fill(email);
	await page.getByLabel("Password").fill(PASSWORD);
	await page.getByRole("button", { name: "Sign in" }).click();
}
