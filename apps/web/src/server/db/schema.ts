// D1 holds identity. Better Auth's tables are generated (see auth-schema.ts).
import { sql } from "drizzle-orm";
import {
	check,
	foreignKey,
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { member, oauthClient, organization, user } from "./auth-schema";

export * from "./auth-schema";

/**
 * "Groups" in docs/architecture.md. Part of a workspace, which an admin can narrow an app to. The two
 * tables under it carry the workspace as well, so that their foreign keys hold a person and a group,
 * or an app and a group, to the same one. Nothing can put someone in another workspace's group.
 */
export const workspaceGroup = sqliteTable(
	"workspace_group",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		/** `comparableName(name)`, since apps match on names and two that look alike would pass for one. */
		comparableName: text("comparable_name").notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		uniqueIndex("workspace_group_id_organization_unique").on(table.id, table.organizationId),
		uniqueIndex("workspace_group_name_unique").on(table.organizationId, table.comparableName),
	],
);

export const workspaceGroupMember = sqliteTable(
	"workspace_group_member",
	{
		groupId: text("group_id").notNull(),
		memberId: text("member_id").notNull(),
		organizationId: text("organization_id").notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.groupId, table.memberId] }),
		foreignKey({
			columns: [table.groupId, table.organizationId],
			foreignColumns: [workspaceGroup.id, workspaceGroup.organizationId],
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.memberId, table.organizationId],
			foreignColumns: [member.id, member.organizationId],
		}).onDelete("cascade"),
		index("workspace_group_member_member_idx").on(table.memberId),
		index("workspace_group_member_organization_idx").on(table.organizationId),
	],
);

/** The groups an app is narrowed to. An app with no rows here admits every member of its workspace. */
export const workspaceAppGroup = sqliteTable(
	"workspace_app_group",
	{
		clientId: text("client_id").notNull(),
		groupId: text("group_id").notNull(),
		organizationId: text("organization_id").notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.clientId, table.groupId] }),
		foreignKey({
			columns: [table.clientId, table.organizationId],
			foreignColumns: [oauthClient.clientId, oauthClient.referenceId],
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.groupId, table.organizationId],
			foreignColumns: [workspaceGroup.id, workspaceGroup.organizationId],
		}).onDelete("cascade"),
		index("workspace_app_group_group_idx").on(table.groupId),
		index("workspace_app_group_organization_idx").on(table.organizationId),
	],
);

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

/**
 * "Who owns a deployment" in docs/architecture.md. One row: who runs this server, and whether anyone may
 * make an account on it. The row comes from a migration, and triggers there hold what it says.
 */
export const deployment = sqliteTable(
	"deployment",
	{
		id: integer("id").primaryKey(),
		ownerId: text("owner_id").references(() => user.id, { onDelete: "set null" }),
		signUp: text("sign_up", { enum: ["closed", "open"] }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		check("deployment_one_row", sql`${table.id} = 1`),
		check("deployment_sign_up", sql`${table.signUp} IN ('closed', 'open')`),
	],
);

/** The owner vouching for an address. Whoever holds the link has it, so only its hash is kept. */
export const deploymentInvitation = sqliteTable("deployment_invitation", {
	id: text("id").primaryKey(),
	email: text("email").notNull().unique(),
	tokenHash: text("token_hash").notNull().unique(),
	invitedBy: text("invited_by")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * "Who may make an account" in docs/architecture.md. The owner's list of people who may make an account
 * while sign-up is closed: an address, lowercased, or a domain written with a leading `@`, which covers
 * that domain and not its subdomains. It names people who may have no account here, so it holds no
 * foreign keys and `added_by` is only the owner's id at the time. A trigger caps it at 5,000 entries.
 */
export const signUpAllow = sqliteTable(
	"sign_up_allow",
	{
		entry: text("entry").primaryKey(),
		note: text("note"),
		addedAt: integer("added_at", { mode: "timestamp_ms" }).notNull(),
		addedBy: text("added_by").notNull(),
	},
	(table) => [
		check("sign_up_allow_lowercase", sql`${table.entry} = lower(${table.entry})`),
		check("sign_up_allow_note", sql`length(${table.note}) <= 200`),
	],
);
