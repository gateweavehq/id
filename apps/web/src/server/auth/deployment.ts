import { createHash, randomBytes } from "node:crypto";
import type { BetterAuthPlugin, GenericEndpointContext } from "better-auth";
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { and, asc, eq, gt, like, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db";
import { schema } from "../db";
import type { Mailer } from "../email/mailer";
import { serverInvitationEmail } from "../email/templates";
import { type RecordEvent, whereFrom } from "./audit";
import { ownPasswordField, requireOwnPassword } from "./own-password";
import { noStore, parseBody, requireFreshSession } from "./workspace-access";

// "Who owns a deployment" in docs/architecture.md. The triggers in `0014_deployment_hold.sql` hold this
// however an account comes to be made. What is here asks first, to answer in words and tell the pages.

export const SIGN_UP_CLOSED = {
	code: "SIGN_UP_CLOSED",
	message: "This server takes new accounts by invitation. Ask whoever runs it to invite you.",
};

export const ONLY_THE_OWNER_MAKES_WORKSPACES = {
	code: "ONLY_THE_OWNER_MAKES_WORKSPACES",
	message: "On this server, only the person who runs it makes workspaces.",
};

export const WORKSPACE_CANNOT_INVITE = {
	code: "WORKSPACE_CANNOT_INVITE",
	message:
		"Sign-up is closed on this server, and the person who runs it is not an admin of this workspace, so it cannot invite anyone for now.",
};

export const SERVER_OWNER_STAYS_A_MEMBER = {
	code: "SERVER_OWNER_STAYS_A_MEMBER",
	message:
		"Sign-up is closed on this server, and making the person who runs it an admin here would let this workspace invite people again. Ask them to open sign-up first.",
};

const NO_INVITATION = {
	code: "INVITATION_NOT_FOUND",
	message:
		"This invitation does not work. It may have expired or been used. Ask whoever runs this server for another.",
};

const INVITATION_LIFETIME_DAYS = 7;

/** Far shorter than an invitation's week: whoever holds this has an account that is in use. */
const PASSWORD_LINK_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** Where Better Auth's `/reset-password` looks for what it was given. */
const RESET_IDENTIFIER = "reset-password:";

/** What the page that makes accounts has to tell someone. */
export type SignUpState = "open" | "by-invitation" | "unclaimed";

/**
 * Whether this address may have a new account: the rule of the trigger `user_needs_a_way_in`. It says
 * nothing about an address that has one already, so what asks has to look at that itself.
 */
export async function mayMakeAccount(db: Database, email: string): Promise<boolean> {
	const address = email.toLowerCase();
	const now = Date.now();
	const row = await db.get<{ allowed: number }>(sql`
		SELECT (
			COALESCE((SELECT sign_up FROM deployment WHERE id = 1), 'closed') = 'open'
			OR NOT EXISTS (SELECT 1 FROM user)
			OR EXISTS (SELECT 1 FROM deployment_invitation WHERE email = ${address} AND expires_at > ${now})
			OR EXISTS (
				SELECT 1 FROM invitation
				JOIN member ON member.organization_id = invitation.organization_id
				WHERE invitation.email = ${address}
					AND invitation.status = 'pending'
					AND invitation.expires_at > ${now}
					AND member.user_id = (SELECT owner_id FROM deployment WHERE id = 1)
					AND member.role IN ('owner', 'admin')
			)
		) AS allowed
	`);
	return row?.allowed === 1;
}

/**
 * A workspace invitation is a way in, so on a closed server someone who could make a workspace could let
 * in anyone at all. That leaves the owner, and whoever they make an admin of a workspace.
 */
export async function mayMakeWorkspaces(db: Database, userId: string): Promise<boolean> {
	const { deployment } = schema;
	const row = await db
		.select({ id: deployment.id })
		.from(deployment)
		.where(
			and(eq(deployment.id, 1), or(eq(deployment.signUp, "open"), eq(deployment.ownerId, userId))),
		)
		.get();
	return row !== undefined;
}

/**
 * Whether this workspace's invitations can go out. On a closed server they are a way in, and a workspace
 * made while sign-up was open is its maker's, so closing sign-up has to close it too. Asking this of the
 * workspace and not the address tells an admin nothing about who has an account here.
 */
export async function mayInviteTo(db: Database, workspaceId: string): Promise<boolean> {
	const row = await db.get<{ allowed: number }>(sql`
		SELECT (
			COALESCE((SELECT sign_up FROM deployment WHERE id = 1), 'closed') = 'open'
			OR EXISTS (
				SELECT 1 FROM member
				WHERE organization_id = ${workspaceId}
					AND user_id = (SELECT owner_id FROM deployment WHERE id = 1)
					AND role IN ('owner', 'admin')
			)
		) AS allowed
	`);
	return row?.allowed === 1;
}

/**
 * Whether this member's role may change. A workspace that cannot invite would be able to again if the
 * server's owner became an admin of it, which would undo closing sign-up with no word from them.
 */
export async function mayChangeRoleOf(
	db: Database,
	workspaceId: string,
	memberId: string,
): Promise<boolean> {
	if (await mayInviteTo(db, workspaceId)) return true;
	const row = await db.get<{ runsServer: number }>(sql`
		SELECT EXISTS (
			SELECT 1 FROM member
			WHERE id = ${memberId} AND user_id = (SELECT owner_id FROM deployment WHERE id = 1)
		) AS runsServer
	`);
	return row?.runsServer !== 1;
}

export async function signUpState(db: Database): Promise<SignUpState> {
	const row = await db.get<{ signUp: string | null; hasAccounts: number }>(sql`
		SELECT (SELECT sign_up FROM deployment WHERE id = 1) AS signUp,
			EXISTS (SELECT 1 FROM user) AS hasAccounts
	`);
	if (row?.signUp === "open") return "open";
	return row?.hasAccounts === 0 ? "unclaimed" : "by-invitation";
}

export async function ownsDeployment(db: Database, userId: string): Promise<boolean> {
	const { deployment } = schema;
	const row = await db
		.select({ id: deployment.id })
		.from(deployment)
		.where(and(eq(deployment.id, 1), eq(deployment.ownerId, userId)))
		.get();
	return row !== undefined;
}

/** To anyone else, the owner's paths do not exist. */
async function requireOwner(db: Database, userId: string) {
	if (!(await ownsDeployment(db, userId))) throw APIError.fromStatus("NOT_FOUND");
}

/** Whoever holds the link has the invitation, so only this is kept. */
function hashOf(token: string) {
	return createHash("sha256").update(token).digest("base64url");
}

async function invitationFor(db: Database, token: string) {
	const { deploymentInvitation: invitation } = schema;
	const row = await db
		.select({ email: invitation.email })
		.from(invitation)
		.where(and(eq(invitation.tokenHash, hashOf(token)), gt(invitation.expiresAt, new Date())))
		.get();
	if (!row) throw APIError.from("NOT_FOUND", NO_INVITATION);
	return row.email;
}

const personName = z
	.string()
	.trim()
	.min(1, "Enter a name of at most 100 characters.")
	.max(100, "Enter a name of at most 100 characters.");
const address = z.email("Enter an email address.").max(254);
const token = z.string().min(1).max(200);

/**
 * Makes an account with its password from the start, for the two ways in that have no mailbox to prove:
 * a link the owner passed on, and the first account of a server that sends no email. Better Auth keeps
 * this for its own sign-up, so the pieces are the ones that uses.
 */
async function makeAccount(
	ctx: GenericEndpointContext,
	person: { email: string; name: string; password: string },
) {
	const { minPasswordLength, maxPasswordLength } = ctx.context.password.config;
	if (person.password.length < minPasswordLength || person.password.length > maxPasswordLength) {
		throw APIError.from("BAD_REQUEST", {
			code: "INVALID_PASSWORD_LENGTH",
			message: `Choose a password of ${minPasswordLength} to ${maxPasswordLength} characters.`,
		});
	}
	const { internalAdapter, password } = ctx.context;
	if (await internalAdapter.findUserByEmail(person.email)) {
		throw APIError.from("NOT_FOUND", NO_INVITATION);
	}
	const hash = await password.hash(person.password);
	const user = await internalAdapter.createUser(
		{ email: person.email, name: person.name, emailVerified: true },
		{ method: "email-password" },
	);
	await internalAdapter.linkAccount({
		userId: user.id,
		providerId: "credential",
		accountId: user.id,
		password: hash,
	});
	const session = await internalAdapter.createSession(user.id);
	await setSessionCookie(ctx, { session, user });
	return ctx.json({ email: user.email });
}

interface DeploymentConfig {
	db: Database;
	/** Without it, the owner passes the link on themselves. */
	mailer: Mailer | undefined;
	/** Whether someone can prove an address with GitHub here. */
	gitHub: boolean;
	record: RecordEvent;
	/** Whether this person may send another invitation, to this address. Unlimited without it. */
	allowInvitation: ((inviterId: string, email: string) => Promise<boolean>) | undefined;
}

/** What the owner has, and the way in for those they invite. */
export function deploymentPlugin({
	db,
	mailer,
	gitHub,
	record,
	allowInvitation,
}: DeploymentConfig) {
	const { deployment, deploymentInvitation: invitation } = schema;

	return {
		id: "deployment",
		endpoints: {
			getDeployment: createAuthEndpoint(
				"/deployment/get",
				{ method: "GET", use: [sessionMiddleware] },
				async (ctx) => {
					noStore(ctx);
					await requireOwner(db, ctx.context.session.user.id);
					const [row, invitations] = await Promise.all([
						db.select({ signUp: deployment.signUp }).from(deployment).get(),
						db
							.select({
								id: invitation.id,
								email: invitation.email,
								expiresAt: invitation.expiresAt,
							})
							.from(invitation)
							.where(gt(invitation.expiresAt, new Date()))
							.orderBy(asc(invitation.createdAt))
							.all(),
					]);
					return { signUp: row?.signUp ?? "closed", invitations, sendsEmail: Boolean(mailer) };
				},
			),
			setDeploymentSignUp: createAuthEndpoint(
				"/deployment/sign-up",
				{ method: "POST", use: [sessionMiddleware] },
				async (ctx) => {
					noStore(ctx);
					const { session } = ctx.context;
					await requireOwner(db, session.user.id);
					const { signUp } = parseBody(
						z.strictObject({ signUp: z.enum(["closed", "open"]) }),
						ctx.body,
					);
					// Only to open it. Closing lets nobody in, and is what an owner who suspects something
					// reaches for first.
					if (signUp === "open") requireFreshSession(session, ctx);
					await db
						.update(deployment)
						.set({ signUp, updatedAt: new Date() })
						.where(eq(deployment.id, 1))
						.run();
					record("deployment_sign_up_changed", {
						userId: session.user.id,
						detail: signUp,
						...whereFrom(ctx.headers),
					});
					return { signUp };
				},
			),
			createDeploymentInvitation: createAuthEndpoint(
				"/deployment/invitations/create",
				{ method: "POST", use: [sessionMiddleware] },
				async (ctx) => {
					noStore(ctx);
					const { session, internalAdapter, baseURL } = ctx.context;
					await requireOwner(db, session.user.id);
					const { email: typed } = parseBody(z.strictObject({ email: address }), ctx.body);
					// A link is an account for whoever holds it, and would outlast the cookie that made it.
					requireFreshSession(session, ctx);
					const email = typed.toLowerCase();
					if (await internalAdapter.findUserByEmail(email)) {
						throw APIError.from("BAD_REQUEST", {
							code: "ALREADY_HAS_ACCOUNT",
							message: "That address already has an account here.",
						});
					}
					if (allowInvitation && !(await allowInvitation(session.user.id, email))) {
						throw APIError.from("TOO_MANY_REQUESTS", {
							code: "TOO_MANY_INVITATIONS",
							message: "Too many invitations lately, from you or to that address. Try again later.",
						});
					}

					// Asking again replaces the invitation, and with it a link that may have gone astray.
					const secret = randomBytes(32).toString("base64url");
					const now = new Date();
					const changes = {
						tokenHash: hashOf(secret),
						invitedBy: session.user.id,
						expiresAt: new Date(now.getTime() + INVITATION_LIFETIME_DAYS * 86_400_000),
						createdAt: now,
					};
					const made = await db
						.insert(invitation)
						.values({ id: randomBytes(16).toString("hex"), email, ...changes })
						.onConflictDoUpdate({ target: invitation.email, set: changes })
						.returning({
							id: invitation.id,
							email: invitation.email,
							expiresAt: invitation.expiresAt,
						})
						.get();
					// In the part after the #, a browser sends it to nobody, so no log or Referer holds it.
					const link = `${new URL(baseURL).origin}/join#${secret}`;
					record("deployment_invitation_created", {
						userId: session.user.id,
						...whereFrom(ctx.headers),
					});
					if (!mailer) return { ...made, link };
					await mailer.send({
						to: email,
						...serverInvitationEmail({
							url: link,
							inviter: session.user.email,
							email,
							days: INVITATION_LIFETIME_DAYS,
						}),
					});
					return made;
				},
			),
			cancelDeploymentInvitation: createAuthEndpoint(
				"/deployment/invitations/cancel",
				{ method: "POST", use: [sessionMiddleware] },
				async (ctx) => {
					noStore(ctx);
					const { session } = ctx.context;
					await requireOwner(db, session.user.id);
					const { id } = parseBody(z.strictObject({ id: z.string().min(1).max(100) }), ctx.body);
					const gone = await db
						.delete(invitation)
						.where(eq(invitation.id, id))
						.returning({ id: invitation.id })
						.get();
					if (!gone) throw APIError.from("NOT_FOUND", NO_INVITATION);
					record("deployment_invitation_canceled", {
						userId: session.user.id,
						...whereFrom(ctx.headers),
					});
					return { canceled: true };
				},
			),
			makePasswordLink: createAuthEndpoint(
				"/deployment/password-link",
				{ method: "POST", use: [sessionMiddleware] },
				async (ctx) => {
					noStore(ctx);
					const { session, internalAdapter, baseURL } = ctx.context;
					await requireOwner(db, session.user.id);
					// Where email goes out, people do this for themselves, and nobody needs a way into their
					// accounts. That includes whoever runs Gateweave's own server.
					if (mailer) throw APIError.fromStatus("NOT_FOUND");
					const body = parseBody(
						z.strictObject({ email: address, password: ownPasswordField(ctx) }),
						ctx.body,
					);
					// This opens someone else's account, so a stolen cookie must not be enough for it.
					requireFreshSession(session, ctx);
					await requireOwnPassword(ctx, session.user.id, body.password);

					const person = await internalAdapter.findUserByEmail(body.email.toLowerCase());
					if (!person) {
						throw APIError.from("BAD_REQUEST", {
							code: "NO_SUCH_ACCOUNT",
							message: "That address has no account here.",
						});
					}
					if (person.user.id === session.user.id) {
						throw APIError.from("BAD_REQUEST", {
							code: "YOUR_OWN_ACCOUNT",
							message:
								"That is your own account. You can change your password on your account page.",
						});
					}

					const secret = randomBytes(32).toString("base64url");
					const expiresAt = new Date(Date.now() + PASSWORD_LINK_LIFETIME_MS);
					const { verification } = schema;
					// Asking again takes the earlier link away, or one gone astray would stay good after the
					// person had used the new one. Together, or two asked for at once would both stay.
					await db.batch([
						db
							.delete(verification)
							.where(
								and(
									like(verification.identifier, `${RESET_IDENTIFIER}%`),
									eq(verification.value, person.user.id),
								),
							),
						// The row a reset email's link leads to, so that using this goes through all that does.
						db.insert(verification).values({
							id: randomBytes(16).toString("hex"),
							identifier: `${RESET_IDENTIFIER}${secret}`,
							value: person.user.id,
							expiresAt,
						}),
					]);
					record("password_link_made", {
						userId: person.user.id,
						actorId: session.user.id,
						...whereFrom(ctx.headers),
					});
					// In the part after the #, a browser sends it to nobody, so no log or Referer holds it.
					return { link: `${new URL(baseURL).origin}/reset-password#${secret}`, expiresAt };
				},
			),
			readDeploymentInvitation: createAuthEndpoint(
				// A POST, so that the token stays out of the URL and the logs that keep URLs.
				"/deployment/invitations/read",
				{ method: "POST" },
				async (ctx) => {
					noStore(ctx);
					const body = parseBody(z.strictObject({ token }), ctx.body);
					return { email: await invitationFor(db, body.token) };
				},
			),
			acceptDeploymentInvitation: createAuthEndpoint(
				"/deployment/invitations/accept",
				{ method: "POST" },
				async (ctx) => {
					noStore(ctx);
					const body = parseBody(
						z.strictObject({ token, name: personName, newPassword: z.string() }),
						ctx.body,
					);
					const email = await invitationFor(db, body.token);
					return makeAccount(ctx, { email, name: body.name, password: body.newPassword });
				},
			),
			claimDeployment: createAuthEndpoint("/deployment/claim", { method: "POST" }, async (ctx) => {
				noStore(ctx);
				// Where an address can be proven, the first account proves its own like any other.
				if (mailer || gitHub || (await signUpState(db)) !== "unclaimed") {
					throw APIError.fromStatus("NOT_FOUND");
				}
				const body = parseBody(
					z.strictObject({ email: address, name: personName, newPassword: z.string() }),
					ctx.body,
				);
				return makeAccount(ctx, {
					email: body.email.toLowerCase(),
					name: body.name,
					password: body.newPassword,
				});
			}),
		},
		rateLimit: [
			{
				pathMatcher: (path) =>
					path === "/deployment/invitations/read" ||
					path === "/deployment/invitations/accept" ||
					path === "/deployment/claim",
				window: 60,
				max: 10,
			},
			{ pathMatcher: (path) => path.startsWith("/deployment/"), window: 60, max: 60 },
		],
	} satisfies BetterAuthPlugin;
}
