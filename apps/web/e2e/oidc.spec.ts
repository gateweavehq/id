import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import * as oauth from "oauth4webapi";
import {
	addAuthenticator,
	addPasskey,
	passkeySignIn,
	signOut,
	signUpWithoutAPassword,
	withoutTheOfferInTheEmailField,
} from "./authenticator";
import { APP, PERSON } from "./fixtures";
import { codeSentSince, watch } from "./helpers";

// Signing in to an app, with a real OIDC client library for the app's server and real pages for
// everything between. `test/oidc.test.ts` covers the rules. This covers what only a browser shows: that
// the redirects are real, that the signed query survives the router and every page, and that nothing
// the pages do is against their policy.

const ISSUER = new URL("http://localhost:4732");
const PASSWORD = "a-long-password-for-tests";
const SCOPE = "openid profile email offline_access";

const registered = JSON.parse(
	readFileSync(resolve(import.meta.dirname, "../.wrangler/e2e-state/apps.json"), "utf8"),
) as Record<"normal" | "refusing", { clientId: string; clientSecret: string }>;

/** The address is http, which a client library refuses unless told this is on purpose. */
const onThisMachine = { [oauth.allowInsecureRequests]: true };

let clients = 0;

test.beforeEach(async ({ context }, testInfo) => {
	// Three sign-ins in ten seconds is all one address gets, and tests run side by side.
	await context.setExtraHTTPHeaders({
		"cf-connecting-ip": `203.0.${testInfo.workerIndex + 1}.${++clients}`,
	});
});

async function server() {
	const response = await oauth.discoveryRequest(ISSUER, { algorithm: "oidc", ...onThisMachine });
	return oauth.processDiscoveryResponse(ISSUER, response);
}

/** Sends the browser to ID the way an app would, and remembers what its server has to check. */
async function goToSignIn(
	page: Page,
	params: Record<string, string> = {},
	app: "normal" | "refusing" = "normal",
) {
	const as = await server();
	const state = params.state ?? oauth.generateRandomState();
	const nonce = oauth.generateRandomNonce();
	const verifier = oauth.generateRandomCodeVerifier();
	const url = new URL(as.authorization_endpoint ?? "");
	url.search = new URLSearchParams({
		client_id: registered[app].clientId,
		redirect_uri: APP.redirectUri,
		response_type: "code",
		scope: SCOPE,
		nonce,
		code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
		code_challenge_method: "S256",
		...params,
		state,
	}).toString();
	await page.goto(url.href, { waitUntil: "networkidle" });
	return { as, state, nonce, verifier };
}

type SignIn = Awaited<ReturnType<typeof goToSignIn>>;

async function expectBackAtTheApp(page: Page) {
	await expect(page.getByRole("heading", { name: "Back at the app" })).toBeVisible();
}

/** What an app's server does with where the browser came back: every check there is. */
async function finish(page: Page, { as, state, nonce, verifier }: SignIn) {
	await expectBackAtTheApp(page);
	const { clientId, clientSecret } = registered.normal;
	const client = { client_id: clientId };
	const params = oauth.validateAuthResponse(as, client, new URL(page.url()), state);
	const response = await oauth.authorizationCodeGrantRequest(
		as,
		client,
		oauth.ClientSecretBasic(clientSecret),
		params,
		APP.redirectUri,
		verifier,
		onThisMachine,
	);
	const tokens = await oauth.processAuthorizationCodeResponse(as, client, response, {
		expectedNonce: nonce,
		requireIdToken: true,
	});
	const claims = oauth.getValidatedIdTokenClaims(tokens);
	if (!claims) throw new Error("No ID token");
	return claims;
}

async function fillSignInForm(page: Page) {
	// The sign-up page has an email field too, which a test arriving from it would fill instead.
	await expect(page.getByRole("heading", { name: "Sign in to Gateweave ID" })).toBeVisible();
	await page.getByLabel("Email").fill(PERSON.email);
	await page.getByLabel("Password").fill(PERSON.password);
	await page.getByRole("button", { name: "Sign in" }).click();
}

