import { expect, type Page, test } from "@playwright/test";
import {
	addAuthenticator,
	addPasskey,
	holdUntilLetGo,
	passkeyAnswersSent,
	passkeyCeremonyAsked,
	passkeySignIn,
	pressSignOut,
	signOut,
	signUpWithoutAPassword,
	watchOffers,
	withoutTheOfferInTheEmailField,
} from "./authenticator";
import { watch } from "./helpers";

// Passkeys with Chromium's own WebAuthn. `test/passkeys.test.ts` holds what the server accepts and
// refuses. This covers what only a browser shows: that the pages take someone through the ceremony,
// that the browser agrees to the options, and that no policy gets in the way.

const PASSWORD = "a-long-password-for-tests";

let clients = 0;

test.beforeEach(async ({ context }, testInfo) => {
	// Sign-ins are limited per address, and tests run side by side.
	await context.setExtraHTTPHeaders({
		"cf-connecting-ip": `198.51.${testInfo.workerIndex + 1}.${++clients}`,
	});
});

async function toAccount(page: Page) {
	await page.goto("/account", { waitUntil: "networkidle" });
	await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
}

test("from adding a passkey to signing in with it", async ({ page }) => {
	const problems = await watch(page);
	await withoutTheOfferInTheEmailField(page);
	await addAuthenticator(page);
	await signUpWithoutAPassword(page);
	await toAccount(page);

	const passkeys = await addPasskey(page);

	await test.step("it is named after the device, and can be renamed", async () => {
		const row = passkeys.getByRole("listitem");
		await expect(row.getByText(/Chrome|Headless/)).toBeVisible();
		await row.getByRole("button", { name: "Rename" }).click();
		await row.getByLabel("Name").fill("Work laptop");
		await row.getByRole("button", { name: "Save" }).click();
		await expect(row.getByText("Work laptop")).toBeVisible();
		await page.reload({ waitUntil: "networkidle" });
		await expect(passkeys.getByText("Work laptop")).toBeVisible();
	});

	await test.step("it signs in, with no address and no password", async () => {
		await signOut(page);
		await page.waitForLoadState("networkidle");
		const signedIn = passkeySignIn(page);
		await page.getByRole("button", { name: "Use a passkey" }).click();
		await signedIn;
		await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
		await page.reload({ waitUntil: "networkidle" });
		await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
	});

	expect(problems).toEqual([]);
});

test("the browser's offer in the email field signs someone in", async ({ page }) => {
	const problems = await watch(page);
	await addAuthenticator(page);
	await signUpWithoutAPassword(page);
	await toAccount(page);
	await addPasskey(page);

	const signedIn = passkeySignIn(page);
	await pressSignOut(page);
	await signedIn;

	await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
	await page.reload({ waitUntil: "networkidle" });
	await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
	expect(problems).toEqual([]);
});

test("the browser's offer in the email field does not get in the way of a password", async ({
	page,
}) => {
	const problems = await watch(page);
	// It has no passkey to answer with, so the offer keeps waiting.
	await addAuthenticator(page);
	const email = await signUpWithoutAPassword(page);
	await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
	await page.getByLabel("Repeat it").fill(PASSWORD);
	await page.getByRole("button", { name: "Continue" }).click();
	await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();

	const offered = passkeyCeremonyAsked(page);
	await signOut(page);
	await offered;

	await expect(page.getByLabel("Email")).toHaveAttribute("autocomplete", "email webauthn");
	await page.getByLabel("Email").fill(email);
	await page.getByLabel("Password").fill(PASSWORD);
	await page.getByRole("button", { name: "Sign in" }).click();

	await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
	expect(problems).toEqual([]);
});

