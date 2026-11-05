import { and, asc, eq, exists, notExists, or, sql } from "drizzle-orm";
import type { Database } from "../db";
import { schema } from "../db";

/** What an app's row says about it. Only the server writes this, so the check below can trust it. */
export interface AppIdentity {
	/** The app's own id, which the audit log goes by. */
	app: string;
	/** The workspace it belongs to. A first-party app has none. */
	workspace?: string | undefined;
}

/**
 * Every app carries its own id in its metadata, because the token hooks see the metadata and not
 * the client id. Nothing here can be read from a client that lacks it, so such a client gets nobody,
 * and one that names a workspace in a form this cannot read must not pass for a first-party app.
 */
export function appIn(metadata: unknown): AppIdentity | undefined {
	try {
		const parsed = typeof metadata === "string" ? JSON.parse(metadata) : metadata;
		const { app, workspace } = (parsed ?? {}) as { app?: unknown; workspace?: unknown };
		if (typeof app !== "string" || !app) return undefined;
		if (workspace === undefined) return { app };
		return typeof workspace === "string" && workspace ? { app, workspace } : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Whether this person may sign in to this app: "Who may sign in" in docs/architecture.md.
 *
 * It fails closed. If it cannot name the app or the person, it refuses. An earlier version read the
 * client id in the wrong form, got nothing, and let everyone through while its tests for permitted
 * people still passed. So a test of this check always includes someone it refuses.
 */
export async function maySignIn(
	db: Database,
	{
		user,
		app,
	}: {
		user: { id?: unknown; emailVerified?: unknown } | null | undefined;
		app: AppIdentity | undefined;
	},
): Promise<boolean> {
	if (!app || !user) return false;
	// Apps and Cloudflare Access trust the `email` claim, and rules such as "anyone at acme.com" rest
	// on it. No account exists without a verified address, and this holds even if one did.
	if (user.emailVerified !== true) return false;
	if (!app.workspace) return true;
	if (typeof user.id !== "string" || !user.id) return false;
	const { member, workspaceAppGroup: named, workspaceGroupMember: held } = schema;
	const admitted = await db
		.select({ id: member.id })
		.from(member)
		.where(
			and(
				eq(member.organizationId, app.workspace),
				eq(member.userId, user.id),
				// An app narrowed to groups with nobody in them admits nobody. One query, since this runs on
				// every token and every step of an authorization.
				or(
					notExists(db.select({ one: sql`1` }).from(named).where(eq(named.clientId, app.app))),
					exists(
						db
							.select({ one: sql`1` })
							.from(named)
							.innerJoin(held, eq(held.groupId, named.groupId))
							.where(and(eq(named.clientId, app.app), eq(held.memberId, member.id))),
					),
				),
			),
		)
		.get();
	return admitted !== undefined;
}

/**
 * The groups an app can be told of: this person's, in the app's own workspace and no other. They read
 * by name, in a stable order, as an app would compare them.
 */
export async function groupsOf(db: Database, userId: string, workspace: string): Promise<string[]> {
	const { member, workspaceGroup: group, workspaceGroupMember: held } = schema;
	const rows = await db
		.select({ name: group.name })
		.from(held)
		.innerJoin(group, eq(group.id, held.groupId))
		.innerJoin(member, eq(member.id, held.memberId))
		.where(and(eq(member.userId, userId), eq(group.organizationId, workspace)))
		.orderBy(asc(group.name))
		.all();
	return rows.map(({ name }) => name);
}

/**
 * The provider's adapter encodes the list, and the column encodes that again, so a read here gets text.
 * Read with care: a row that holds no list still names an app someone can take back, and allows nothing.
 */
export function scopesIn(stored: unknown): string[] {
	try {
		const parsed: unknown = typeof stored === "string" ? JSON.parse(stored) : stored;
		return Array.isArray(parsed) ? parsed.filter((scope) => typeof scope === "string") : [];
	} catch {
		return [];
	}
}

/**
 * Whether what someone told a workspace's app still covers what it is about to get tokens for. It
 * cannot go in the check above, which also runs before anyone has been asked. Tokens take their scopes
 * from the code, not from the consent, so without this a code handed out before they took the app back
 * would buy tokens, and if they came back and allowed less, it would buy what they had just refused.
 * A first-party app is not asked about, so there is nothing to stand.
 */
export async function stillAllowed(
	db: Database,
	{
		user,
		app,
		scopes,
	}: {
		user: { id?: unknown } | null | undefined;
		app: AppIdentity | undefined;
		scopes: string[];
	},
): Promise<boolean> {
	if (!app) return false;
	if (!app.workspace) return true;
	if (typeof user?.id !== "string" || !user.id) return false;
	const consent = await db
		.select({ scopes: schema.oauthConsent.scopes })
		.from(schema.oauthConsent)
		.where(and(eq(schema.oauthConsent.clientId, app.app), eq(schema.oauthConsent.userId, user.id)))
		.get();
	if (!consent) return false;
	const allowed = scopesIn(consent.scopes);
	return scopes.every((scope) => allowed.includes(scope));
}
