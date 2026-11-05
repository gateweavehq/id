import type { BetterAuthPlugin, GenericEndpointContext } from "better-auth";
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { and, asc, count, eq, inArray, notInArray } from "drizzle-orm";
import { z } from "zod";
import type { AuditEventType } from "../../lib/audit-event";
import { can, comparableName, groupName, type WorkspaceGroup } from "../../lib/workspace";
import type { Database } from "../db";
import { schema } from "../db";
import { type RecordEvent, whereFrom } from "./audit";
import {
	type Member,
	noStore,
	parseBody,
	requireFreshSession,
	requireMember,
	requireRight,
	type Session,
} from "./workspace-access";

// "Groups" in docs/architecture.md. These are our own tables rather than the organization plugin's
// teams, which hold nothing to the workspace but its own code, and bring columns on every session.

const GROUPS_PER_WORKSPACE = 50;

const NO_GROUP = { code: "GROUP_NOT_FOUND", message: "That group is not in this workspace." };
const NO_MEMBER = { code: "MEMBER_NOT_FOUND", message: "That person is not in this workspace." };
const NO_APP = { code: "APP_NOT_FOUND", message: "That app is not in this workspace." };
const LIST_CHANGED = {
	code: "APP_GROUPS_CHANGED",
	message:
		"Someone else has just changed who can use this app. Check it, and save again if you still want to.",
};

const id = z.string().min(1).max(100);
const inWorkspace = { organizationId: id };
const aGroup = { ...inWorkspace, groupId: id };
const aMembership = { ...aGroup, memberId: id };

interface GroupsConfig {
	db: Database;
	record: RecordEvent;
}

/**
 * Admins see every group, and who is in it, because they decide. A member sees the groups they are in,
 * since an app can be told those, and of the people in them only themselves.
 */
export async function groupsSeenBy(
	db: Database,
	workspaceId: string,
	you: Member,
): Promise<WorkspaceGroup[]> {
	const { workspaceGroup: group, workspaceGroupMember: held } = schema;
	if (!can(you, "manageGroups")) {
		const rows = await db
			.select({ id: group.id, name: group.name })
			.from(held)
			.innerJoin(group, eq(group.id, held.groupId))
			.where(and(eq(held.memberId, you.id), eq(group.organizationId, workspaceId)))
			.orderBy(asc(group.name))
			.all();
		return rows.map((row) => ({ ...row, members: [you.id] }));
	}
	const groups = await db
		.select({ id: group.id, name: group.name })
		.from(group)
		.where(eq(group.organizationId, workspaceId))
		.orderBy(asc(group.name))
		.all();
	const members = await db
		.select({ groupId: held.groupId, memberId: held.memberId })
		.from(held)
		.where(eq(held.organizationId, workspaceId))
		.orderBy(asc(held.createdAt))
		.all();
	return groups.map((row) => ({
		...row,
		members: members.filter(({ groupId }) => groupId === row.id).map(({ memberId }) => memberId),
	}));
}

async function requireManager(db: Database, workspaceId: string, session: Session) {
	requireRight(can(await requireMember(db, workspaceId, session), "manageGroups"));
}

/** One of this workspace's groups. Another's is nothing here. */
async function requireGroup(db: Database, workspaceId: string, groupId: string) {
	const { workspaceGroup: group } = schema;
	const found = await db
		.select({ id: group.id, name: group.name })
		.from(group)
		.where(and(eq(group.id, groupId), eq(group.organizationId, workspaceId)))
		.get();
	if (!found) throw APIError.from("NOT_FOUND", NO_GROUP);
	return found;
}

function refuse(code: string, message: string): never {
	throw APIError.from("BAD_REQUEST", { code, message });
}

