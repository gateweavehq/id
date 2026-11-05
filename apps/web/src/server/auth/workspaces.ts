import type { BetterAuthPlugin, GenericEndpointContext } from "better-auth";
import {
	APIError,
	createAuthEndpoint,
	createAuthMiddleware,
	getSessionFromCtx,
	isAPIError,
	sessionMiddleware,
} from "better-auth/api";
import { organization } from "better-auth/plugins/organization";
import { and, asc, count, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import type { AuditEventType } from "../../lib/audit-event";
import {
	can,
	INVITED_ROLES,
	type InvitationForYou,
	type PendingInvitation,
	WORKSPACE_ROLES,
	type WorkspaceDetails,
	type WorkspaceMember,
	type WorkspaceSummary,
	workspaceName,
	workspaceSlug,
} from "../../lib/workspace";
import type { Database } from "../db";
import { schema } from "../db";
import type { Mailer } from "../email/mailer";
import { workspaceInvitationEmail } from "../email/templates";
import { type RecordEvent, whereFrom } from "./audit";
import {
	mayInviteTo,
	mayMakeWorkspaces,
	ONLY_THE_OWNER_MAKES_WORKSPACES,
	WORKSPACE_CANNOT_INVITE,
} from "./deployment";
import {
	type Member,
	memberOf,
	NO_WORKSPACE,
	noStore,
	parseBody,
	requireFreshSession,
	requireMember,
	requireRight,
	type Session,
} from "./workspace-access";
import { appsOf } from "./workspace-apps";
import { groupsSeenBy } from "./workspace-groups";

// "Workspaces" in docs/architecture.md. The organization plugin keeps the rows; every request to it
// comes through the gate below first, so what a person can do is what this file lets through.

const ORGANIZATION_PATHS = "/organization/";

/** Workspaces one person can own. Those they only belong to do not count: nobody chooses invitations. */
export const WORKSPACES_PER_OWNER = 10;
const MEMBERS_PER_WORKSPACE = 500;
const INVITATION_LIFETIME_DAYS = 7;

const NO_INVITATION = {
	code: "INVITATION_NOT_FOUND",
	message:
		"That invitation does not exist, or it is not for this account. It may have expired or been withdrawn.",
};
const NO_MEMBER = { code: "MEMBER_NOT_FOUND", message: "That person is not in this workspace." };
const LAST_OWNER = {
	code: "LAST_OWNER",
	message: "A workspace needs an owner. Make someone else an owner first.",
};

interface WorkspacesConfig {
	db: Database;
	baseURL: string | undefined;
	/** Without it, an invitation waits to be found, and whoever made it says so themselves. */
	mailer: Mailer | undefined;
	record: RecordEvent;
	/** Whether this deployment has a provider for apps to sign people in through. */
	appsEnabled: boolean;
	/** Whether this person may send another invitation, to this address. Unlimited without it. */
	allowInvitation: ((inviterId: string, email: string) => Promise<boolean>) | undefined;
}

async function ownersOf(db: Database, workspaceId: string): Promise<number> {
	const row = await db
		.select({ owners: count() })
		.from(schema.member)
		.where(and(eq(schema.member.organizationId, workspaceId), eq(schema.member.role, "owner")))
		.get();
	return row?.owners ?? 0;
}

/** A member of this workspace. Another workspace's member is nobody here. */
async function requireTarget(db: Database, workspaceId: string, memberId: string): Promise<Member> {
	const target = await db
		.select({ id: schema.member.id, role: schema.member.role })
		.from(schema.member)
		.where(and(eq(schema.member.id, memberId), eq(schema.member.organizationId, workspaceId)))
		.get();
	if (!target) throw APIError.from("NOT_FOUND", NO_MEMBER);
	return target;
}

/** Open invitations this person can act on, one or all. An address they have not proven has none. */
function invitationsFor(
	db: Database,
	user: Session["user"],
	invitationId?: string,
): Promise<InvitationForYou[]> {
	const { invitation, organization: workspace } = schema;
	const open = and(
		eq(invitation.email, user.email.toLowerCase()),
		eq(invitation.status, "pending"),
		gt(invitation.expiresAt, new Date()),
		invitationId ? eq(invitation.id, invitationId) : undefined,
		// Nothing makes an account without one today, and this must hold if that ever changes.
		user.emailVerified ? undefined : sql`0`,
	);
	return db
		.select({
			id: invitation.id,
			workspace: workspace.name,
			role: invitation.role,
			inviter: schema.user.email,
		})
		.from(invitation)
		.innerJoin(workspace, eq(workspace.id, invitation.organizationId))
		.leftJoin(schema.user, eq(schema.user.id, invitation.inviterId))
		.where(open)
		.orderBy(asc(invitation.createdAt))
		.all();
}

async function requireInvitationFor(db: Database, session: Session, invitationId: string) {
	const [found] = await invitationsFor(db, session.user, invitationId);
	if (!found) throw APIError.from("NOT_FOUND", NO_INVITATION);
}

type Check = (raw: unknown, session: Session, ctx: GenericEndpointContext) => Promise<void>;

/** A rule's body schema is strict, so nothing the plugin accepts and no page sends gets through. */
/**
 * An admin can add an app and take its secret, which want a recent sign-in. Making one wants it too, or
 * a stolen cookie could make its thief an admin, with a session as new as they like.
 */
function requireFreshToGrant(role: string, session: Session, ctx: GenericEndpointContext) {
	if (role !== "member") requireFreshSession(session, ctx);
}

function rule<Body>(
	body: z.ZodType<Body>,
	allow: (input: Body, session: Session, ctx: GenericEndpointContext) => Promise<void>,
): Check {
	return async (raw, session, ctx) => {
		await allow(parseBody(body, raw), session, ctx);
	};
}

const id = z.string().min(1).max(100);
const inWorkspace = { organizationId: id };
const invitationOnly = z.strictObject({ invitationId: id });

/**
 * Every path of the plugin that can be reached. One that is not here answers 404, including those a
 * later version adds, and each reads what it needs from a strict body rather than the session's
 * "active" workspace, which a person cannot see and this does not use.
 */
function gateRules({ db, allowInvitation }: WorkspacesConfig): Record<string, Check> {
	return {
		"/organization/create": rule(
			z.strictObject({ name: workspaceName, slug: workspaceSlug }),
			async (_body, session) => {
				if (!(await mayMakeWorkspaces(db, session.user.id))) {
					throw APIError.from("FORBIDDEN", ONLY_THE_OWNER_MAKES_WORKSPACES);
				}
			},
		),
		"/organization/update": rule(
			z.strictObject({ ...inWorkspace, data: z.strictObject({ name: workspaceName }) }),
			async ({ organizationId }, session) => {
				requireRight(can(await requireMember(db, organizationId, session), "rename"));
			},
		),
		"/organization/delete": rule(
			z.strictObject(inWorkspace),
			async ({ organizationId }, session, ctx) => {
				requireRight(can(await requireMember(db, organizationId, session), "delete"));
				// It cannot be undone and takes every member's place with it.
				requireFreshSession(session, ctx);
			},
		),
		"/organization/leave": rule(
			z.strictObject(inWorkspace),
			async ({ organizationId }, session) => {
				const member = await requireMember(db, organizationId, session);
				requireRight(can(member, "leave"));
				if (member.role === "owner" && (await ownersOf(db, organizationId)) <= 1) {
					throw APIError.from("BAD_REQUEST", LAST_OWNER);
				}
			},
		),
		"/organization/invite-member": rule(
			z.strictObject({
				...inWorkspace,
				email: z.email("Enter an email address.").max(254),
				role: z.enum(INVITED_ROLES),
			}),
			async ({ organizationId, email, role }, session, ctx) => {
				requireRight(can(await requireMember(db, organizationId, session), "invite"));
				requireFreshToGrant(role, session, ctx);
				if (!(await mayInviteTo(db, organizationId))) {
					throw APIError.from("FORBIDDEN", WORKSPACE_CANNOT_INVITE);
				}
				if (allowInvitation && !(await allowInvitation(session.user.id, email.toLowerCase()))) {
					throw APIError.from("TOO_MANY_REQUESTS", {
						code: "TOO_MANY_INVITATIONS",
						message: "Too many invitations lately, from you or to that address. Try again later.",
					});
				}
			},
		),
		"/organization/cancel-invitation": rule(invitationOnly, async ({ invitationId }, session) => {
			const found = await db
				.select({ workspaceId: schema.invitation.organizationId })
				.from(schema.invitation)
				.where(eq(schema.invitation.id, invitationId))
				.get();
			const member = found && (await memberOf(db, found.workspaceId, session.user.id));
			if (!member) throw APIError.from("NOT_FOUND", NO_INVITATION);
			requireRight(can(member, "cancelInvitation"));
		}),
		"/organization/accept-invitation": rule(invitationOnly, ({ invitationId }, session) =>
			requireInvitationFor(db, session, invitationId),
		),
		"/organization/reject-invitation": rule(invitationOnly, ({ invitationId }, session) =>
			requireInvitationFor(db, session, invitationId),
		),
		"/organization/remove-member": rule(
			z.strictObject({ ...inWorkspace, memberIdOrEmail: id }),
			async ({ organizationId, memberIdOrEmail }, session) => {
				const actor = await requireMember(db, organizationId, session);
				const target = await requireTarget(db, organizationId, memberIdOrEmail);
				requireRight(can(actor, "removeMember", target));
				if (target.id === actor.id) {
					throw APIError.from("BAD_REQUEST", {
						code: "LEAVE_INSTEAD",
						message: "To take yourself out of a workspace, leave it.",
					});
				}
			},
		),
		"/organization/update-member-role": rule(
			z.strictObject({ ...inWorkspace, memberId: id, role: z.enum(WORKSPACE_ROLES) }),
			async ({ organizationId, memberId, role }, session, ctx) => {
				const actor = await requireMember(db, organizationId, session);
				const target = await requireTarget(db, organizationId, memberId);
				requireRight(can(actor, "changeRole", { role: target.role, to: role }));
				requireFreshToGrant(role, session, ctx);
				if (target.role === "owner" && role !== "owner") {
					if ((await ownersOf(db, organizationId)) <= 1) {
						throw APIError.from("BAD_REQUEST", LAST_OWNER);
					}
				}
			},
		),
	};
}

/** What the log keeps about a workspace beyond its id, which is all that is left once it is gone. */
function detailOf(workspace: string | undefined, role?: string) {
	return JSON.stringify({ workspace, role });
}

async function nameOf(db: Database, workspaceId: string) {
	const row = await db
		.select({ name: schema.organization.name })
		.from(schema.organization)
		.where(eq(schema.organization.id, workspaceId))
		.get();
	return row?.name;
}

/** What the plugin answers at the paths below, as far as they need it. */
interface Answer {
	id?: string;
	name?: string;
	organizationId?: string;
	userId?: string;
	role?: string;
	member?: { organizationId: string; userId: string; role: string } | null;
	invitation?: { organizationId: string };
}

/**
 * What each successful request did and to whom. `user_id` is who it happened to, and `actor_id` who
 * did it: the same person, unless an admin did it to someone else, and then both see it.
 */
const WORKSPACE_EVENTS: Record<
	string,
	(answer: Answer) => {
		type: AuditEventType;
		workspaceId: string | undefined;
		target?: string | undefined;
		role?: string | undefined;
		name?: string | undefined;
	}
> = {
	"/organization/create": (answer) => ({
		type: "workspace_created",
		workspaceId: answer.id,
		name: answer.name,
	}),
	"/organization/update": (answer) => ({
		type: "workspace_renamed",
		workspaceId: answer.id,
		name: answer.name,
	}),
	"/organization/delete": (answer) => ({
		type: "workspace_deleted",
		workspaceId: answer.id,
		name: answer.name,
	}),
	"/organization/leave": (answer) => ({
		type: "member_left",
		workspaceId: answer.organizationId,
	}),
	"/organization/invite-member": (answer) => ({
		type: "member_invited",
		workspaceId: answer.organizationId,
		role: answer.role,
	}),
	"/organization/cancel-invitation": (answer) => ({
		type: "invitation_canceled",
		workspaceId: answer.organizationId,
	}),
	"/organization/accept-invitation": (answer) => ({
		type: "invitation_accepted",
		workspaceId: answer.invitation?.organizationId,
		role: answer.member?.role,
	}),
	"/organization/reject-invitation": (answer) => ({
		type: "invitation_declined",
		workspaceId: answer.invitation?.organizationId,
	}),
	"/organization/remove-member": (answer) => ({
		type: "member_removed",
		workspaceId: answer.member?.organizationId,
		target: answer.member?.userId,
	}),
	"/organization/update-member-role": (answer) => ({
		type: "member_role_changed",
		workspaceId: answer.organizationId,
		target: answer.userId,
		role: answer.role,
	}),
};

/** Everywhere the person belongs, and what is waiting for them. */
function listWorkspaces(db: Database) {
	return createAuthEndpoint(
		"/workspaces/list",
		{ method: "GET", use: [sessionMiddleware] },
		async (ctx) => {
			noStore(ctx);
			const { user } = ctx.context.session;
			const workspaces: WorkspaceSummary[] = await db
				.select({
					id: schema.organization.id,
					name: schema.organization.name,
					slug: schema.organization.slug,
					role: schema.member.role,
				})
				.from(schema.member)
				.innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
				.where(eq(schema.member.userId, user.id))
				.orderBy(asc(schema.organization.name))
				.all();
			const [invitations, canCreate] = await Promise.all([
				invitationsFor(db, user),
				mayMakeWorkspaces(db, user.id),
			]);
			return { workspaces, invitations, canCreate };
		},
	);
}

/** One workspace, for a member of it. To anyone else, it does not exist. */
function getWorkspace(db: Database, appsEnabled: boolean) {
	return createAuthEndpoint(
		"/workspaces/get",
		{ method: "GET", query: z.object({ slug: z.string() }), use: [sessionMiddleware] },
		async (ctx): Promise<WorkspaceDetails> => {
			noStore(ctx);
			const workspace = await db
				.select({
					id: schema.organization.id,
					name: schema.organization.name,
					slug: schema.organization.slug,
				})
				.from(schema.organization)
				.where(eq(schema.organization.slug, ctx.query.slug))
				.get();
			const you = workspace && (await memberOf(db, workspace.id, ctx.context.session.user.id));
			if (!workspace || !you) throw APIError.from("NOT_FOUND", NO_WORKSPACE);

			const members: WorkspaceMember[] = await db
				.select({
					id: schema.member.id,
					name: schema.user.name,
					email: schema.user.email,
					role: schema.member.role,
				})
				.from(schema.member)
				.innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
				.where(eq(schema.member.organizationId, workspace.id))
				.orderBy(asc(schema.member.createdAt))
				.all();
			const invitations: PendingInvitation[] = can(you, "seeInvitations")
				? await db
						.select({
							id: schema.invitation.id,
							email: schema.invitation.email,
							role: schema.invitation.role,
							expiresAt: schema.invitation.expiresAt,
						})
						.from(schema.invitation)
						.where(
							and(
								eq(schema.invitation.organizationId, workspace.id),
								eq(schema.invitation.status, "pending"),
								gt(schema.invitation.expiresAt, new Date()),
							),
						)
						.orderBy(asc(schema.invitation.createdAt))
						.all()
				: [];
			const apps = appsEnabled && can(you, "manageApps") ? await appsOf(db, workspace.id) : [];
			const groups = appsEnabled ? await groupsSeenBy(db, workspace.id, you) : [];
			return {
				workspace,
				you: { memberId: you.id, role: you.role },
				members,
				invitations,
				mayInvite: can(you, "invite") && (await mayInviteTo(db, workspace.id)),
				apps,
				groups,
				appsEnabled,
			};
		},
	);
}

/** One invitation, for the person it is for. To anyone else, it does not exist. */
function getInvitation(db: Database) {
	return createAuthEndpoint(
		"/workspaces/invitation",
		{ method: "GET", query: z.object({ id: z.string() }), use: [sessionMiddleware] },
		async (ctx) => {
			noStore(ctx);
			const [found] = await invitationsFor(db, ctx.context.session.user, ctx.query.id);
			if (!found) throw APIError.from("NOT_FOUND", NO_INVITATION);
			return found;
		},
	);
}

export function workspacePlugins(config: WorkspacesConfig) {
	const { db, baseURL, mailer, record, appsEnabled } = config;
	const rules = gateRules(config);

	return [
		organization({
			allowUserToCreateOrganization: (user) => user.emailVerified === true,
			organizationLimit: async (user) => {
				const row = await db
					.select({ owned: count() })
					.from(schema.member)
					.where(and(eq(schema.member.userId, user.id), eq(schema.member.role, "owner")))
					.get();
				return (row?.owned ?? 0) >= WORKSPACES_PER_OWNER;
			},
			membershipLimit: MEMBERS_PER_WORKSPACE,
			invitationExpiresIn: INVITATION_LIFETIME_DAYS * 24 * 60 * 60,
			// Asking again replaces the invitation, and with it a link that may have gone astray.
			cancelPendingInvitationsOnReInvite: true,
			requireEmailVerificationOnInvitation: true,
			...(mailer && {
				sendInvitationEmail: async (
					{ id, email, role, organization: workspace, inviter },
					request,
				) => {
					const origin = new URL(baseURL ?? request?.url ?? "http://localhost").origin;
					const query = new URLSearchParams({ redirect: `/invitations/${id}`, email });
					await mailer.send({
						to: email,
						...workspaceInvitationEmail({
							url: `${origin}/login?${query}`,
							workspace: workspace.name,
							inviter: inviter.user.email,
							role,
							email,
							days: INVITATION_LIFETIME_DAYS,
						}),
					});
				},
			}),
			organizationHooks: {
				// The database will not let a workspace lose its last owner while it exists (see the
				// migration), so it goes first, and takes its members and invitations with it. What the
				// plugin deletes next is already gone.
				beforeDeleteOrganization: async ({ organization: workspace }) => {
					await db
						.delete(schema.organization)
						.where(eq(schema.organization.id, workspace.id))
						.run();
				},
			},
		}),
		{
			id: "workspaces",
			endpoints: {
				listWorkspaces: listWorkspaces(db),
				getWorkspace: getWorkspace(db, appsEnabled),
				getInvitation: getInvitation(db),
			},
			hooks: {
				before: [
					{
						matcher: ({ path = "" }) => path.startsWith(ORGANIZATION_PATHS),
						handler: createAuthMiddleware(async (ctx) => {
							const check = rules[ctx.path];
							if (!check) throw APIError.fromStatus("NOT_FOUND");
							const session = await getSessionFromCtx(ctx);
							if (!session) throw APIError.fromStatus("UNAUTHORIZED");
							await check(ctx.body, session, ctx);
						}),
					},
				],
				after: [
					{
						matcher: ({ path = "" }) => path in WORKSPACE_EVENTS,
						handler: createAuthMiddleware(async (ctx) => {
							const event = WORKSPACE_EVENTS[ctx.path];
							const answer = ctx.context.returned as Answer | undefined;
							if (!event || !answer || isAPIError(answer)) return;
							const session = await getSessionFromCtx(ctx);
							if (!session) return;
							const { type, workspaceId, target, role, name } = event(answer);
							const actorId = session.user.id;
							const from = whereFrom(ctx.headers);
							record(type, async () => ({
								userId: target ?? actorId,
								actorId,
								workspaceId,
								detail: detailOf(
									name ?? (workspaceId ? await nameOf(db, workspaceId) : undefined),
									role,
								),
								...from,
							}));
						}),
					},
				],
			},
			rateLimit: [
				{ pathMatcher: (path) => path === "/organization/create", window: 60, max: 5 },
				{ pathMatcher: (path) => path === "/organization/invite-member", window: 60, max: 20 },
				{
					pathMatcher: (path) =>
						path === "/organization/accept-invitation" ||
						path === "/organization/reject-invitation",
					window: 60,
					max: 10,
				},
			],
		} satisfies BetterAuthPlugin,
	];
}
