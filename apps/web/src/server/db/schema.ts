// D1 holds identity. Better Auth's tables are generated (see auth-schema.ts).
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export * from "./auth-schema";

/**
 * "Audit log" in docs/architecture.md. It holds no foreign keys, because a log someone can empty by
 * deleting what it talks about is no log, and the cron removes every row on its own schedule. It
 * holds no addresses either: `user_id` and `actor_id` say who, and only for someone with an account
 * here, so an invitation to an address nobody has used keeps nothing of it once it is gone.
 */
export const auditEvent = sqliteTable(
	"audit_event",
	{
		id: text("id").primaryKey(),
		at: integer("at", { mode: "timestamp_ms" }).notNull(),
		type: text("type").notNull(),
		/** Who it happened to. None for what no person can be named for, such as an app revoking a token. */
		userId: text("user_id"),
		/** Who did it, where a workspace's admin can do it to someone else. */
		actorId: text("actor_id"),
		/** The workspace it happened in. Its name, in `detail`, outlives it. */
		workspaceId: text("workspace_id"),
		/** The app's own id, from `metadata.app`, which outlives the app's client id. */
		app: text("app"),
		ip: text("ip"),
		/** "Chrome on Windows", as a person would recognize it, and not the whole user agent. */
		device: text("device"),
		/** What the type leaves open, such as how someone signed in. */
		detail: text("detail"),
	},
	(table) => [
		index("audit_event_user_at_idx").on(table.userId, table.at),
		index("audit_event_actor_at_idx").on(table.actorId, table.at),
		index("audit_event_workspace_at_idx").on(table.workspaceId, table.at),
		index("audit_event_at_idx").on(table.at),
	],
);