async function requireFreeName(
	db: Database,
	workspaceId: string,
	comparable: string,
	exceptGroup?: string,
) {
	const { workspaceGroup: group } = schema;
	const taken = await db
		.select({ id: group.id })
		.from(group)
		.where(and(eq(group.organizationId, workspaceId), eq(group.comparableName, comparable)))
		.get();
	if (taken && taken.id !== exceptGroup) {
		refuse("GROUP_NAME_TAKEN", "This workspace has a group with that name, or one very like it.");
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

/** What someone an app is narrowed away from loses: all they hold for it, as when they leave. */
function endAccessOfThoseOutside(db: Database, clientId: string) {
	const {
		member,
		oauthAccessToken: access,
		oauthConsent: consent,
		oauthRefreshToken: refresh,
		workspaceAppGroup: named,
		workspaceGroupMember: held,
	} = schema;
	const admitted = db
		.select({ userId: member.userId })
		.from(named)
		.innerJoin(held, eq(held.groupId, named.groupId))
		.innerJoin(member, eq(member.id, held.memberId))
		.where(eq(named.clientId, clientId));
	return [
		db
			.delete(access)
			.where(and(eq(access.clientId, clientId), notInArray(access.userId, admitted))),
		db
			.delete(refresh)
			.where(and(eq(refresh.clientId, clientId), notInArray(refresh.userId, admitted))),
		db
			.delete(consent)
			.where(and(eq(consent.clientId, clientId), notInArray(consent.userId, admitted))),
	] as const;
}

export function workspaceGroupsPlugin({ db, record }: GroupsConfig): BetterAuthPlugin {
	/** `user_id` is who it happened to and `actor_id` who did it. An admin's change, both can see. */
	function log(
		type: AuditEventType,
		ctx: GenericEndpointContext,
		session: Session,
		workspaceId: string,
		detail: { group: string; was?: string; target?: string | undefined },
	) {
		const from = whereFrom(ctx.headers);
		record(type, async () => ({
			userId: detail.target ?? session.user.id,
			actorId: session.user.id,
			workspaceId,
			detail: JSON.stringify({
				workspace: await workspaceNameOf(db, workspaceId),
				group: detail.group,
				was: detail.was,
			}),
			...from,
		}));
	}

	return {
		id: "workspace-groups",
		endpoints: {
			createWorkspaceGroup: createAuthEndpoint(
				"/workspaces/groups/create",
				{ method: "POST", use: [sessionMiddleware] },
				async (ctx) => {
					noStore(ctx);
					const { session } = ctx.context;
					const { organizationId, name } = parseBody(
						z.strictObject({ ...inWorkspace, name: groupName }),
						ctx.body,
					);
					await requireManager(db, organizationId, session);
					const comparable = comparableName(name);
					await requireFreeName(db, organizationId, comparable);
					const held = await db
						.select({ groups: count() })
						.from(schema.workspaceGroup)
						.where(eq(schema.workspaceGroup.organizationId, organizationId))
						.get();
					if ((held?.groups ?? 0) >= GROUPS_PER_WORKSPACE) {
						refuse(
							"TOO_MANY_GROUPS",
							"This workspace has as many groups as it can hold. Delete one first.",
						);
					}
					const now = new Date();
					const groupId = crypto.randomUUID();
					await db
						.insert(schema.workspaceGroup)
						.values({
							id: groupId,
							organizationId,
							name,
							comparableName: comparable,
							createdAt: now,
							updatedAt: now,
						})
						.run();
					log("group_created", ctx, session, organizationId, { group: name });
					return { id: groupId };
				},
			),

			renameWorkspaceGroup: createAuthEndpoint(
				"/workspaces/groups/rename",
				{ method: "POST", use: [sessionMiddleware] },
				async (ctx) => {
					noStore(ctx);
					const { session } = ctx.context;
					const { organizationId, groupId, name } = parseBody(
						z.strictObject({ ...aGroup, name: groupName }),
						ctx.body,
					);
					await requireManager(db, organizationId, session);
					// Apps can be set up to match on a name, so this can hand out what they give.
					requireFreshSession(session, ctx);
					const { name: was } = await requireGroup(db, organizationId, groupId);
					const comparable = comparableName(name);
					await requireFreeName(db, organizationId, comparable, groupId);
					await db
						.update(schema.workspaceGroup)
						.set({ name, comparableName: comparable, updatedAt: new Date() })
						.where(eq(schema.workspaceGroup.id, groupId))
						.run();
					log("group_renamed", ctx, session, organizationId, { group: name, was });
					return { id: groupId };
				},
			),

			deleteWorkspaceGroup: createAuthEndpoint(
				"/workspaces/groups/delete",
				{ method: "POST", use: [sessionMiddleware] },
				async (ctx) => {
					noStore(ctx);
					const { session } = ctx.context;
					const { organizationId, groupId } = parseBody(z.strictObject(aGroup), ctx.body);
					await requireManager(db, organizationId, session);
					const group = await requireGroup(db, organizationId, groupId);
					// The database holds to this too (`group_an_app_names_stays`). This is what says why.
					const naming = await db
						.select({ name: schema.oauthClient.name })
						.from(schema.workspaceAppGroup)
						.innerJoin(
							schema.oauthClient,
							eq(schema.oauthClient.clientId, schema.workspaceAppGroup.clientId),
						)
						.where(eq(schema.workspaceAppGroup.groupId, groupId))
						.orderBy(asc(schema.oauthClient.name))
						.all();
					if (naming.length > 0) {
						const apps = naming.map(({ name }) => name).join(", ");
						refuse("GROUP_IN_USE", `Used by ${apps}. Change who can use it first.`);
					}
					await db.delete(schema.workspaceGroup).where(eq(schema.workspaceGroup.id, groupId)).run();
					log("group_deleted", ctx, session, organizationId, { group: group.name });
					return { id: groupId };
				},
			),

			addToWorkspaceGroup: createAuthEndpoint(
				"/workspaces/groups/add-member",
				{ method: "POST", use: [sessionMiddleware] },
				async (ctx) => {
					noStore(ctx);
					const { session } = ctx.context;
					const { organizationId, groupId, memberId } = parseBody(
						z.strictObject(aMembership),
						ctx.body,
					);
					await requireManager(db, organizationId, session);
					// This can open an app to them, and whatever an app gives to those in the group.
					requireFreshSession(session, ctx);
					const group = await requireGroup(db, organizationId, groupId);
					const target = await db
						.select({ userId: schema.member.userId })
						.from(schema.member)
						.where(
							and(eq(schema.member.id, memberId), eq(schema.member.organizationId, organizationId)),
						)
						.get();
					if (!target) throw APIError.from("NOT_FOUND", NO_MEMBER);
					const added = await db
						.insert(schema.workspaceGroupMember)
						.values({ groupId, memberId, organizationId, createdAt: new Date() })
						.onConflictDoNothing()
						.returning({ memberId: schema.workspaceGroupMember.memberId })
						.get();
					if (added) {
						log("group_member_added", ctx, session, organizationId, {
							group: group.name,
							target: target.userId,
						});
					}
					return { memberId };
				},
			),

			removeFromWorkspaceGroup: createAuthEndpoint(
				"/workspaces/groups/remove-member",
				{ method: "POST", use: [sessionMiddleware] },
				async (ctx) => {
					noStore(ctx);
					const { session } = ctx.context;
					const { organizationId, groupId, memberId } = parseBody(
						z.strictObject(aMembership),
						ctx.body,
					);
					await requireManager(db, organizationId, session);
					const group = await requireGroup(db, organizationId, groupId);
					const target = await db
						.select({ userId: schema.member.userId })
						.from(schema.member)
						.where(
							and(eq(schema.member.id, memberId), eq(schema.member.organizationId, organizationId)),
						)
						.get();
					if (!target) throw APIError.from("NOT_FOUND", NO_MEMBER);
					// What they lose by this goes with the row (`group_member_delete_ends_app_access`).
					const removed = await db
						.delete(schema.workspaceGroupMember)
						.where(
							and(
								eq(schema.workspaceGroupMember.groupId, groupId),
								eq(schema.workspaceGroupMember.memberId, memberId),
							),
						)
						.returning({ memberId: schema.workspaceGroupMember.memberId })
						.get();
					if (removed) {
						log("group_member_removed", ctx, session, organizationId, {
							group: group.name,
							target: target.userId,
						});
					}
					return { memberId };
				},
			),

			setWorkspaceAppGroups: createAuthEndpoint(
				"/workspaces/apps/set-groups",
				{ method: "POST", use: [sessionMiddleware] },
				async (ctx) => {
					noStore(ctx);
					const { session } = ctx.context;
					const { organizationId, clientId, groups, was } = parseBody(
						z.strictObject({
							...inWorkspace,
							clientId: id,
							// None at all is a choice: every member. The page asks for it by name.
							groups: z.array(id).max(GROUPS_PER_WORKSPACE),
							// What the page was showing when this was chosen.
							was: z.array(id).max(GROUPS_PER_WORKSPACE),
						}),
						ctx.body,
					);
					await requireManager(db, organizationId, session);
					// It can open an app to everyone, or end everyone's access, as deleting it does.
					requireFreshSession(session, ctx);
					const app = await db
						.select({ name: schema.oauthClient.name })
						.from(schema.oauthClient)
						.where(
							and(
								eq(schema.oauthClient.clientId, clientId),
								eq(schema.oauthClient.referenceId, organizationId),
							),
						)
						.get();
					if (!app) throw APIError.from("NOT_FOUND", NO_APP);
					const { workspaceAppGroup: named } = schema;
					// A page left open since before someone narrowed this app says it is open to everyone, and
					// saved as it stands would make it so, with nobody having chosen that.
					const current = await db
						.select({ groupId: named.groupId })
						.from(named)
						.where(eq(named.clientId, clientId))
						.all();
					const saw = new Set(was);
					if (current.length !== saw.size || current.some(({ groupId }) => !saw.has(groupId))) {
						throw APIError.from("CONFLICT", LIST_CHANGED);
					}
					const wanted = [...new Set(groups)];
					const found =
						wanted.length > 0
							? await db
									.select({ name: schema.workspaceGroup.name })
									.from(schema.workspaceGroup)
									.where(
										and(
											eq(schema.workspaceGroup.organizationId, organizationId),
											inArray(schema.workspaceGroup.id, wanted),
										),
									)
									.all()
							: [];
					if (found.length !== wanted.length) throw APIError.from("NOT_FOUND", NO_GROUP);
					const now = new Date();
					// One batch, so nobody sees a list halfway. Those it leaves out lose what they hold only
					// once the whole list is in, and an app opened to everyone takes nothing from anyone.
					await db.batch([
						db
							.delete(named)
							.where(
								and(
									eq(named.clientId, clientId),
									...(wanted.length > 0 ? [notInArray(named.groupId, wanted)] : []),
								),
							),
						...wanted.map((groupId) =>
							db
								.insert(named)
								.values({ clientId, groupId, organizationId, createdAt: now })
								.onConflictDoNothing(),
						),
						...(wanted.length > 0 ? endAccessOfThoseOutside(db, clientId) : []),
					]);
					const from = whereFrom(ctx.headers);
					record("app_groups_changed", async () => ({
						userId: session.user.id,
						actorId: session.user.id,
						workspaceId: organizationId,
						app: clientId,
						detail: JSON.stringify({
							workspace: await workspaceNameOf(db, organizationId),
							name: app.name,
							groups: found.map(({ name }) => name),
						}),
						...from,
					}));
					return { clientId };
				},
			),
		},
		rateLimit: [
			// An admin setting up a team adds people one at a time.
			{ pathMatcher: (path) => path.startsWith("/workspaces/groups/"), window: 60, max: 60 },
		],
	} satisfies BetterAuthPlugin;
}
