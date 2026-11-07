import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Database } from "../db";
import { createAuth } from "./config";

/**
 * Every route answering over HTTP, with every feature on, since some only exist with one. An upgrade
 * of Better Auth or a plugin can add a route, and nothing else would notice it being served. A route
 * failing this needs a decision: close it in `disabledPaths`, give it a limit of its own, or add it
 * here because it is fine as it is.
 */
const SERVED = [
	// Signing in and out, and what follows from them.
	"GET /error",
	"GET /jwks",
	"GET /ok",
	"GET /reset-password/:token",
	"GET,POST /callback/:id",
	"GET,POST /get-session",
	"POST /email-otp/send-verification-otp",
	"POST /request-password-reset",
	"POST /reset-password",
	"POST /sign-in/email",
	"POST /sign-in/email-otp",
	"POST /sign-in/social",
	"POST /sign-out",

	// Someone's own account and sessions.
	"GET /account/activity",
	"GET /account/allowed-apps",
	"GET /list-accounts",
	"GET /list-sessions",
	"POST /account/allowed-apps/take-back",
	"POST /account/delete",
	"POST /account/first-password",
	"POST /account/remove-passkey",
	"POST /change-password",
	"POST /link-social",
	"POST /revoke-other-sessions",
	"POST /revoke-session",
	"POST /revoke-sessions",
	"POST /unlink-account",
	"POST /update-session",
	"POST /update-user",

	// Off unless configured, and they are not: `user.changeEmail` and `user.deleteUser`.
	"GET /delete-user/callback",
	"POST /change-email",
	"POST /delete-user",

	// Passkeys and two-factor.
	"GET /passkey/generate-authenticate-options",
	"GET /passkey/generate-register-options",
	"GET /passkey/list-user-passkeys",
	"POST /passkey/update-passkey",
	"POST /passkey/verify-authentication",
	"POST /passkey/verify-registration",
	"POST /two-factor/disable",
	"POST /two-factor/enable",
	"POST /two-factor/generate-backup-codes",
	"POST /two-factor/verify-backup-code",
	"POST /two-factor/verify-totp",

	// The server itself: claiming it, and who may have an account on it.
	"GET /deployment/get",
	"POST /deployment/claim",
	"POST /deployment/invitations/accept",
	"POST /deployment/invitations/cancel",
	"POST /deployment/invitations/create",
	"POST /deployment/invitations/read",
	"POST /deployment/sign-up",

	// Workspaces. The gate in workspaces.ts has a rule for each of the organization plugin's.
	"GET /workspaces/get",
	"GET /workspaces/invitation",
	"GET /workspaces/list",
	"POST /organization/accept-invitation",
	"POST /organization/cancel-invitation",
	"POST /organization/create",
	"POST /organization/delete",
	"POST /organization/invite-member",
	"POST /organization/leave",
	"POST /organization/reject-invitation",
	"POST /organization/remove-member",
	"POST /organization/update",
	"POST /organization/update-member-role",
	"POST /workspaces/apps/add",
	"POST /workspaces/apps/change",
	"POST /workspaces/apps/delete",
	"POST /workspaces/apps/replace-secret",
	"POST /workspaces/apps/set-groups",
	"POST /workspaces/groups/add-member",
	"POST /workspaces/groups/create",
	"POST /workspaces/groups/delete",
	"POST /workspaces/groups/remove-member",
	"POST /workspaces/groups/rename",

	// The provider's flow.
	"GET,POST /oauth2/authorize",
	"GET,POST /oauth2/end-session",
	"GET,POST /oauth2/userinfo",
	"POST /oauth2/consent",
	"POST /oauth2/continue",
	"POST /oauth2/end-session/confirm",
	"POST /oauth2/revoke",
	"POST /oauth2/token",

	// Refused to everyone by `clientPrivileges` and by leaving out dynamic registration: apps are
	// made on a workspace's page. test/oidc.test.ts shows the refusals.
	"GET /oauth2/get-client",
	"GET /oauth2/get-clients",
	"POST /oauth2/client/rotate-keys",
	"POST /oauth2/client/rotate-secret",
	"POST /oauth2/create-client",
	"POST /oauth2/delete-client",
	"POST /oauth2/register",
	"POST /oauth2/update-client",
];

