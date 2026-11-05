import type { BetterAuthPlugin, GenericEndpointContext } from "better-auth";
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { and, asc, count, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { AuditEventType } from "../../lib/audit-event";
import { appName, can, comparableName, type WorkspaceApp } from "../../lib/workspace";
import type { Database } from "../db";
import { schema } from "../db";
import {
	hostOfUris,
	newClientSecret,
	problemWithWorkspaceAppUris,
	workspaceAppRow,
} from "./app-row";
import { type RecordEvent, whereFrom } from "./audit";
import {
	noStore,
	parseBody,
	requireFreshSession,
	requireMember,
	requireRight,
	type Session,
} from "./workspace-access";

// "Apps a workspace adds" in docs/architecture.md. The provider's own client API stays closed: it takes
// fields from the caller that nothing here should, so these write a fixed row instead.

const APPS_PER_WORKSPACE = 20;
const REDIRECT_URIS_PER_APP = 5;

/** Names people take on trust, which no workspace's app may wear. */

const NO_APP = { code: "APP_NOT_FOUND", message: "That app is not in this workspace." };

const inWorkspace = { organizationId: z.string().min(1).max(100) };
const anApp = { ...inWorkspace, clientId: z.string().min(1).max(100) };
const details = {
	name: appName,
	redirectUris: z
		.array(z.string().max(2000, "That redirect URI is too long."))
		.min(1, "Enter where the app sends people back to.")
		.max(REDIRECT_URIS_PER_APP, `An app can have at most ${REDIRECT_URIS_PER_APP} redirect URIs.`),
};

interface AppsConfig {
	db: Database;
	/** The deployment's origin, which no app may send anyone back to. */
	issuer: string;
	record: RecordEvent;
}

/** What a workspace's admins see of its apps. Explicit columns, so the secret's hash stays here. */
export async function appsOf(db: Database, workspaceId: string): Promise<WorkspaceApp[]> {
	const rows = await db
		.select({
			clientId: schema.oauthClient.clientId,
			name: schema.oauthClient.name,
			redirectUris: schema.oauthClient.redirectUris,
		})
		.from(schema.oauthClient)
		.where(eq(schema.oauthClient.referenceId, workspaceId))
		.orderBy(asc(schema.oauthClient.createdAt))
		.all();
	const named = await db
		.select({
			clientId: schema.workspaceAppGroup.clientId,
			groupId: schema.workspaceAppGroup.groupId,
		})
		.from(schema.workspaceAppGroup)
		.where(eq(schema.workspaceAppGroup.organizationId, workspaceId))
		.all();
	return rows.map(({ clientId, name, redirectUris }) => ({
		clientId,
		name: name ?? "",
		redirectUris: urisIn(redirectUris),
		groups: named.filter((row) => row.clientId === clientId).map((row) => row.groupId),
	}));
}

function urisIn(stored: unknown): string[] {
	return Array.isArray(stored) ? stored.filter((uri) => typeof uri === "string") : [];
}

async function requireManager(db: Database, workspaceId: string, session: Session) {
	requireRight(can(await requireMember(db, workspaceId, session), "manageApps"));
}

/** One of this workspace's apps. Another's, and a first-party app, are nothing here. */
async function requireApp(db: Database, workspaceId: string, clientId: string) {
	const app = await db
		.select({
			clientId: schema.oauthClient.clientId,
			name: schema.oauthClient.name,
			redirectUris: schema.oauthClient.redirectUris,
		})
		.from(schema.oauthClient)
		.where(
			and(
				eq(schema.oauthClient.clientId, clientId),
				eq(schema.oauthClient.referenceId, workspaceId),
			),
		)
		.get();
	if (!app) throw APIError.from("NOT_FOUND", NO_APP);
	return app;
}

function refuse(message: string): never {
	throw APIError.from("BAD_REQUEST", { code: "INVALID_REQUEST", message });
}

/**
 * An admin can call an app what they like, and people see that name when they are asked. It only
 * takes the names people already trust off the table. The screen always says whose it is and where it
 * goes, and it reaches only people who accepted an invitation to that workspace.
 */
async function requireFreeName(db: Database, name: string) {
	const firstParty = await db
		.select({ name: schema.oauthClient.name })
		.from(schema.oauthClient)
		.where(isNull(schema.oauthClient.referenceId))
		.all();
	const wanted = comparableName(name);
	if (firstParty.some((app) => app.name && comparableName(app.name) === wanted)) {
		refuse("That name belongs to an app that everyone here can use. Choose another.");
	}
}

async function workspaceNameOf(db: Database, workspaceId: string) {
	const row = await db
		.select({ name: schema.organization.name })
		.from(schema.organization)
		.where(eq(schema.organization.id, workspaceId))
		.get();
	return row?.name;
}

export function workspaceAppsPlugin({ db, issuer, record }: AppsConfig): BetterAuthPlugin {
	/** `app` is what the log resolves to a name, while the app exists, and `detail` outlives it. */
	function log(
		type: AuditEventType,
		ctx: GenericEndpointContext,
		session: Session,
		workspaceId: string,
		app: { clientId: string; name: string | null; redirectUris?: string[] },
	) {
		const from = whereFrom(ctx.headers);
		record(type, async () => ({
			userId: session.user.id,
			actorId: session.user.id,
			workspaceId,
			app: app.clientId,
			detail: JSON.stringify({
				workspace: await workspaceNameOf(db, workspaceId),
				name: app.name,
				// Where an app sends people is what someone looking into it would want to know.
				redirectUris: app.redirectUris,
			}),
			...from,
		}));
	}

	return {
		id: "workspace-apps",
		endpoints: {
			addWorkspaceApp: createAuthEndpoint(
				"/workspaces/apps/add",
				{ method: "POST", use: [sessionMiddleware] },
				async (ctx) => {
					noStore(ctx);
					const { session } = ctx.context;
					const { organizationId, name, redirectUris } = parseBody(
						z.strictObject({ ...inWorkspace, ...details }),
						ctx.body,
					);
					await requireManager(db, organizationId, session);
					// The secret it answers with gets at every member who agrees, so it outlasts a stolen cookie.
					requireFreshSession(session, ctx);
					const problem = problemWithWorkspaceAppUris(redirectUris, issuer);
					if (problem) refuse(problem);
					await requireFreeName(db, name);
					const held = await db
						.select({ apps: count() })
						.from(schema.oauthClient)
						.where(eq(schema.oauthClient.referenceId, organizationId))
						.get();
					if ((held?.apps ?? 0) >= APPS_PER_WORKSPACE) {
						refuse("This workspace has as many apps as it can hold. Delete one first.");
					}

					const { row, clientId, clientSecret } = workspaceAppRow({
						workspace: organizationId,
						name,
						redirectUris,
					});
					const entries = Object.entries(row);
					const columns = sql.raw(entries.map(([column]) => `"${column}"`).join(", "));
					const values = sql.join(
						entries.map(([, value]) => sql`${value}`),
						sql`, `,
					);
					await db.run(sql`INSERT INTO "oauth_client" (${columns}) VALUES (${values})`);

					log("app_added", ctx, session, organizationId, { clientId, name, redirectUris });
					return { clientId, clientSecret };
				},
			),

			changeWorkspaceApp: createAuthEndpoint(
				"/workspaces/apps/change",
				{ method: "POST", use: [sessionMiddleware] },
				async (ctx) => {
					noStore(ctx);
					const { session } = ctx.context;
					const { organizationId, clientId, name, redirectUris } = parseBody(
						z.strictObject({ ...anApp, ...details }),
						ctx.body,
					);
					await requireManager(db, organizationId, session);
					const app = await requireApp(db, organizationId, clientId);
					const problem = problemWithWorkspaceAppUris(redirectUris, issuer);
					if (problem) refuse(problem);
					// People agreed to this host, and their ids in the app are computed from it. Moving would
					// send them somewhere they did not agree to, without asking, as someone new.
					if (hostOfUris(redirectUris) !== hostOfUris(urisIn(app.redirectUris))) {
						refuse("An app stays on its host. To move, add a new app there and delete this one.");
					}
					await requireFreeName(db, name);
					await db
						.update(schema.oauthClient)
						.set({ name, redirectUris, updatedAt: new Date() })
						.where(eq(schema.oauthClient.clientId, clientId))
						.run();
					log("app_changed", ctx, session, organizationId, { clientId, name, redirectUris });
					return { clientId };
				},
			),

			replaceWorkspaceAppSecret: createAuthEndpoint(
				"/workspaces/apps/replace-secret",
				{ method: "POST", use: [sessionMiddleware] },
				async (ctx) => {
					noStore(ctx);
					const { session } = ctx.context;
					const { organizationId, clientId } = parseBody(z.strictObject(anApp), ctx.body);
					await requireManager(db, organizationId, session);
					requireFreshSession(session, ctx);
					const app = await requireApp(db, organizationId, clientId);
					const { clientSecret, hashed } = newClientSecret();
					await db
						.update(schema.oauthClient)
						.set({ clientSecret: hashed, updatedAt: new Date() })
						.where(eq(schema.oauthClient.clientId, clientId))
						.run();
					log("app_secret_replaced", ctx, session, organizationId, {
						clientId,
						name: app.name,
					});
					return { clientSecret };
				},
			),

			deleteWorkspaceApp: createAuthEndpoint(
				"/workspaces/apps/delete",
				{ method: "POST", use: [sessionMiddleware] },
				async (ctx) => {
					noStore(ctx);
					const { session } = ctx.context;
					const { organizationId, clientId } = parseBody(z.strictObject(anApp), ctx.body);
					await requireManager(db, organizationId, session);
					// It cannot be undone, and it ends everyone's access to the app.
					requireFreshSession(session, ctx);
					const app = await requireApp(db, organizationId, clientId);
					// Its tokens and consents have foreign keys to it, and go with it.
					await db
						.delete(schema.oauthClient)
						.where(eq(schema.oauthClient.clientId, clientId))
						.run();
					log("app_deleted", ctx, session, organizationId, { clientId, name: app.name });
					return { clientId };
				},
			),
		},
		rateLimit: [
			{ pathMatcher: (path) => path === "/workspaces/apps/add", window: 60, max: 5 },
			{ pathMatcher: (path) => path.startsWith("/workspaces/apps/"), window: 60, max: 20 },
		],
	} satisfies BetterAuthPlugin;
}
