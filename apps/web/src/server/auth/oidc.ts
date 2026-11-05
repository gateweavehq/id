import { getOAuthProviderState, oauthProvider } from "@better-auth/oauth-provider";
import type { BetterAuthPlugin, GenericEndpointContext } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";
import { jwt } from "better-auth/plugins/jwt";
import { and, eq, gt } from "drizzle-orm";
import type { Database } from "../db";
import { schema } from "../db";
import { type RecordEvent, whereFrom } from "./audit";
import { hasPasskey } from "./passkeys";
import { type AppIdentity, appIn, groupsOf, maySignIn, stillAllowed } from "./who-may-sign-in";

export interface OidcConfig {
	/** The deployment's origin. Apps have it in their settings, so it can never change. */
	issuer: string;
	/** Gives each app its own id for each person. Rotating it changes every one of them. */
	pairwiseSecret: string;
}

const DAY = 86_400;

/** What the provider advertises by itself for the scopes it knows, which setting this replaces. */
const STANDARD_CLAIMS_SUPPORTED = [
	"sub",
	"iss",
	"aud",
	"exp",
	"iat",
	"sid",
	"scope",
	"azp",
	"name",
	"picture",
	"given_name",
	"family_name",
	"email",
	"email_verified",
];

/**
 * `/token` hands a signed-in person a JWT that holds their real id, which pairwise subjects exist to
 * keep from apps. The apps have no use for it, since they get tokens from the provider. The next two
 * name any app to anyone who has its id, and no page here uses them. What the consent page asks for
 * instead tells someone only about an app they could reach. Introspection is for APIs, and there are
 * none here. It would tell an app the id of the session behind a token, which two apps could match
 * someone up by, whatever their ID tokens leave out. The consent paths are half of what someone
 * taking an app back means: the one that deletes leaves the app's tokens working, and the one that
 * updates rewrites what they said yes to. `/account/allowed-apps` does this, all of it, and no page
 * uses these.
 */
export const OIDC_CLOSED_PATHS = [
	"/token",
	"/oauth2/public-client",
	"/oauth2/public-client-prelogin",
	"/oauth2/introspect",
	"/oauth2/get-consent",
	"/oauth2/get-consents",
	"/oauth2/update-consent",
	"/oauth2/delete-consent",
];

async function appOfClient(
	db: Database,
	clientId: string | null | undefined,
): Promise<AppIdentity | undefined> {
	if (!clientId) return undefined;
	const client = await db
		.select({ metadata: schema.oauthClient.metadata })
		.from(schema.oauthClient)
		.where(eq(schema.oauthClient.clientId, clientId))
		.get();
	return appIn(client?.metadata);
}