/** The organization plugin's routes that the gate in workspaces.ts has no rule for: it answers 404. */
const NO_RULE = new Set([
	"/organization/check-slug",
	"/organization/get-active-member",
	"/organization/get-active-member-role",
	"/organization/get-full-organization",
	"/organization/get-organization",
	"/organization/has-permission",
	"/organization/list",
	"/organization/list-invitations",
	"/organization/list-members",
	"/organization/list-user-invitations",
	"/organization/set-active",
]);

let mf: Miniflare;
let db: Database;

beforeAll(async () => {
	mf = new Miniflare(
		convertV4MiniflareOptions({
			modules: true,
			script: "export default { fetch: () => new Response() };",
			d1Databases: { DB: "auth-routes-test" },
		}),
	);
	const d1 = await mf.getD1Database("DB");
	const migrations = resolve(import.meta.dirname, "../../../migrations");
	for (const file of readdirSync(migrations)
		.filter((name) => name.endsWith(".sql"))
		.sort()) {
		const statements = readFileSync(join(migrations, file), "utf8")
			.split("--> statement-breakpoint")
			.map((statement) => statement.trim())
			.filter(Boolean);
		await d1.batch(statements.map((statement) => d1.prepare(statement)));
	}
	// Miniflare's D1 type is its own; it is the same binding a Worker gets.
	db = createDb(d1 as unknown as D1Database);
});

afterAll(async () => {
	await mf?.dispose();
});

describe("What Better Auth serves", () => {
	const everyFeature = () =>
		createAuth({
			db,
			secret: "a-test-secret-that-is-long-enough-for-better-auth",
			baseURL: "https://id.test",
			github: { clientId: "id", clientSecret: "secret" },
			mailer: { send: async () => {} },
			turnstileSecretKey: "a-test-key",
			oidc: { issuer: "https://id.test", pairwiseSecret: "a-test-secret-for-each-apps-own-ids" },
		});

	/** The routes with a path, as the router sees them. One without is only ever called in-process. */
	function routes(auth: ReturnType<typeof everyFeature>) {
		const closed = new Set<string>(auth.options.disabledPaths);
		return Object.values(auth.api).flatMap((value) => {
			const endpoint = value as unknown as {
				path?: string;
				options: { method: string | string[]; metadata?: { SERVER_ONLY?: boolean } };
			};
			if (!endpoint.path) return [];
			const { method, metadata } = endpoint.options;
			const open =
				!metadata?.SERVER_ONLY && !closed.has(endpoint.path) && !NO_RULE.has(endpoint.path);
			return [{ path: endpoint.path, methods: [method].flat(), open }];
		});
	}

	it("answers on the routes listed here, and no others", () => {
		const served = routes(everyFeature())
			.filter(({ open }) => open)
			.map(({ path, methods }) => `${methods.join(",")} ${path}`);

		expect(
			{
				added: served.filter((route) => !SERVED.includes(route)),
				gone: SERVED.filter((route) => !served.includes(route)),
			},
			"A route Better Auth serves has changed. See the comment on SERVED for what to decide.",
		).toEqual({ added: [], gone: [] });
	});

	it("answers 404 on every route closed to HTTP", async () => {
		const auth = everyFeature();
		const unreachable = routes(auth).filter(({ open }) => !open);
		// A closed path no route has any more would be a sign of a renamed one, still open.
		expect(unreachable.map(({ path }) => path)).toEqual(
			expect.arrayContaining([...new Set<string>(auth.options.disabledPaths), ...NO_RULE]),
		);

		for (const { path, methods } of unreachable) {
			for (const method of methods) {
				const address = `https://id.test/api/auth${path.replaceAll(/:\w+/g, "x")}`;
				const response = await auth.handler(
					new Request(address, {
						method,
						headers: { origin: "https://id.test", "content-type": "application/json" },
						...(method === "GET" ? {} : { body: "{}" }),
					}),
				);
				expect(response.status, `${method} ${path}`).toBe(404);
			}
		}
	});
});
