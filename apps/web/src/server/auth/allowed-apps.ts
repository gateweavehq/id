import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { and, desc, eq, max } from "drizzle-orm";
import { z } from "zod";
import type { AllowedApp } from "../../lib/allowed-app";
import type { Database } from "../db";
import { schema } from "../db";
import { hostOfUris } from "./app-row";
import { type RecordEvent, whereFrom } from "./audit";
import { scopesIn } from "./who-may-sign-in";
import { noStore, parseBody } from "./workspace-access";

// "Taking an app back" in docs/architecture.md. The provider's own consent endpoints stay closed: the
// one that deletes takes away the row and leaves the tokens, so it would look done and not be.

/** The same answer for an app that is not there, or is another's to take back, or never asked. */
const NOT_ALLOWED = { code: "APP_NOT_ALLOWED", message: "You have not allowed that app." };

interface AllowedAppsConfig {
	db: Database;
	record: RecordEvent;
}

/**
 * The join on the workspace is what leaves out first-party apps. They do not ask, so nobody should
 * find one here, and taking one back would do nothing the next sign-in would not undo. Explicit
 * columns, so the secret's hash stays out.
 */
function allowedBy(db: Database, userId: string) {
	return db
		.select({
			clientId: schema.oauthConsent.clientId,
			name: schema.oauthClient.name,
			redirectUris: schema.oauthClient.redirectUris,
			workspaceId: schema.organization.id,
			workspace: schema.organization.name,
			scopes: schema.oauthConsent.scopes,
			allowedAt: schema.oauthConsent.updatedAt,
		})
		.from(schema.oauthConsent)
		.innerJoin(schema.oauthClient, eq(schema.oauthClient.clientId, schema.oauthConsent.clientId))
		.innerJoin(schema.organization, eq(schema.organization.id, schema.oauthClient.referenceId))
		.where(eq(schema.oauthConsent.userId, userId))
		.$dynamic();
}

/**
 * When each app last learned who this person is. The log keeps ninety days of it. This takes no list
 * of apps, as naming each one in the query would stop the page past D1's 100 bound parameters, and
 * someone with too many apps to see could take none of them back.
 */
async function lastSignIns(db: Database, userId: string) {
	const rows = await db
		.select({ app: schema.auditEvent.app, at: max(schema.auditEvent.at) })
		.from(schema.auditEvent)
		.where(and(eq(schema.auditEvent.userId, userId), eq(schema.auditEvent.type, "app_sign_in")))
		.groupBy(schema.auditEvent.app)
		.all();
	return new Map(rows.flatMap(({ app, at }) => (app && at ? [[app, at] as const] : [])));
}

export function allowedAppsPlugin({ db, record }: AllowedAppsConfig): BetterAuthPlugin {
	return {
		id: "allowed-apps",
		endpoints: {
			listAllowedApps: createAuthEndpoint(
				"/account/allowed-apps",
				{ method: "GET", use: [sessionMiddleware] },
				async (ctx) => {
					noStore(ctx);
					const me = ctx.context.session.user.id;
					const rows = await allowedBy(db, me).orderBy(desc(schema.oauthConsent.updatedAt)).all();
					const signIns = await lastSignIns(db, me);
					return {
						apps: rows.map(
							(row): AllowedApp => ({
								clientId: row.clientId,
								name: row.name,
								workspace: row.workspace,
								host: hostOfUris(row.redirectUris),
								scopes: scopesIn(row.scopes),
								allowedAt: row.allowedAt,
								lastSignIn: signIns.get(row.clientId) ?? null,
							}),
						),
					};
				},
			),

			takeBackApp: createAuthEndpoint(
				"/account/allowed-apps/take-back",
				{ method: "POST", use: [sessionMiddleware] },
				async (ctx) => {
					noStore(ctx);
					const me = ctx.context.session.user.id;
					const { clientId } = parseBody(
						z.strictObject({ clientId: z.string().min(1).max(100) }),
						ctx.body,
					);
					const app = await allowedBy(db, me)
						.where(
							and(eq(schema.oauthConsent.userId, me), eq(schema.oauthConsent.clientId, clientId)),
						)
						.get();
					if (!app) throw APIError.from("NOT_FOUND", NOT_ALLOWED);

					// All of it or none, and the same three tables as the trigger for someone leaving. Tokens
					// left behind would keep working, and with no row to say so the list would show nothing.
					await db.batch([
						db
							.delete(schema.oauthAccessToken)
							.where(
								and(
									eq(schema.oauthAccessToken.userId, me),
									eq(schema.oauthAccessToken.clientId, clientId),
								),
							),
						db
							.delete(schema.oauthRefreshToken)
							.where(
								and(
									eq(schema.oauthRefreshToken.userId, me),
									eq(schema.oauthRefreshToken.clientId, clientId),
								),
							),
						db
							.delete(schema.oauthConsent)
							.where(
								and(eq(schema.oauthConsent.userId, me), eq(schema.oauthConsent.clientId, clientId)),
							),
					]);

					record("consent_revoked", {
						userId: me,
						workspaceId: app.workspaceId,
						app: clientId,
						// The name is all that is left of it once it is deleted, or once they leave.
						detail: JSON.stringify({ workspace: app.workspace, name: app.name }),
						...whereFrom(ctx.headers),
					});
					return { clientId };
				},
			),
		},
		rateLimit: [
			{
				pathMatcher: (path) => path === "/account/allowed-apps/take-back",
				window: 60,
				max: 20,
			},
		],
	} satisfies BetterAuthPlugin;
}