/** The app an authorization is for, from the provider's state. Undefined if it cannot be named. */
async function appBeingAuthorized(db: Database): Promise<AppIdentity | undefined> {
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

/**
 * The client a request to revoke a token came from, by now checked by the provider. Basic comes first,
 * as it does there: what the body says beside it was not checked, and could be any other app.
 */
function clientRevoking(headers: Headers | undefined, body: Record<string, unknown> | undefined) {
	const basic = /^Basic (.+)$/i.exec(headers?.get("authorization") ?? "")?.[1];
	if (!basic) return typeof body?.client_id === "string" ? body.client_id : undefined;
	try {
		// Only the part before the colon. The rest is the client's secret.
		return decodeURIComponent(atob(basic).split(":")[0] ?? "");
	} catch {
		return undefined;
	}
}

/** Where the provider's answer sends someone. A browser is redirected, and a page's own request told. */
function whereAnswerSends(context: {
	returned?: unknown;
	responseHeaders?: Headers;
}): string | undefined {
	const { returned, responseHeaders } = context;
	if (isAPIError(returned)) return responseHeaders?.get("location") ?? undefined;
	if (typeof returned === "object" && returned !== null && "url" in returned) {
		return typeof returned.url === "string" ? returned.url : undefined;
	}
	return undefined;
}

/**
 * Spelled out because `ctx.request` need not be this. The provider goes through the endpoint by itself
 * after a sign-in, and on an answer from a page, and the request is still that one.
 */
const AUTHORIZE_PATH = "/api/auth/oauth2/authorize";

/** What is being asked, without one of its parameters. */
function sameRequestWithout(ctx: GenericEndpointContext, name: string): string {
	const asked = new URLSearchParams();
	for (const [key, values] of Object.entries(ctx.query ?? {})) {
		if (key === name) continue;
		for (const value of [values].flat()) asked.append(key, String(value));
	}
	return `${AUTHORIZE_PATH}?${asked}`;
}

/**
 * Anyone with an account can add an app, so where a workspace's app goes is anyone's to choose. The
 * provider sends people there from this address when a request is wrong, or when `prompt=none` finds it
 * cannot go on, in many places and before it has looked at who they are. Left alone, a link to this
 * server would be a link to anywhere, for anyone who followed it (RFC 9700, section 4.11.2). So nobody
 * leaves here for one of these apps until they are known to be one of its members. It is the answer
 * that is checked rather than the request, so this holds for every way the provider has of sending them.
 *
 * A member can still be sent there by a wrong request, which only tells them what they know: an admin
 * of their workspace added this app, and they can be sent to it anyway.
 */
function membersOnlyToWorkspaceApps(db: Database, issuer: string): BetterAuthPlugin {
	return {
		id: "members-only-to-workspace-apps",
		hooks: {
			before: [
				{
					// OpenID Connect has this answer POST too, with what it asks in the body. That is the same
					// request, so make it the same, and everything here has one place to look. Only when it is
					// that request: when the provider comes through here itself, the body is some other
					// request's, and after a sign-in it holds the password someone just typed.
					matcher: (ctx) =>
						ctx.path === "/oauth2/authorize" &&
						ctx.request?.method === "POST" &&
						new URL(ctx.request.url).pathname === AUTHORIZE_PATH,
					handler: createAuthMiddleware(async (ctx) => {
						const asked = Object.entries((ctx.body ?? {}) as Record<string, unknown>).filter(
							(entry): entry is [string, string] => typeof entry[1] === "string",
						);
						const query = new URLSearchParams(asked).toString();
						throw ctx.redirect(`${AUTHORIZE_PATH}?${query}`);
					}),
				},
				{
					// People are asked about scopes, so naming claims one by one would get an app more than the
					// page said. A provider may leave out what is asked for this way (OpenID Connect Core, 5.5.1).
					matcher: (ctx) => ctx.path === "/oauth2/authorize",
					handler: createAuthMiddleware(async (ctx) => {
						if (ctx.query?.claims !== undefined)
							throw ctx.redirect(sameRequestWithout(ctx, "claims"));
					}),
				},
				{
					// A member's link, signed for them, in the hands of someone else. Either answer here would
					// send that person to the app, which is no business of theirs.
					matcher: (ctx) => ctx.path === "/oauth2/consent" || ctx.path === "/oauth2/continue",
					handler: createAuthMiddleware(async (ctx) => {
						const clientId = new URLSearchParams(ctx.body?.oauth_query ?? "").get("client_id");
						const app = await appOfClient(db, clientId);
						if (!app?.workspace) return;
						const session = await getSessionFromCtx(ctx);
						if (session && !(await maySignIn(db, { user: session.user, app }))) {
							return ctx.json({ redirect: true, url: "/no-access" });
						}
					}),
				},
			],
			after: [
				{
					matcher: (ctx) => ctx.path === "/oauth2/authorize",
					handler: createAuthMiddleware(async (ctx) => {
						const sends = whereAnswerSends(ctx.context);
						if (!sends || new URL(sends, issuer).origin === new URL(issuer).origin) return;
						const clientId = ctx.query?.client_id;
						const app = typeof clientId === "string" ? await appOfClient(db, clientId) : undefined;
						// An app everyone can use was added by whoever runs this server. A row this cannot read
						// is not known to be one of those.
						if (app && !app.workspace) return;
						const session = await getSessionFromCtx(ctx);
						if (!session) {
							// An app asking quietly whether someone is signed in gets no quiet answer, or anyone
							// could send anyone there through here. They can sign in instead, and go on to it.
							const quietly = new URL(sends, issuer).searchParams.get("error") === "login_required";
							throw ctx.redirect(quietly ? sameRequestWithout(ctx, "prompt") : "/login");
						}
						if (!(await maySignIn(db, { user: session.user, app }))) {
							throw ctx.redirect("/no-access");
						}
					}),
				},
			],
		},
	};
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
							record("token_revoked", async () => {
								const app = await appOfClient(db, clientId);
								return { app: app?.app, workspaceId: app?.workspace, ...from };
							});
							return;
						}
						const session = await getSessionFromCtx(ctx);
						const clientId = new URLSearchParams(ctx.body?.oauth_query ?? "").get("client_id");
						record(ctx.body?.accept === true ? "consent_granted" : "consent_denied", async () => {
							const app = await appOfClient(db, clientId);
							return {
								userId: session?.user.id,
								app: app?.app,
								workspaceId: app?.workspace,
								...from,
							};
						});
					}),
				},
			],
		},
	};
}

