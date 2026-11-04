import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { convertV4MiniflareOptions, Miniflare, type V4ModuleDefinition } from "miniflare";

const app = resolve(import.meta.dirname, "..");
const serverDir = join(app, "dist/server");

interface BuiltConfig {
	compatibility_date: string;
	compatibility_flags?: string[];
}

/** One line the Worker wrote to its console. */
export interface WorkerLog {
	level: string;
	message: string;
}

/** What ID handed to its email binding. */
export interface SentEmail {
	from: string | { name: string; email: string };
	to: string;
	subject: string;
	text: string;
	html: string;
}

/** The address ID sends from in tests. */
export const EMAIL_FROM = { name: "Gateweave ID", email: "id@id.test" };

/** Cloudflare's published test site key, which is public. */
export const TURNSTILE_SITE_KEY = "1x00000000000000000000AA";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** How the stand-in for Turnstile's Siteverify answers a token. */
export const TURNSTILE_TOKENS = {
	good: "good-token",
	otherAction: "token-from-another-action",
	otherHost: "token-from-another-host",
	refused: "refused-token",
	unavailable: "token-while-siteverify-is-down",
};

function siteverify(host: string, body: string): Response {
	const { response } = JSON.parse(body) as { response: string };
	const passed = { success: true, action: "gateweave-id", hostname: host };
	switch (response) {
		case TURNSTILE_TOKENS.good:
			return Response.json(passed);
		case TURNSTILE_TOKENS.otherAction:
			return Response.json({ ...passed, action: "something-else" });
		case TURNSTILE_TOKENS.otherHost:
			return Response.json({ ...passed, hostname: "elsewhere.test" });
		case TURNSTILE_TOKENS.unavailable:
			return new Response("Unavailable", { status: 503 });
		default:
			return Response.json({ success: false, "error-codes": ["invalid-input-response"] });
	}
}

/** Who the stand-in for GitHub says someone is. */
export interface GitHubPerson {
	id: number;
	login: string;
	name?: string | null;
	/** The address on their public profile. */
	email?: string | null;
	/** The addresses GitHub lists for them, or null when it will not answer. */
	emails: { email: string; primary: boolean; verified: boolean }[] | null;
}

/** The code GitHub would send back to ID's callback once this person agrees. */
export function gitHubCode(person: GitHubPerson): string {
	return Buffer.from(JSON.stringify(person)).toString("base64url");
}

const GITHUB_CLIENT = { id: "github-client-for-tests", secret: "github-secret-for-tests" };

/** GitHub's answer to one request of an OAuth sign-in, or null if the request is not for GitHub. */
async function gitHub(request: Request): Promise<Response | null> {
	const url = new URL(request.url);
	if (url.href === "https://github.com/login/oauth/access_token") {
		const form = new URLSearchParams(await request.text());
		if (form.get("client_secret") !== GITHUB_CLIENT.secret) {
			return Response.json({ error: "incorrect_client_credentials" });
		}
		// The token is the code again, so that the next requests know who this is.
		return Response.json({
			access_token: form.get("code"),
			token_type: "bearer",
			scope: "user:email",
		});
	}
	if (url.host !== "api.github.com") return null;
	const token = (request.headers.get("authorization") ?? "").replace("Bearer ", "");
	const person = JSON.parse(Buffer.from(token, "base64url").toString()) as GitHubPerson;
	if (url.pathname === "/user") {
		return Response.json({
			id: person.id,
			login: person.login,
			name: person.name ?? null,
			email: person.email ?? null,
			avatar_url: `https://avatars.test/${person.id}`,
		});
	}
	return person.emails ? Response.json(person.emails) : new Response("Forbidden", { status: 403 });
}

// Stands in for Cloudflare Email Service behind the EMAIL binding: `send` keeps each message,
// and a fetch lists them.
const OUTBOX = `
import { WorkerEntrypoint } from "cloudflare:workers";
const sent = [];
export default class Outbox extends WorkerEntrypoint {
	async send(message) {
		sent.push(message);
		return { messageId: crypto.randomUUID() };
	}
	async fetch() {
		return Response.json(sent);
	}
}
`;

/** Every module of the built Worker. Its migrations are imported as text. */
function builtModules(): V4ModuleDefinition[] {
	const modules: V4ModuleDefinition[] = [];
	for (const file of readdirSync(serverDir, { recursive: true, encoding: "utf8" })) {
		const path = join(serverDir, file);
		if (file.endsWith(".js")) modules.push({ type: "ESModule", path });
		else if (file.endsWith(".sql")) modules.push({ type: "Text", path });
	}
	return modules;
}

/**
 * The built Worker in workerd, as deployed: D1 migrated and served at `origin` without a
 * network. Requests go in through `fetch`.
 *
 * Every outbound request fails, the way a deployed Worker's request to its own hostname does.
 * ID needs no outside service for sign-in, so code that only works because local dev can reach
 * itself fails here instead of in production. Email is on unless `email` is false, and lands in
 * `emails()`. With `turnstile`, Siteverify answers: see `TURNSTILE_TOKENS`. With `github`, GitHub
 * does: see `gitHubCode`.
 *
 * With `isolates` above 1, more copies of the Worker share the database and Durable Objects but
 * nothing in memory, as isolates in production do. `fetchIn` reaches a given one.
 */