test("leaving the sign-in page ends the browser's offer in the email field", async ({ page }) => {
	const problems = await watch(page);
	// It has no passkey to answer with, so the offer keeps waiting.
	await addAuthenticator(page);
	await page.addInitScript(() => {
		const ask = navigator.credentials.get.bind(navigator.credentials);
		navigator.credentials.get = (options) => {
			if (options?.mediation === "conditional") Reflect.set(window, "offer", options.signal);
			return ask(options);
		};
	});
	const offerEnded = () =>
		page.evaluate(() => (Reflect.get(window, "offer") as AbortSignal | undefined)?.aborted);

	const offered = passkeyCeremonyAsked(page);
	await page.goto("/login", { waitUntil: "networkidle" });
	await offered;
	await expect.poll(offerEnded).toBe(false);

	// The router moves within the page, where a browser would keep the offer going by itself.
	await page.getByRole("link", { name: "Create an account" }).click();
	await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();

	await expect.poll(offerEnded).toBe(true);
	expect(problems).toEqual([]);
});

// One sign-in per page: whatever starts one ends the offer, and nothing else starts until it has
// failed. `oidc.spec.ts` has what goes wrong otherwise, on the way to an app.

/** Someone with a password and a passkey, signed in. */
async function personWithBoth(page: Page) {
	const email = await signUpWithoutAPassword(page);
	await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
	await page.getByLabel("Repeat it").fill(PASSWORD);
	await page.getByRole("button", { name: "Continue" }).click();
	await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
	await addPasskey(page);
	return email;
}

test("sending a password ends the offer in the email field, and no passkey answer follows", async ({
	page,
}) => {
	const problems = await watch(page);
	const offers = await watchOffers(page);
	const authenticator = await addAuthenticator(page);
	const email = await personWithBoth(page);
	const sent = passkeyAnswersSent(page);
	// The offer waits, as it does for someone who has not chosen from the list.
	await authenticator.setAnswering(false);
	await signOut(page);
	await expect.poll(offers.waiting).toBe(true);
	const password = await holdUntilLetGo(page, "**/api/auth/sign-in/email");

	await page.getByLabel("Email").fill(email);
	await page.getByLabel("Password").fill(PASSWORD);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();

	// With the password still on its way, the offer is over and nothing else can be pressed.
	await expect.poll(() => password.seen.length).toBe(1);
	await expect.poll(offers.waiting).toBe(false);
	await expect(page.getByRole("button", { name: "Use a passkey" })).toBeDisabled();
	await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeDisabled();
	await authenticator.setAnswering(true);
	password.letGo();

	await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
	expect(sent).toEqual([]);
	expect(password.seen).toHaveLength(1);
	expect(problems).toEqual([]);
});

test("a wrong password brings the offer in the email field back, and the buttons", async ({
	page,
}) => {
	const problems = await watch(page);
	const offers = await watchOffers(page);
	// It has no passkey to answer with, so each offer keeps waiting.
	await addAuthenticator(page);
	await page.goto("/login", { waitUntil: "networkidle" });
	await expect.poll(offers.waiting).toBe(true);
	const before = await offers.made();

	await page.getByLabel("Email").fill("nobody@example.com");
	await page.getByLabel("Password").fill("not-the-password");
	await page.getByRole("button", { name: "Sign in", exact: true }).click();

	await expect(page.getByRole("alert")).toBeVisible();
	// The one from before ended when the password left, and there is a new one now.
	await expect.poll(offers.made).toBeGreaterThan(before);
	await expect.poll(offers.waiting).toBe(true);
	await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
	await expect(page.getByRole("button", { name: "Use a passkey" })).toBeEnabled();
	await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeEnabled();
	expect(problems).toEqual([]);
});

