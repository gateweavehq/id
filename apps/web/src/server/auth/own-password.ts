import type { GenericEndpointContext } from "better-auth";
import { APIError } from "better-auth/api";
import { z } from "zod";

const WRONG_PASSWORD = { code: "INVALID_PASSWORD", message: "That password is not right." };

/** The field a request shows it in. Someone with no password sends nothing. */
export function ownPasswordField({ context }: GenericEndpointContext) {
	return z
		.string()
		.max(context.password.config.maxPasswordLength, WRONG_PASSWORD.message)
		.optional();
}

/**
 * For what a cookie from the last day is not enough for, where there is a password to ask for. A path
 * that calls this belongs in `PASSWORD_FIELDS`, so that a stolen cookie has only so many tries.
 */
export async function requireOwnPassword(
	{ context }: GenericEndpointContext,
	userId: string,
	offered: string | undefined,
) {
	const accounts = await context.internalAdapter.findAccounts(userId);
	const hash = accounts.find(({ providerId }) => providerId === "credential")?.password;
	if (!hash) return;
	const right =
		offered !== undefined && (await context.password.verify({ hash, password: offered }));
	if (!right) throw APIError.from("BAD_REQUEST", WRONG_PASSWORD);
}