export async function startId(
	origin: string,
	{
		isolates = 1,
		email = true,
		turnstile = false,
		github = false,
	}: { isolates?: number; email?: boolean; turnstile?: boolean; github?: boolean } = {},
) {
	const config = JSON.parse(readFileSync(join(serverDir, "wrangler.json"), "utf8")) as BuiltConfig;
	const outbound: string[] = [];
	const logs: WorkerLog[] = [];
	const modules = builtModules();
	const secret = randomBytes(32).toString("base64url");
	const names = Array.from({ length: isolates }, (_, i) => (i === 0 ? "id" : `id-${i + 1}`));
	// Miniflare 5 still takes its documented v4 options through this converter.
	const mf = new Miniflare(
		convertV4MiniflareOptions({
			// Keep what the Worker logs for `logs`, and still show it as Miniflare would.
			handleStructuredLogs: (log) => {
				logs.push(log);
				console.error(`[worker ${log.level}] ${log.message}`);
			},
			workers: [
				...names.map((name, index) => ({
					name,
					// Requests go to the first copy unless their host is another copy's route.
					routes: index === 0 ? [] : [`${name}.test/*`],
					modules,
					modulesRoot: serverDir,
					compatibilityDate: config.compatibility_date,
					compatibilityFlags: config.compatibility_flags,
					bindings: {
						BETTER_AUTH_SECRET: secret,
						BETTER_AUTH_URL: origin,
						...(email ? { EMAIL_FROM: `${EMAIL_FROM.name} <${EMAIL_FROM.email}>` } : {}),
						...(turnstile
							? {
									TURNSTILE_SITE_KEY,
									TURNSTILE_SECRET_KEY: "turnstile-secret-for-tests",
								}
							: {}),
						...(github
							? {
									GITHUB_CLIENT_ID: GITHUB_CLIENT.id,
									GITHUB_CLIENT_SECRET: GITHUB_CLIENT.secret,
								}
							: {}),
					},
					serviceBindings: { EMAIL: "outbox" },
					d1Databases: { DB: "id-test" },
					// Every copy uses the first one's Durable Objects.
					durableObjects: {
						RATE_LIMITER: { className: "RateLimiter", useSQLite: true, scriptName: names[0] },
					},
					outboundService: async (request: Request) => {
						outbound.push(request.url);
						if (turnstile && request.url === SITEVERIFY) {
							return siteverify(new URL(origin).hostname, await request.text());
						}
						const answer = github ? await gitHub(request) : null;
						if (answer) return answer;
						return new Response("Outbound requests are blocked in this test", { status: 502 });
					},
				})),
				{
					name: "outbox",
					modules: true,
					script: OUTBOX,
					routes: ["outbox.test/*"],
					compatibilityDate: config.compatibility_date,
				},
			],
		}),
	);

	const db = await mf.getD1Database("DB");
	const migrations = join(app, "migrations");
	for (const file of readdirSync(migrations)
		.filter((name) => name.endsWith(".sql"))
		.sort()) {
		const statements = readFileSync(join(migrations, file), "utf8")
			.split("--> statement-breakpoint")
			.map((statement) => statement.trim())
			.filter(Boolean);
		await db.batch(statements.map((statement) => db.prepare(statement)));
	}

	/** A `fetch` that reaches one copy of the Worker directly. Redirects are returned. */
	async function fetchIn(
		isolate: number,
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> {
		const name = names[isolate];
		if (!name) throw new Error(`There are only ${names.length} isolates`);
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (isolate > 0) url.host = `${name}.test`;
		const response = await mf.dispatchFetch(url, {
			method: request.method,
			headers: [...request.headers],
			body: request.body ? await request.arrayBuffer() : undefined,
			redirect: "manual",
		});
		const headers = new Headers();
		for (const [name, value] of response.headers) {
			if (name !== "set-cookie") headers.append(name, value);
		}
		for (const cookie of response.headers.getSetCookie()) headers.append("set-cookie", cookie);
		const empty = response.status === 204 || response.status === 304;
		return new Response(empty ? null : await response.arrayBuffer(), {
			status: response.status,
			headers,
		});
	}

	return {
		/** A `fetch` that reaches the Worker directly. Redirects are returned, not followed. */
		fetch: (input: string | URL | Request, init?: RequestInit) => fetchIn(0, input, init),
		fetchIn,
		/** URLs the Worker tried to fetch from outside. */
		outbound,
		/** Everything the Worker has logged so far, oldest first. */
		logs,
		/** Every email sent so far, oldest first. Email goes out after the response. */
		async emails(): Promise<SentEmail[]> {
			const response = await mf.dispatchFetch("http://outbox.test/");
			return (await response.json()) as SentEmail[];
		},
		/** The D1 database, for setting up state the app has no endpoint for. */
		db,
		dispose: () => mf.dispose(),
	};
}
