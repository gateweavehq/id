import { getOAuthProviderState, oauthProvider } from "@better-auth/oauth-provider";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";
import { jwt } from "better-auth/plugins/jwt";
import { eq } from "drizzle-orm";
import type { Database } from "../db";
import { schema } from "../db";
import { type RecordEvent, whereFrom } from "./audit";
import { hasPasskey } from "./passkeys";
import { maySignIn } from "./who-may-sign-in";

export interface OidcConfig {
	/** The deployment's origin. Apps have it in their settings, so it can never change. */
	issuer: string;
	/** Gives each app its own id for each person. Rotating it changes every one of them. */
	pairwiseSecret: string;
}

const DAY = 86_400;

/**
 * `/token` hands a signed-in person a JWT that holds their real id, which pairwise subjects exist to
 * keep from apps. The apps have no use for it, since they get tokens from the provider.
 */
export const OIDC_CLOSED_PATHS = ["/token"];

/**
 * Every app carries its own id in its metadata, because the token hooks see the metadata and not
 * the client id. Nothing here can be read from a client that lacks it, so such a client gets nobody.
 */
function appIn(metadata: unknown): string | undefined {
	try {
		const parsed = typeof metadata === "string" ? JSON.parse(metadata) : metadata;
		const app = (parsed as { app?: unknown } | null | undefined)?.app;
		return typeof app === "string" && app ? app : undefined;
	} catch {
		return undefined;
	}
}

async function appOfClient(db: Database, clientId: string | null | undefined) {
	if (!clientId) return undefined;
	const client = await db
		.select({ metadata: schema.oauthClient.metadata })
		.from(schema.oauthClient)
		.where(eq(schema.oauthClient.clientId, clientId))
		.get();
	return appIn(client?.metadata);
}

/** The app an authorization is for, from the provider's state. Undefined if it cannot be named. */
async function appBeingAuthorized(db: Database): Promise<string | undefined> {
	const state = await getOAuthProviderState();
	// `query` is a serialized query string, not an object. Reading it wrongly gets nothing here, which
	// must refuse rather than let everyone through.
	return appOfClient(db, new URLSearchParams(state?.query ?? "").get("client_id"));
}

async function canSignInAgain(db: Database, userId: string): Promise<boolean> {
	const account = await db
		.select({ id: schema.account.id })
		.from(schema.account)
		.where(eq(schema.account.userId, userId))
		.limit(1)
		.get();
	return account !== undefined || hasPasskey(db, userId);
}

/**
 * `resource` asks for a JWT access token, whose subject is the person's real id whatever the app's
 * subject type. No API is registered here, but the provider always accepts its own userinfo endpoint
 * as one, so without this any app could read the id that pairwise subjects keep from it.
 */
function refuseResources(): BetterAuthPlugin {
	return {
		id: "refuse-resources",
		hooks: {
			before: [
				{
					matcher: (ctx) => ctx.path === "/oauth2/authorize" || ctx.path === "/oauth2/token",
					handler: createAuthMiddleware(async (ctx) => {
						if (ctx.query?.resource !== undefined || ctx.body?.resource !== undefined) {
							throw new APIError("BAD_REQUEST", {
								error: "invalid_target",
								error_description: "This provider has no resources to ask for",
							});
						}
					}),
				},
			],
		},
	};
}

/** The client a request to revoke a token came from, by now checked by the provider. */
function clientRevoking(headers: Headers | undefined, body: Record<string, unknown> | undefined) {
	if (typeof body?.client_id === "string") return body.client_id;
	const basic = /^Basic (.+)$/i.exec(headers?.get("authorization") ?? "")?.[1];
	if (!basic) return undefined;
	try {
		// Only the part before the colon. The rest is the client's secret.
		return decodeURIComponent(atob(basic).split(":")[0] ?? "");
	} catch {
		return undefined;
	}
}

