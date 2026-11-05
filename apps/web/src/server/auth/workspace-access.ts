import type { GenericEndpointContext } from "better-auth";
import { APIError, type getSessionFromCtx, NO_STORE_HEADERS } from "better-auth/api";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import type { Database } from "../db";
import { schema } from "../db";

/** What workspaces and their apps both need to know of whoever is asking. */

export const NO_WORKSPACE = {
	code: "WORKSPACE_NOT_FOUND",
	message: "That workspace does not exist, or you are not a member of it.",
};
const NOT_ALLOWED = {
	code: "NOT_ALLOWED",
	message: "Your role in this workspace does not allow this.",
};

export interface Member {
	id: string;
	role: string;
}

export type Session = NonNullable<Awaited<ReturnType<typeof getSessionFromCtx>>>;

export function memberOf(
	db: Database,
	workspaceId: string,
	userId: string,
): Promise<Member | undefined> {
	return db
		.select({ id: schema.member.id, role: schema.member.role })
		.from(schema.member)
		.where(and(eq(schema.member.organizationId, workspaceId), eq(schema.member.userId, userId)))
		.get();
}

/** Whoever is not a member hears what they would hear of a workspace that does not exist. */
export async function requireMember(
	db: Database,
	workspaceId: string,
	session: Session,
): Promise<Member> {
	const member = await memberOf(db, workspaceId, session.user.id);
	if (!member) throw APIError.from("NOT_FOUND", NO_WORKSPACE);
	return member;
}

export function requireRight(allowed: boolean) {
	if (!allowed) throw APIError.from("FORBIDDEN", NOT_ALLOWED);
}

/** For what must outlast a stolen cookie, as setting a password does. */
export function requireFreshSession(session: Session, ctx: GenericEndpointContext) {
	const age = Date.now() - new Date(session.session.createdAt).getTime();
	if (age > ctx.context.sessionConfig.freshAge * 1000) {
		throw APIError.from("FORBIDDEN", {
			code: "SESSION_NOT_FRESH",
			message: "Session is not fresh",
		});
	}
}

/** Reads a body against a schema that is strict, and refuses in that schema's own words. */
export function parseBody<Body>(body: z.ZodType<Body>, raw: unknown): Body {
	const parsed = body.safeParse(raw);
	if (!parsed.success) {
		throw APIError.from("BAD_REQUEST", {
			code: "INVALID_REQUEST",
			message: parsed.error.issues[0]?.message ?? "That request is not valid.",
		});
	}
	return parsed.data;
}

export function noStore(ctx: { setHeader(name: string, value: string): void }) {
	for (const [name, value] of Object.entries(NO_STORE_HEADERS)) ctx.setHeader(name, value);
}