test("a page that is leaving for GitHub stays out of the way, until the browser brings it back", async ({
	page,
}) => {
	const problems = await watch(page);
	const offers = await watchOffers(page);
	// It has no passkey to answer with, so each offer keeps waiting.
	await addAuthenticator(page);
	// The browser sets off for GitHub and gets an answer with no page in it, so the one that pressed
	// the button still shows, as it does while a real answer is on its way. A browser's tools cannot
	// reach into a page for that long, and they can into this one.
	await page.route("https://github.com/**", (route) => route.fulfill({ status: 204 }));
	const left = page.waitForResponse((response) => response.url().startsWith("https://github.com/"));
	await page.goto("/login", { waitUntil: "networkidle" });
	await expect.poll(offers.waiting).toBe(true);
	const before = await offers.made();
	const buttons = ["Continue with GitHub", "Use a passkey", "Sign in"].map((name) =>
		page.getByRole("button", { name, exact: true }),
	);

	await page.getByRole("button", { name: "Continue with GitHub" }).click();
	await left;
	await expect.poll(offers.waiting).toBe(false);
	for (const button of buttons) await expect(button).toBeDisabled();

	// What a browser tells a page it has kept and shows again, when someone goes back to it. These
	// tests' browser keeps no pages, so nothing else here can say it.
	await page.evaluate(() => {
		window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
	});

	for (const button of buttons) await expect(button).toBeEnabled();
	await expect.poll(offers.made).toBeGreaterThan(before);
	await expect.poll(offers.waiting).toBe(true);
	expect(problems).toEqual([]);
});

test("going back from GitHub finds a page that works, with the offer in the email field", async ({
	page,
}) => {
	const problems = await watch(page);
	const offers = await watchOffers(page);
	await addAuthenticator(page);
	await page.route("https://github.com/**", (route) =>
		route.fulfill({ contentType: "text/html", body: "<h1>GitHub</h1>" }),
	);
	await page.goto("/login", { waitUntil: "networkidle" });

	await page.getByRole("button", { name: "Continue with GitHub" }).click();
	await expect(page.getByRole("heading", { name: "GitHub" })).toBeVisible();
	await page.goBack({ waitUntil: "networkidle" });

	await expect(page.getByRole("heading", { name: "Sign in to Gateweave ID" })).toBeVisible();
	for (const name of ["Continue with GitHub", "Use a passkey", "Sign in"]) {
		await expect(page.getByRole("button", { name, exact: true })).toBeEnabled();
	}
	await expect.poll(offers.waiting).toBe(true);
	expect(problems).toEqual([]);
});

test("pressing the passkey button twice sends one answer", async ({ page }) => {
	const problems = await watch(page);
	await withoutTheOfferInTheEmailField(page);
	await addAuthenticator(page);
	await signUpWithoutAPassword(page);
	await toAccount(page);
	await addPasskey(page);
	await signOut(page);
	await page.waitForLoadState("networkidle");
	const sent = passkeyAnswersSent(page);
	// The first answer is still being checked when the second press comes.
	const answer = await holdUntilLetGo(page, "**/api/auth/passkey/verify-authentication");

	await page.getByRole("button", { name: "Use a passkey" }).evaluate((button: HTMLElement) => {
		button.click();
		button.click();
	});
	await expect.poll(() => answer.seen.length).toBe(1);
	await expect(page.getByRole("button", { name: "Use a passkey" })).toBeDisabled();
	await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeDisabled();
	answer.letGo();

	await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
	expect(sent).toHaveLength(1);
	expect(problems).toEqual([]);
});

test("a passkey that cannot reach the server says so, and leaves the page usable", async ({
	page,
}) => {
	await withoutTheOfferInTheEmailField(page);
	await addAuthenticator(page);
	await page.route("**/api/auth/passkey/generate-authenticate-options", (route) => route.abort());
	await page.goto("/login", { waitUntil: "networkidle" });

	await page.getByRole("button", { name: "Use a passkey" }).click();

	// In the page's words, and not the browser's "Failed to fetch".
	await expect(page.getByRole("alert")).toHaveText("Something went wrong");
	for (const name of ["Continue with GitHub", "Use a passkey", "Sign in"]) {
		await expect(page.getByRole("button", { name, exact: true })).toBeEnabled();
	}
});

