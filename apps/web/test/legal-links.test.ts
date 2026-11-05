import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startId } from "./id-worker";

// The legal notice has to be easy to reach, and they are one deployment's own: a copy someone else
// runs must show none unless it sets its own. These read the HTML the server sends.

const origin = "https://id.test";
const PUBLIC_PAGES = [
	"/",
	"/login",
	"/signup",
	"/forgot-password",
	"/reset-password",
	"/two-factor",
	"/does-not-exist",
];

type Id = Awaited<ReturnType<typeof startId>>;

let clients = 0;

async function page(id: Id, path: string, cookie?: string) {
	const response = await id.fetch(`${origin}${path}`, {
		headers: { "cf-connecting-ip": `203.0.113.${++clients}`, ...(cookie && { cookie }) },
	});
	expect([200, 404]).toContain(response.status);
	return response.text();
}

function expectLinks(html: string) {
	for (const [words, address] of [
		["Legal notice", "https://legal.test/notice?from=id&amp;lang=en"],
		["Privacy", "https://legal.test/privacy"],
		["Terms", "https://legal.test/terms"],
	]) {
		const link = [...html.matchAll(/<a ([^>]*)>([^<]*)<\/a>/g)].find(
			([, attributes, text]) => text === words && attributes?.includes(`href="${address}"`),
		);
		expect(link?.[1], words).toContain('rel="noreferrer"');
		expect(link?.[1], words).toContain('target="_blank"');
	}
}

/** Someone with an account, signed in. */
async function signedIn(id: Id): Promise<string> {
	const email = `legal-${++clients}@example.com`;
	const headers = {
		origin,
		"cf-connecting-ip": `198.51.100.${clients}`,
		"content-type": "application/json",
	};
	await id.fetch(`${origin}/api/auth/email-otp/send-verification-otp`, {
		method: "POST",
		headers,
		body: JSON.stringify({ email, type: "sign-in" }),
	});
	let otp: string | undefined;
	for (let attempt = 0; attempt < 100 && !otp; attempt++) {
		const sent = (await id.emails()).find((message) => message.to === email);
		otp = /\b\d{6}\b/.exec(sent?.text ?? "")?.[0];
		if (!otp) await new Promise((resolve) => setTimeout(resolve, 50));
	}
	const entered = await id.fetch(`${origin}/api/auth/sign-in/email-otp`, {
		method: "POST",
		headers,
		body: JSON.stringify({ email, otp, name: "Ada" }),
	});
	expect(entered.status).toBe(200);
	return entered.headers
		.getSetCookie()
		.map((cookie) => cookie.split(";")[0])
		.join("; ");
}

describe("a deployment that sets its legal pages", () => {
	let id: Id;

	beforeAll(async () => {
		id = await startId(origin, {
			settings: {
				LEGAL_NOTICE_URL: "https://legal.test/notice?from=id&lang=en",
				PRIVACY_POLICY_URL: "https://legal.test/privacy",
				TERMS_URL: "https://legal.test/terms",
			},
		});
	});

	afterAll(async () => {
		await id?.dispose();
	});

	it.each(PUBLIC_PAGES)("links them from %s, passing on no address", async (path) => {
		expectLinks(await page(id, path));
	});

	it("says where an account can be made that continuing means agreeing to the terms", async () => {
		expect(await page(id, "/login")).toContain("By continuing, you agree to the");
		expect(await page(id, "/signup")).toContain("By continuing, you agree to the");
		expect(await page(id, "/forgot-password")).not.toContain("By continuing");
	});

	it.each(["/account", "/workspaces", "/welcome"])(
		"links them from %s, once signed in",
		async (path) => {
			expectLinks(await page(id, path, await signedIn(id)));
		},
	);
});

describe("a deployment that sets none", () => {
	let id: Id;

	beforeAll(async () => {
		id = await startId(origin);
	});

	afterAll(async () => {
		await id?.dispose();
	});

	it.each(PUBLIC_PAGES)("shows nothing of the kind on %s", async (path) => {
		const html = await page(id, path);
		expect(html).not.toContain("Legal notice");
		expect(html).not.toContain("By continuing");
		expect(html).not.toContain('aria-label="Legal"');
		expect(html).not.toContain("gateweave.com/");
	});
});

describe("settings that are not addresses people can open", () => {
	let id: Id;

	beforeAll(async () => {
		id = await startId(origin, {
			settings: {
				LEGAL_NOTICE_URL: "javascript:alert(1)",
				PRIVACY_POLICY_URL: "not an address",
				TERMS_URL: "http://legal.test/terms",
			},
		});
	});

	afterAll(async () => {
		await id?.dispose();
	});

	it("leaves them out, and keeps the one that is", async () => {
		const html = await page(id, "/login");
		expect(html).not.toContain("javascript:alert");
		expect(html).not.toContain("not an address");
		expect(html).not.toMatch(/>Legal notice</);
		expect(html).not.toMatch(/>Privacy</);
		expect(html).toMatch(/<a [^>]*href="http:\/\/legal\.test\/terms"[^>]*>Terms<\/a>/);
	});
});
