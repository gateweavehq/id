import { z } from "zod";

/** One message to one person. Both bodies are sent: some mail clients show only text. */
export interface Email {
	to: string;
	subject: string;
	text: string;
	html: string;
}

export interface Mailer {
	send(email: Email): Promise<void>;
}

const address = z.email();

/**
 * Reads a sender written as `Name <address>` or as a bare address. Undefined when it is neither,
 * so a typo turns email off instead of failing every send.
 */
export function parseSender(value: string): string | EmailAddress | undefined {
	const named = /^\s*(.*?)\s*<([^<>]+)>\s*$/.exec(value);
	const email = (named ? named[2] : value)?.trim() ?? "";
	if (!address.safeParse(email).success) return undefined;
	const name = named?.[1]?.replace(/^"|"$/g, "").trim();
	return name ? { name, email } : email;
}

/**
 * Sends through a Cloudflare Email Service binding. Email is optional for self-hosters, so
 * without a binding or a sender this returns undefined and ID runs with email off.
 */
export function createMailer(
	binding: SendEmail | undefined,
	from: string | undefined,
): Mailer | undefined {
	if (!binding || !from) return undefined;
	const sender = parseSender(from);
	if (!sender) {
		console.error("email: EMAIL_FROM is not an email address, so email is off");
		return undefined;
	}
	return {
		async send({ to, subject, text, html }) {
			await binding.send({ from: sender, to, subject, text, html });
		},
	};
}
