import { type FormEvent, useCallback, useEffect, useState } from "react";
import { LiveButton } from "#/components/live-button";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { isDomainEntry, MAX_ALLOW_NOTE } from "#/lib/allow-entry";
import { authClient } from "#/lib/auth-client";
import { workspaceFailure } from "#/lib/workspace";

interface Listed {
	entry: string;
	note: string | null;
	addedAt: number;
	hasAccount: boolean;
}

interface ListState {
	total: number;
	matching: number;
	max: number;
	entries: Listed[];
}

/**
 * The owner's list of who may make an account while sign-up is closed: "Who may make an account" in
 * docs/architecture.md. The page that holds it shows it only to the owner.
 */
export function SignUpList({ signUp }: { signUp: "open" | "closed" }) {
	const [state, setState] = useState<ListState | null>(null);
	const [search, setSearch] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [added, setAdded] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	const load = useCallback(async (query: string) => {
		const result = await authClient.$fetch<ListState>("/deployment/allow/list", {
			query: query ? { search: query } : {},
		});
		if (result.error) setError(workspaceFailure(result.error));
		else setState(result.data);
	}, []);

	// A moment after the last key, so typing does not ask for every letter.
	useEffect(() => {
		const timer = setTimeout(() => load(search.trim()), search ? 250 : 0);
		return () => clearTimeout(timer);
	}, [search, load]);

	async function onAdd(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = event.currentTarget;
		const data = new FormData(form);
		setPending(true);
		setError(null);
		setAdded(null);
		const result = await authClient.$fetch<{ entry: string }>("/deployment/allow/add", {
			method: "POST",
			body: { entry: String(data.get("entry")), note: String(data.get("note")) },
		});
		setPending(false);
		if (result.error) {
			setError(workspaceFailure(result.error));
			return;
		}
		setAdded(result.data?.entry ?? null);
		form.reset();
		await load(search.trim());
	}

	async function onRemove(entry: string) {
		setError(null);
		setAdded(null);
		const result = await authClient.$fetch("/deployment/allow/remove", {
			method: "POST",
			body: { entry },
		});
		if (result.error) setError(workspaceFailure(result.error));
		await load(search.trim());
	}

	return (
		<section aria-labelledby="allow-heading" className="space-y-4">
			<h2 id="allow-heading" className="text-sm font-semibold">
				Who is on the list
			</h2>
			<p className="text-sm text-muted-foreground">
				While sign-up is closed, anyone on this list can make an account, with no invitation. Write
				an address, or a domain with an @ in front, such as{" "}
				<span className="font-mono">@example.com</span>, which covers addresses at exactly that
				domain and not its subdomains.{" "}
				{signUp === "open"
					? "Sign-up is open now, so the list changes nothing until you close it."
					: "Invitations work as well as the list."}{" "}
				It holds addresses of people who may have no account here yet, and keeps them until you
				remove them.
			</p>
			<form onSubmit={onAdd} className="space-y-4 rounded-lg border p-4">
				<div className="space-y-2">
					<Label htmlFor="allow-entry">Address or @domain</Label>
					<Input
						id="allow-entry"
						name="entry"
						type="text"
						inputMode="email"
						autoComplete="off"
						autoCapitalize="none"
						spellCheck={false}
						placeholder="ada@example.com or @example.com"
						required
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="allow-note">Note, if you like</Label>
					<Input
						id="allow-note"
						name="note"
						type="text"
						autoComplete="off"
						maxLength={MAX_ALLOW_NOTE}
						placeholder="From the waitlist"
					/>
				</div>
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
				{added && (
					<p role="status" className="text-sm break-words text-muted-foreground">
						{added} is on the list.
					</p>
				)}
				<LiveButton type="submit" variant="outline" size="sm" disabled={pending}>
					Add to the list
				</LiveButton>
			</form>

			{state && state.total > 0 && (
				<div className="space-y-3">
					<div className="space-y-2">
						<Label htmlFor="allow-search">Search the list</Label>
						<Input
							id="allow-search"
							type="search"
							autoComplete="off"
							value={search}
							onChange={(event) => setSearch(event.target.value)}
						/>
					</div>
					<p role="status" className="text-xs text-muted-foreground">
						{search.trim()
							? `${state.matching} of ${state.total} on the list`
							: `${state.total} on the list`}
						{state.entries.length < state.matching && `, the newest ${state.entries.length} shown`}
					</p>
					<ul aria-label="The list" className="divide-y rounded-lg border text-sm">
						{state.entries.map((row) => (
							<li
								key={row.entry}
								className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3"
							>
								<div className="min-w-0">
									<p className="font-medium break-all">{row.entry}</p>
									{row.note && <p className="break-words text-muted-foreground">{row.note}</p>}
									<p className="text-xs text-muted-foreground">
										Added{" "}
										{new Date(row.addedAt).toLocaleDateString(undefined, { dateStyle: "medium" })}
										{" · "}
										{row.hasAccount
											? isDomainEntry(row.entry)
												? "Has an account at this domain"
												: "Has an account"
											: isDomainEntry(row.entry)
												? "No account at this domain yet"
												: "No account yet"}
									</p>
								</div>
								<Button
									variant="ghost"
									size="sm"
									className="shrink-0"
									aria-label={`Remove ${row.entry} from the list`}
									onClick={() => onRemove(row.entry)}
								>
									Remove
								</Button>
							</li>
						))}
					</ul>
				</div>
			)}
			{state && state.total === 0 && (
				<p role="status" className="text-sm text-muted-foreground">
					Nobody is on the list yet.
				</p>
			)}
		</section>
	);
}