/** Only ever from the workspace that owns the app, which only the server writes on its row. */
async function groupsClaim(
	db: Database,
	userId: string,
	scopes: string[],
	app: AppIdentity | undefined,
) {
	if (!scopes.includes("groups") || !app?.workspace) return {};
	return { groups: await groupsOf(db, userId, app.workspace) };
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
		membersOnlyToWorkspaceApps(db, issuer),
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
			// `groups` is on the row of a workspace's app and no other, so nothing else can ask for it.
			scopes: ["openid", "profile", "email", "offline_access", "groups"],
			// The provider works out the rest from the scopes it knows. This one it has not heard of.
			advertisedMetadata: { claims_supported: [...STANDARD_CLAIMS_SUPPORTED, "groups"] },
			grantTypes: ["authorization_code", "refresh_token"],
			prefix: {
				opaqueAccessToken: "gwid_at_",
				refreshToken: "gwid_rt_",
				clientSecret: "gwid_cs_",
			},
			// Nobody makes or changes an app through the provider's API, which takes fields from the caller
			// that nothing here should. A deployment has scripts/add-app.ts, and a workspace's admins have
			// workspace-apps.ts, which writes a fixed row.
			clientPrivileges: () => false,
			// Limits count per address, and these two are called by apps' servers, which can share one on
			// a cloud or a zone's Workers (`countedByWhoSentIt`). The defaults (20 and 60 a minute) would stop
			// all of those apps' sign-ins together. A request here is authenticated, and a code works once.
			rateLimit: { token: { window: 60, max: 600 }, userinfo: { window: 60, max: 600 } },
			// The provider leaves these to userinfo. Apps read them from the ID token, and Cloudflare Access
			// reads nothing else, so they are here too, for the scopes that ask for them.
			customIdTokenClaims: async ({ user, scopes, metadata }) => ({
				...(scopes.includes("email") && {
					email: user.email,
					email_verified: Boolean(user.emailVerified),
				}),
				...(scopes.includes("profile") && {
					name: user.name,
					...(user.image && { picture: user.image }),
				}),
				...(await groupsClaim(db, user.id, scopes, appIn(metadata))),
			}),
			// Userinfo is not told which app is asking except by the token.
			customUserInfoClaims: async ({ user, scopes, jwt: { client_id: clientId } }) => {
				if (!scopes.includes("groups") || typeof clientId !== "string") return {};
				return groupsClaim(db, user.id, scopes, await appOfClient(db, clientId));
			},
			// Authorization does not run on refresh, so without this a removed person keeps their access.
			customTokenResponseFields: async ({ grantType, user, metadata, scopes }) => {
				const app = appIn(metadata);
				if (
					!(await maySignIn(db, { user, app })) ||
					!(await stillAllowed(db, { user, app, scopes }))
				) {
					record("refused", async () => {
						if (grantType === "refresh_token" && (await refusedLately(db, user?.id, app?.app))) {
							return undefined;
						}
						return {
							userId: user?.id,
							app: app?.app,
							workspaceId: app?.workspace,
							detail: grantType,
						};
					});
					throw new APIError("BAD_REQUEST", {
						error: "invalid_grant",
						error_description: "This person may not use this app",
					});
				}
				// The moment an app learns who someone is. A refresh tells it nothing new. This request is
				// the app's server, so it says nothing of where the person is.
				if (grantType === "authorization_code") {
					record("app_sign_in", { userId: user?.id, app: app?.app, workspaceId: app?.workspace });
				}
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
					if (await maySignIn(db, { user, app })) return false;
					record("refused", {
						userId: user.id,
						app: app?.app,
						workspaceId: app?.workspace,
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

/**
 * A refused refresh token is not rotated, so an app can send it again and again, up to the token
 * endpoint's limit. One row an hour says what a row a try would, and leaves the newest rows the
 * account page shows to everything else.
 */
async function refusedLately(
	db: Database,
	userId: string | undefined,
	app: string | undefined,
): Promise<boolean> {
	if (!userId || !app) return false;
	const row = await db
		.select({ id: schema.auditEvent.id })
		.from(schema.auditEvent)
		.where(
			and(
				eq(schema.auditEvent.userId, userId),
				gt(schema.auditEvent.at, new Date(Date.now() - REFUSED_REFRESH_WINDOW)),
				eq(schema.auditEvent.type, "refused"),
				eq(schema.auditEvent.app, app),
				eq(schema.auditEvent.detail, "refresh_token"),
			),
		)
		.get();
	return row !== undefined;
}

const REFUSED_REFRESH_WINDOW = 60 * 60 * 1000;