/** Records what the provider does at paths with no hook of its own. */
function auditOfApps(db: Database, record: RecordEvent): BetterAuthPlugin {
	return {
		id: "audit-of-apps",
		hooks: {
			after: [
				{
					matcher: (ctx) => ctx.path === "/oauth2/consent" || ctx.path === "/oauth2/revoke",
					handler: createAuthMiddleware(async (ctx) => {
						// Not `instanceof`: the provider's refusals are a different class from Better Auth's.
						if (isAPIError(ctx.context.returned)) return;
						const from = whereFrom(ctx.headers);
						if (ctx.path === "/oauth2/revoke") {
							// No person: an app's server is asking, and the token it names is stored hashed.
							const clientId = clientRevoking(ctx.headers, ctx.body);
							record("token_revoked", async () => ({
								app: await appOfClient(db, clientId),
								...from,
							}));
							return;
						}
						const session = await getSessionFromCtx(ctx);
						const clientId = new URLSearchParams(ctx.body?.oauth_query ?? "").get("client_id");
						record(ctx.body?.accept === true ? "consent_granted" : "consent_denied", async () => ({
							userId: session?.user.id,
							app: await appOfClient(db, clientId),
							...from,
						}));
					}),
				},
			],
		},
	};
}

/**
 * The OIDC provider and the signing keys under it. Why each value is what it is, and which can never
 * change, is in "Tokens" in docs/architecture.md.
 */
export function oidcPlugins(
	db: Database,
	{ issuer, pairwiseSecret }: OidcConfig,
	record: RecordEvent,
) {
	return [
		refuseResources(),
		auditOfApps(db, record),
		jwt({
			// Apps get tokens from the provider. A session has no business carrying a JWT as well.
			disableSettingJwtHeader: true,
			jwks: {
				keyPairConfig: { alg: "ES256" },
				rotationInterval: 90 * DAY,
				// Longer than any ID token lives or any app sensibly caches the keys.
				gracePeriod: 30 * DAY,
			},
			jwt: { issuer },
		}),
		oauthProvider({
			loginPage: "/login",
			consentPage: "/consent",
			pairwiseSecret,
			scopes: ["openid", "profile", "email", "offline_access"],
			grantTypes: ["authorization_code", "refresh_token"],
			prefix: {
				opaqueAccessToken: "gwid_at_",
				refreshToken: "gwid_rt_",
				clientSecret: "gwid_cs_",
			},
			// Apps are registered by the deployment (scripts/add-app.ts). Nobody can make or change one
			// through the API until workspaces have admins to decide who may.
			clientPrivileges: () => false,
			// Limits count per address, and these two are called by apps' servers. Apps on Workers all
			// come from Cloudflare's one address, so the defaults (20 and 60 a minute) would stop every
			// app's sign-ins together. A request here is authenticated, and a code works once.
			rateLimit: { token: { window: 60, max: 600 }, userinfo: { window: 60, max: 600 } },
			// The provider leaves these to userinfo. Apps read them from the ID token, and Cloudflare Access
			// reads nothing else, so they are here too, for the scopes that ask for them.
			customIdTokenClaims: ({ user, scopes }) => ({
				...(scopes.includes("email") && {
					email: user.email,
					email_verified: Boolean(user.emailVerified),
				}),
				...(scopes.includes("profile") && {
					name: user.name,
					...(user.image && { picture: user.image }),
				}),
			}),
			// Authorization does not run on refresh, so without this a removed person keeps their access.
			customTokenResponseFields: ({ grantType, user, metadata }) => {
				const app = appIn(metadata);
				if (!maySignIn({ user, app })) {
					record("refused", { userId: user?.id, app, detail: grantType });
					throw new APIError("BAD_REQUEST", {
						error: "invalid_grant",
						error_description: "This person may not use this app",
					});
				}
				// The moment an app learns who someone is. A refresh tells it nothing new. This request is
				// the app's server, so it says nothing of where the person is.
				if (grantType === "authorization_code") record("app_sign_in", { userId: user?.id, app });
				return {};
			},
			signup: {
				page: "/welcome",
				// A sign-up code proves an address and leaves nothing to sign in with next time, so someone
				// who has only that chooses a password before any app hears of them.
				shouldRedirect: async ({ user }) => !(await canSignInAgain(db, user.id)),
			},
			postLogin: {
				page: "/no-access",
				// Runs on every path to a code, and again when someone continues past the page.
				shouldRedirect: async ({ user, headers }) => {
					const app = await appBeingAuthorized(db);
					if (maySignIn({ user, app })) return false;
					record("refused", {
						userId: user.id,
						app,
						detail: "authorization",
						...whereFrom(headers),
					});
					return true;
				},
				consentReferenceId: () => undefined,
			},
		}),
	];
}
