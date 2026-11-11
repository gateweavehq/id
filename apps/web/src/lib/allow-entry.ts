import { z } from "zod";

/** "Who may make an account" in docs/architecture.md: how many entries the owner's list holds. */
export const MAX_ALLOW_ENTRIES = 5000;
export const MAX_ALLOW_NOTE = 200;

const address = z.email();

/**
 * One line of the owner's sign-up list: a whole address, or a domain written with a leading `@`, which
 * covers addresses at exactly that domain and not its subdomains. Always lowercase, since the
 * database compares the list with a lowercased address.
 */
export const allowEntry = z
	.string()
	.trim()
	.toLowerCase()
	.max(254, "Enter an email address, or a domain such as @example.com.")
	.refine(
		(value) =>
			value.startsWith("@")
				? address.safeParse(`x${value}`).success
				: address.safeParse(value).success,
		"Enter an email address, or a domain such as @example.com.",
	);

/** The owner's own words about why an entry is there. Empty is none. */
export const allowNote = z
	.string()
	.trim()
	.max(MAX_ALLOW_NOTE, `Keep the note to ${MAX_ALLOW_NOTE} characters.`)
	.transform((value) => (value === "" ? null : value))
	.nullish()
	.transform((value) => value ?? null);

/** Whether an entry names a domain and not one address. */
export function isDomainEntry(entry: string): boolean {
	return entry.startsWith("@");
}