/** Signs in on the way to the app, which leaves the browser with a session. */
async function signInToTheApp(page: Page) {
	const flow = await goToSignIn(page);
	await fillSignInForm(page);
	await expectBackAtTheApp(page);
	return flow;
}

test("someone new makes an account on the way to the app", async ({ page }) => {
	const problems = await watch(page);
	const email = `new-person-${Date.now()}@example.com`;
	const flow = await goToSignIn(page);
	await expect(page).toHaveURL(/\/login\?/);

	await page.getByRole("link", { name: "Create an account" }).click();
	const since = Date.now() - 1000;
	await page.getByLabel("Name").fill("Ada Lovelace");
	await page.getByLabel("Email").fill(email);
	await page.getByRole("button", { name: "Send me a code" }).click();
	await expect(page.getByRole("heading", { name: "Enter the code" })).toBeVisible();

	await page.getByLabel("Code").fill(await codeSentSince(since, email));
	await page.getByRole("button", { name: "Create account" }).click();

	// The app hears nothing until they have something to sign in with next time.
	await expect(page.getByRole("heading", { name: "Choose a password" })).toBeVisible();
	await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
	await page.getByLabel("Repeat it").fill(PASSWORD);
	await page.getByRole("button", { name: "Continue" }).click();

	const claims = await finish(page, flow);
	expect(claims.email).toBe(email);
	expect(claims.name).toBe("Ada Lovelace");
	expect(problems).toEqual([]);
});

/**
 * Holds back the document the provider's answer sent the browser to. The auth client has already
 * set off for it, so a page that went on to navigate by itself would have the time to do so here.
 */
async function holdBack(page: Page, url: string | RegExp) {
	await page.route(url, async (route) => {
		await new Promise((resolve) => setTimeout(resolve, 1500));
		await route.continue();
	});
}

/** Every address the page shows from now on, including ones the router moves it to. */
function addressesOf(page: Page) {
	const addresses: URL[] = [];
	page.on("framenavigated", (frame) => {
		if (frame === page.mainFrame()) addresses.push(new URL(frame.url()));
	});
	return addresses;
}

test("signing in leaves the way to the provider's answer alone", async ({ page }) => {
	await holdBack(page, `${APP.redirectUri}*`);
	const addresses = addressesOf(page);

	await goToSignIn(page);
	await fillSignInForm(page);
	await expectBackAtTheApp(page);

	expect(addresses.map((address) => address.pathname)).not.toContain("/account");
});

test("signing up leaves the way to the provider's answer alone", async ({ page }) => {
	const email = `held-back-${Date.now()}@example.com`;
	await holdBack(page, /\/welcome\?/);
	const addresses = addressesOf(page);

	await goToSignIn(page);
	await page.getByRole("link", { name: "Create an account" }).click();
	const since = Date.now() - 1000;
	await page.getByLabel("Name").fill("Grace Hopper");
	await page.getByLabel("Email").fill(email);
	await page.getByRole("button", { name: "Send me a code" }).click();
	await expect(page.getByRole("heading", { name: "Enter the code" })).toBeVisible();
	await page.getByLabel("Code").fill(await codeSentSince(since, email));
	await page.getByRole("button", { name: "Create account" }).click();
	await expect(page.getByRole("heading", { name: "Choose a password" })).toBeVisible();

	// The app's signed request is still in the address, on every step to this one.
	const welcome = addresses.filter((address) => address.pathname === "/welcome");
	expect(welcome.length).toBeGreaterThan(0);
	for (const address of welcome) expect(address.searchParams.has("sig")).toBe(true);
});

test("someone with an account signs in, and the request arrives as it left", async ({ page }) => {
	const problems = await watch(page);
	// Reads as a number, a boolean and JSON, none of which the signature would forgive.
	for (const state of ["1e5", "true", '{"a":1}']) {
		await page.context().clearCookies();
		const flow = await goToSignIn(page, { state });
		await expect(page).toHaveURL(/\/login\?/);
		await fillSignInForm(page);

		const claims = await finish(page, flow);
		expect(claims.email).toBe(PERSON.email);
		expect(new URL(page.url()).searchParams.get("state")).toBe(state);
	}
	expect(problems).toEqual([]);
});