test("someone who stopped the browser on its way to GitHub is told, and gets the page back", async ({
	page,
}) => {
	const problems = await watch(page);
	const offers = await watchOffers(page);
	// It has no passkey to answer with, so each offer keeps waiting.
	await addAuthenticator(page);
	// An answer with no page in it leaves the browser where it was, as pressing Stop does.
	await page.route("https://github.com/**", (route) => route.fulfill({ status: 204 }));
	await page.goto("/login", { waitUntil: "networkidle" });
	await expect.poll(offers.waiting).toBe(true);
	const made = await offers.made();
	const buttons = ["Continue with GitHub", "Use a passkey", "Sign in"].map((name) =>
		page.getByRole("button", { name, exact: true }),
	);
	const progress = page.getByRole("status");

	await page.getByRole("button", { name: "Continue with GitHub" }).click();
	await expect(progress).toHaveText("Taking you there…");
	for (const button of buttons) await expect(button).toBeDisabled();

	// Longer than leaving takes: the page says what to do, with its buttons still off.
	await expect(progress).toContainText("Still here? Reload the page to try again.");
	await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
	for (const button of buttons) await expect(button).toBeDisabled();

	// Nobody was signed in, so nothing came of it, and the page is given back by itself.
	for (const button of buttons) await expect(button).toBeEnabled({ timeout: 15_000 });
	await expect(progress).toHaveCount(0);
	await expect.poll(offers.made).toBeGreaterThan(made);
	await expect.poll(offers.waiting).toBe(true);
	expect(problems).toEqual([]);
});

test("an offer in the email field that got going late does not end the passkey button's own", async ({
	page,
}) => {
	const problems = await watch(page);
	// Nobody answers, so that the button's ceremony is still waiting when the offer's would start.
	const authenticator = await addAuthenticator(page);
	await authenticator.setAnswering(false);
	// The offer's request for its options is kept in the page until the button has asked the browser
	// for a passkey, so the offer's own ceremony would start after the button's.
	await page.addInitScript(() => {
		const asked: { offer: boolean; signal: AbortSignal | undefined }[] = [];
		Reflect.set(window, "asked", asked);
		let buttonAsked = () => {};
		const theButtonAsked = new Promise<void>((resolve) => {
			buttonAsked = resolve;
		});
		const ask = navigator.credentials.get.bind(navigator.credentials);
		navigator.credentials.get = (options) => {
			const offer = options?.mediation === "conditional";
			asked.push({ offer, signal: options?.signal });
			if (!offer) buttonAsked();
			return ask(options);
		};
		let pressed = false;
		document.addEventListener("click", () => (pressed = true), true);
		const send = window.fetch.bind(window);
		window.fetch = async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url.includes("/passkey/generate-authenticate-options") && !pressed) {
				await theButtonAsked;
				// Counted once they have arrived, which is when the offer's ceremony would start.
				const answer = await send(input, init);
				Reflect.set(
					window,
					"lateOptions",
					((Reflect.get(window, "lateOptions") as number) ?? 0) + 1,
				);
				return answer;
			}
			return send(input, init);
		};
	});
	await page.goto("/login", { waitUntil: "networkidle" });
	const late = () => page.evaluate(() => (Reflect.get(window, "lateOptions") as number) ?? 0);
	const ceremonies = () =>
		page.evaluate(() =>
			(Reflect.get(window, "asked") as { offer: boolean; signal: AbortSignal | undefined }[]).map(
				({ offer, signal }) => ({ offer, ended: signal?.aborted }),
			),
		);

	await page.getByRole("button", { name: "Use a passkey" }).click();
	await expect.poll(late).toBeGreaterThan(0);
	// The options have arrived. What is left before a ceremony starts is the page's own work, with
	// nothing more to wait for from outside.
	await page.waitForTimeout(500);

	expect(await ceremonies()).toEqual([{ offer: false, ended: false }]);
	expect(problems).toEqual([]);
});

