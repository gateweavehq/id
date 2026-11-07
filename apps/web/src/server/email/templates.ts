import { roleName } from "../../lib/workspace";
import type { Email } from "./mailer";

/** An email before it is addressed. */
export type Message = Omit<Email, "to">;

const PRODUCT = "Gateweave ID";

export function passwordResetEmail({ url }: { url: string }): Message {
	return compose({
		subject: `Reset your ${PRODUCT} password`,
		heading: "Reset your password",
		body: [
			`Someone asked to reset the password of your ${PRODUCT} account. If it was you, choose a new password below. The link works for one hour, once.`,
			"Resetting it signs you out on every device.",
		],
		action: { label: "Choose a new password", url },
		footer: "If you did not ask for this, ignore this email. Your password stays as it is.",
	});
}

export function signUpCodeEmail({
	code,
	minutes,
	email,
}: {
	code: string;
	minutes: number;
	/** Whoever reads several addresses in one inbox should know which one this is about. */
	email: string;
}): Message {
	return compose({
		subject: `${code} is your ${PRODUCT} code`,
		heading: "Finish creating your account",
		body: [
			`Enter this code to create your ${PRODUCT} account for ${email}. It works for ${minutes} minutes.`,
		],
		code,
		footer: "If you did not ask for this, ignore this email. Without the code, nothing happens.",
	});
}

export function accountExistsEmail({
	signInUrl,
	resetUrl,
}: {
	signInUrl: string;
	resetUrl: string;
}): Message {
	return compose({
		subject: `You already have a ${PRODUCT} account`,
		heading: "You already have an account",
		body: [
			`Someone tried to create a ${PRODUCT} account with this address, but it already has one, so there is no code to enter.`,
			`Forgot your password? Choose a new one: ${resetUrl}`,
		],
		action: { label: "Sign in", url: signInUrl },
		footer: "If this was not you, ignore this email. Nothing has changed.",
	});
}

/**
 * Goes to an address no member needs to have proven, so it says as little as it can in words someone
 * else chose: a workspace's name, which has rules of its own, and the address of whoever sent it, which
 * they had to prove. The subject holds neither, so it cannot be turned into an advertisement.
 */
export function workspaceInvitationEmail({
	url,
	workspace,
	inviter,
	role,
	email,
	days,
}: {
	url: string;
	workspace: string;
	inviter: string;
	role: string;
	email: string;
	days: number;
}): Message {
	return compose({
		subject: `An invitation to a ${PRODUCT} workspace`,
		heading: "You have been invited to a workspace",
		body: [
			`${inviter} invited you to the workspace "${workspace}" on ${PRODUCT}, as ${roleName(role).toLowerCase()}.`,
			`To accept, sign in or create an account with this address: ${email}. The invitation works for ${days} days.`,
		],
		action: { label: "See the invitation", url },
		footer: "If you do not know this person, ignore this email. Nothing happens unless you accept.",
	});
}

/** Who runs this server vouching for an address. Its link is an account, so nothing else carries it. */
export function serverInvitationEmail({
	url,
	inviter,
	email,
	days,
}: {
	url: string;
	inviter: string;
	email: string;
	days: number;
}): Message {
	return compose({
		subject: `An invitation to ${PRODUCT}`,
		heading: "You have been invited",
		body: [
			`${inviter} invited you to make an account on the ${PRODUCT} server at ${new URL(url).host}, with this address: ${email}.`,
			`The link works once, for ${days} days.`,
		],
		action: { label: "Make your account", url },
		footer:
			"If you do not know this person, ignore this email. Nothing happens unless you use the link.",
	});
}

/** To whoever changed their password, so that someone who did not hears of it. */
export function passwordChangedEmail({ email }: { email: string }): Message {
	return compose({
		subject: `Your ${PRODUCT} password was changed`,
		heading: "Your password was changed",
		body: [
			`The password of the ${PRODUCT} account for ${email} was changed, from a session signed in to it. Every other session of this account is signed out.`,
		],
		footer:
			"If this was not you, reset your password from the sign-in page, which signs everyone else out, and tell whoever runs this server.",
	});
}

/** Nothing here can be undone, so it says what is left to do, and what it means if it was not them. */
export function accountDeletedEmail({ email }: { email: string }): Message {
	return compose({
		subject: `Your ${PRODUCT} account was deleted`,
		heading: "Your account was deleted",
		body: [
			`The ${PRODUCT} account for ${email} has been deleted, from a session signed in to it. It cannot be brought back.`,
			"Apps you signed in to with it keep what they already hold about you, and some may keep you signed in for a while, so delete your account in each of them too.",
		],
		footer:
			"If this was not you, someone else had your password or a recent session. Tell whoever runs this server.",
	});
}

function compose({
	subject,
	heading,
	body,
	code,
	action,
	footer,
}: {
	subject: string;
	heading: string;
	body: string[];
	code?: string;
	action?: { label: string; url: string };
	footer: string;
}): Message {
	const text = [
		...body,
		...(code ? [code] : []),
		...(action ? [`${action.label}: ${action.url}`] : []),
		footer,
		`— ${PRODUCT}`,
	].join("\n\n");
	const paragraphs = body
		.map((line) => `<p style="margin:0 0 16px">${escapeHtml(line)}</p>`)
		.join("");
	const codeBlock = code
		? `<p style="margin:24px 0;font-size:32px;font-weight:600;letter-spacing:6px;font-variant-numeric:tabular-nums">${escapeHtml(code)}</p>`
		: "";
	const button = action
		? `<p style="margin:24px 0"><a href="${escapeHtml(action.url)}" style="display:inline-block;padding:10px 16px;background:#171717;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600">${escapeHtml(action.label)}</a></p>
<p style="margin:0 0 16px;font-size:13px;color:#525252">Or paste this link into your browser:<br><span style="word-break:break-all">${escapeHtml(action.url)}</span></p>`
		: "";
	const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:24px;background:#f5f5f5;color:#171717;font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
<div style="max-width:480px;margin:0 auto;padding:32px;background:#ffffff;border:1px solid #e5e5e5;border-radius:8px">
<p style="margin:0 0 24px;font-size:13px;font-weight:600;color:#525252">${PRODUCT}</p>
<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3">${escapeHtml(heading)}</h1>
${paragraphs}
${codeBlock}
${button}
<p style="margin:24px 0 0;font-size:13px;color:#737373">${escapeHtml(footer)}</p>
</div>
</body>
</html>`;
	return { subject: oneLine(subject), text, html };
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}