test("someone signed in passes straight through", async ({ page }) => {
	await signInToTheApp(page);
	const flow = await goToSignIn(page);
	const claims = await finish(page, flow);
	expect(claims.email).toBe(PERSON.email);
});

test("an app asking to see nothing hears that nobody is signed in", async ({ page }) => {
	await goToSignIn(page, { prompt: "none" });
	await expectBackAtTheApp(page);
	expect(new URL(page.url()).searchParams.get("error")).toBe("login_required");
});

test("a request naming an address the app has not registered stops here, and says so", async ({
	page,
}) => {
	const problems = await watch(page);
	const elsewhere = { redirect_uri: "https://elsewhere.test/callback" };
	await goToSignIn(page, elsewhere);
	await expect(page).toHaveURL(//request-refused?/);
	await expect(page.getByRole("heading", { name: "This request was refused" })).toBeVisible();
	await expect(page.getByText("an address it has not registered")).toBeVisible();

	// Signed in, the sign-in page would have sent them on to their account without a word.
	await signInToTheApp(page);
	await goToSignIn(page, elsewhere);
	await expect(page).toHaveURL(//request-refused?/);
	await expect(page.getByText("an address it has not registered")).toBeVisible();
	expect(problems).toEqual([]);
});

test("an app can ask someone signed in to sign in again", async ({ page }) => {
	const problems = await watch(page);
	await signInToTheApp(page);

	const flow = await goToSignIn(page, { prompt: "login" });
	await expect(page).toHaveURL(/\/login\?/);
	await fillSignInForm(page);

	const claims = await finish(page, flow);
	expect(claims.email).toBe(PERSON.email);
	expect(problems).toEqual([]);
});

test("an app can ask for an account to be made, and an existing one will do", async ({ page }) => {
	const problems = await watch(page);
	const flow = await goToSignIn(page, { prompt: "create" });
	await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();

	await page.getByRole("link", { name: "Sign in" }).click();
	await fillSignInForm(page);

	const claims = await finish(page, flow);
	expect(claims.email).toBe(PERSON.email);
	expect(problems).toEqual([]);
});

test.describe("asking whether an app may", () => {
	test("allowing takes someone on to the app", async ({ page }) => {
		const problems = await watch(page);
		await signInToTheApp(page);

		const flow = await goToSignIn(page, { prompt: "consent" });
		await expect(
			page.getByRole("heading", { name: `Allow ${APP.name} to use your account?` }),
		).toBeVisible();
		await expect(page.getByText("See your email address")).toBeVisible();
		await expect(page.getByText(new URL(APP.redirectUri).host)).toBeVisible();
		await page.getByRole("button", { name: "Allow" }).click();

		const claims = await finish(page, flow);
		expect(claims.email).toBe(PERSON.email);
		expect(problems).toEqual([]);
	});

	test("denying tells the app so, and gives it no code", async ({ page }) => {
		const problems = await watch(page);
		await signInToTheApp(page);

		const { state } = await goToSignIn(page, { prompt: "consent" });
		await page.getByRole("button", { name: "Deny" }).click();

		await expectBackAtTheApp(page);
		const answer = new URL(page.url()).searchParams;
		expect(answer.get("error")).toBe("access_denied");
		expect(answer.get("state")).toBe(state);
		expect(answer.has("code")).toBe(false);
		expect(problems).toEqual([]);
	});
});

test.describe("signing in with a passkey on the way to an app", () => {
	/** Someone with nothing but a passkey, signed in with it. */
	async function personWithAPasskey(page: Page) {
		const authenticator = await addAuthenticator(page);
		const email = await signUpWithoutAPassword(page);
		await page.goto("/account", { waitUntil: "networkidle" });
		await addPasskey(page);
		return { email, authenticator };
	}

	test("carries on to the app", async ({ page }) => {
		const problems = await watch(page);
		await withoutTheOfferInTheEmailField(page);
		const { email } = await personWithAPasskey(page);
		await signOut(page);

		const flow = await goToSignIn(page);
		await expect(page).toHaveURL(/\/login\?/);
		await page.getByRole("button", { name: "Use a passkey" }).click();

		const claims = await finish(page, flow);
		expect(claims.email).toBe(email);
		expect(problems).toEqual([]);
	});

	test("leaves the way to the provider's answer alone", async ({ page }) => {
		await withoutTheOfferInTheEmailField(page);
		await personWithAPasskey(page);
		await signOut(page);
		await holdBack(page, `${APP.redirectUri}*`);
		const addresses = addressesOf(page);

		await goToSignIn(page);
		await page.getByRole("button", { name: "Use a passkey" }).click();
		await expectBackAtTheApp(page);

		expect(addresses.map((address) => address.pathname)).not.toContain("/account");
	});

	test("carries on to the app from the browser's offer in the email field", async ({ page }) => {
		const problems = await watch(page);
		const { email, authenticator } = await personWithAPasskey(page);
		// So that signing out stays signed out. It goes on waiting for the offer that page made.
		await authenticator.setAnswering(false);
		await signOut(page);
		await authenticator.setAnswering(true);

		const signedIn = passkeySignIn(page);
		const flow = await goToSignIn(page);
		await signedIn;

		const claims = await finish(page, flow);
		expect(claims.email).toBe(email);
		expect(problems).toEqual([]);
	});

	test("asks for no password when the app asked to see an account made", async ({ page }) => {
		const problems = await watch(page);
		await withoutTheOfferInTheEmailField(page);
		const { email } = await personWithAPasskey(page);

		const flow = await goToSignIn(page, { prompt: "create" });

		const claims = await finish(page, flow);
		expect(claims.email).toBe(email);
		expect(problems).toEqual([]);
	});

	test("does not get past an app that refuses them", async ({ page }) => {
		const problems = await watch(page);
		await withoutTheOfferInTheEmailField(page);
		await personWithAPasskey(page);
		await signOut(page);

		await goToSignIn(page, {}, "refusing");
		await expect(page).toHaveURL(/\/login\?/);
		await page.getByRole("button", { name: "Use a passkey" }).click();

		await expect(page.getByRole("heading", { name: "You do not have access" })).toBeVisible();
		await expect(page).toHaveURL(/\/no-access\?/);
		expect(new URL(page.url()).searchParams.has("code")).toBe(false);
		expect(problems).toEqual([]);
	});
});

test.describe("someone the app refuses", () => {
	async function refused(page: Page) {
		await goToSignIn(page, {}, "refusing");
		await expect(page).toHaveURL(/\/login\?/);
		await fillSignInForm(page);
		await expect(page.getByRole("heading", { name: "You do not have access" })).toBeVisible();
		await expect(page).toHaveURL(/\/no-access\?/);
	}

	test("is told so, and the app gets no code", async ({ page }) => {
		const problems = await watch(page);
		await refused(page);
		await expect(page.getByText(PERSON.email)).toBeVisible();
		expect(new URL(page.url()).searchParams.has("code")).toBe(false);
		expect(problems).toEqual([]);
	});

	test("can go back, and the app hears that nobody signed in", async ({ page }) => {
		await refused(page);
		await page.getByRole("button", { name: `Back to ${new URL(APP.redirectUri).host}` }).click();

		await expectBackAtTheApp(page);
		const answer = new URL(page.url()).searchParams;
		expect(answer.get("error")).toBe("access_denied");
		expect(answer.has("code")).toBe(false);
	});

	test("can use another account, which starts over signed out", async ({ page }) => {
		const problems = await watch(page);
		await refused(page);
		await page.getByRole("button", { name: "Use another account" }).click();

		await expect(page.getByRole("heading", { name: "Sign in to Gateweave ID" })).toBeVisible();
		await expect(page).toHaveURL(/\/login\?.*sig=/);
		const signedIn = await page.request.get("/api/auth/get-session");
		expect(await signedIn.json()).toBeNull();
		expect(problems).toEqual([]);
	});
});

test("a page whose signature no longer holds offers a way to start again", async ({ page }) => {
	const problems = await watch(page);
	const flow = await goToSignIn(page);

	// Tampering is what a page open too long looks like to the provider, without waiting ten minutes.
	const stale = new URL(page.url());
	stale.searchParams.set("exp", "1");
	await page.goto(stale.href, { waitUntil: "networkidle" });
	await fillSignInForm(page);
	await expect(page.getByRole("alert")).toContainText("open too long");

	await page.getByRole("link", { name: "Start again" }).click();
	await expect(page).toHaveURL(/\/login\?/);
	await fillSignInForm(page);

	const claims = await finish(page, flow);
	expect(claims.email).toBe(PERSON.email);
	expect(problems).toEqual([]);
});

test("coming back refused from GitHub keeps the way to the app", async ({ page }) => {
	const problems = await watch(page);
	// GitHub's side of it: sends the browser back the way it does when someone presses Cancel.
	await page.route("https://github.com/**", (route) => {
		const asked = new URL(route.request().url());
		const back = new URL(asked.searchParams.get("redirect_uri") ?? "");
		back.searchParams.set("error", "access_denied");
		back.searchParams.set("state", asked.searchParams.get("state") ?? "");
		return route.fulfill({ status: 302, headers: { location: back.href } });
	});
	const flow = await goToSignIn(page);

	await page.getByRole("button", { name: "Continue with GitHub" }).click();
	await expect(page.getByRole("alert")).toHaveText("You chose not to sign in with GitHub.");

	await fillSignInForm(page);
	const claims = await finish(page, flow);
	expect(claims.email).toBe(PERSON.email);
	expect(problems).toEqual([]);
});

test.describe("someone whose session is gone", () => {
	/** Reaches a page as someone signed in, then goes back to it signed out. */
	async function signedOutAt(page: Page, reach: () => Promise<unknown>, pageName: RegExp) {
		await reach();
		await expect(page).toHaveURL(pageName);
		const signedPage = page.url();
		await page.context().clearCookies();
		await page.goto(signedPage, { waitUntil: "networkidle" });
		await expect(page).toHaveURL(/\/login\?.*sig=/);
	}

	test("signs in on the way back to being asked", async ({ page }) => {
		await signedOutAt(
			page,
			async () => {
				await signInToTheApp(page);
				await goToSignIn(page, { prompt: "consent" });
			},
			/\/consent\?/,
		);
		await fillSignInForm(page);
		await expect(page.getByRole("button", { name: "Allow" })).toBeVisible();
	});

	test("signs in on the way back to being refused", async ({ page }) => {
		await signedOutAt(
			page,
			async () => {
				await goToSignIn(page, {}, "refusing");
				await fillSignInForm(page);
			},
			/\/no-access\?/,
		);
		await fillSignInForm(page);
		await expect(page.getByRole("heading", { name: "You do not have access" })).toBeVisible();
	});
});

test("someone refused can still leave once the page has been open too long", async ({ page }) => {
	const problems = await watch(page);
	await goToSignIn(page, {}, "refusing");
	await fillSignInForm(page);
	await expect(page).toHaveURL(/\/no-access\?/);

	const stale = new URL(page.url());
	stale.searchParams.set("exp", "1");
	await page.goto(stale.href, { waitUntil: "networkidle" });
	await page.getByRole("button", { name: "Use another account" }).click();

	await expect(page.getByRole("heading", { name: "Sign in to Gateweave ID" })).toBeVisible();
	const signedIn = await page.request.get("/api/auth/get-session");
	expect(await signedIn.json()).toBeNull();
	expect(problems).toEqual([]);
});
