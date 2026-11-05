import { and, eq } from "drizzle-orm";
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
	const member = await db
		.select({ id: schema.member.id })
		.from(schema.member)
		.where(and(eq(schema.member.organizationId, app.workspace), eq(schema.member.userId, user.id)))
		.get();
	return member !== undefined;
}