test("someone cannot remove their last way to sign in, until they add another", async ({
	page,
}) => {
	const problems = await watch(page);
	await addAuthenticator(page);
	await signUpWithoutAPassword(page);
	await toAccount(page);
	const passkeys = await addPasskey(page);
	const row = passkeys.getByRole("listitem");

	// Removing a passkey takes a sign-in that used a second factor, and so far there is only the
	// sign-up code's. The page says so where the button would be.
	await expect(row.getByRole("button", { name: "Rename" })).toBeVisible();
	await expect(row.getByRole("button", { name: "Remove" })).toHaveCount(0);
	await expect(passkeys.getByText("then add or remove a passkey")).toBeVisible();
	// The authenticator answers the offer in the email field, which signs them back in.
	const signedIn = passkeySignIn(page);
	await pressSignOut(page);
	await signedIn;
	await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
	await expect(row).toHaveCount(1);

	await row.getByRole("button", { name: "Remove" }).click();
	await row.getByRole("button", { name: "Keep" }).click();
	await expect(row).toHaveCount(1);

	await row.getByRole("button", { name: "Remove" }).click();
	await row.getByRole("button", { name: "Remove" }).click();
	await expect(passkeys.getByRole("alert")).toContainText("your only way to sign in");
	await expect(row).toHaveCount(1);

	await page.getByRole("button", { name: "Add password" }).click();
	await page.getByLabel("New password").fill(PASSWORD);
	await page.getByLabel("Repeat it").fill(PASSWORD);
	await page.getByRole("button", { name: "Save password" }).click();
	await expect(page.getByText("Your password is set.")).toBeVisible();

	await row.getByRole("button", { name: "Remove" }).click();
	await row.getByRole("button", { name: "Remove" }).click();
	await expect(row).toHaveCount(0);
	await expect(passkeys.getByRole("alert")).toHaveCount(0);
	expect(problems).toEqual([]);
});

test("a browser that cannot use passkeys is not offered them", async ({ page }) => {
	const problems = await watch(page);
	await page.addInitScript(() => {
		Reflect.deleteProperty(window, "PublicKeyCredential");
	});
	await signUpWithoutAPassword(page);
	await toAccount(page);

	const passkeys = page.getByRole("region", { name: "Passkeys" });
	await expect(passkeys).toBeVisible();
	await expect(passkeys.getByRole("button", { name: "Add a passkey" })).toHaveCount(0);

	await signOut(page);
	await page.waitForLoadState("networkidle");
	await expect(page.getByRole("button", { name: "Use a passkey" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
	expect(problems).toEqual([]);
});

test("turning down adding a passkey is not an error", async ({ page }) => {
	const problems = await watch(page);
	await addAuthenticator(page, { userVerified: false });
	await signUpWithoutAPassword(page);
	await toAccount(page);
	const passkeys = page.getByRole("region", { name: "Passkeys" });
	const add = passkeys.getByRole("button", { name: "Add a passkey" });

	await add.click();

	await expect(add).toBeEnabled();
	await expect(passkeys.getByRole("alert")).toHaveCount(0);
	await expect(passkeys.getByRole("listitem")).toHaveCount(0);
	expect(problems).toEqual([]);
});

test("turning down signing in is not an error, and they can try again", async ({ page }) => {
	const problems = await watch(page);
	await withoutTheOfferInTheEmailField(page);
	const authenticator = await addAuthenticator(page);
	await signUpWithoutAPassword(page);
	await toAccount(page);
	await addPasskey(page);
	await signOut(page);
	await page.waitForLoadState("networkidle");
	const use = page.getByRole("button", { name: "Use a passkey" });

	await authenticator.setUserVerified(false);
	const asked = passkeyCeremonyAsked(page);
	await use.click();
	await asked;

	await expect(use).toBeEnabled();
	await expect(page.getByRole("alert")).toHaveCount(0);

	await authenticator.setUserVerified(true);
	await use.click();
	await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
	expect(problems).toEqual([]);
});
