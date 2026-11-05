import { type FormEvent, useState } from "react";
import { LiveButton } from "#/components/live-button";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/lib/auth-client";
import {
	can,
	groupName,
	type WorkspaceDetails,
	type WorkspaceGroup,
	workspaceFailure,
} from "#/lib/workspace";

const SELECT =
	"h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-base shadow-sm focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50 md:text-sm";

/** Sends a change, and returns what went wrong if it did. */
async function send(path: string, body: object): Promise<string | null> {
	try {
		const result = await authClient.$fetch(path, { method: "POST", body });
		return result.error ? workspaceFailure(result.error) : null;
	} catch (caught) {
		return caught instanceof Error ? caught.message : "Something went wrong";
	}
}

/** The name in the form, or what is wrong with it, in the words the server would use. */
function nameIn(form: HTMLFormElement): { name: string } | { problem: string } {
	const name = String(new FormData(form).get("name")).trim();
	const refused = groupName.safeParse(name).error;
	return refused ? { problem: refused.issues[0]?.message ?? "Check the name." } : { name };
}

function GroupRow({ group, details, reload }: { group: WorkspaceGroup } & SectionProps) {
	const [mode, setMode] = useState<"renaming" | "deleting" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const which = { organizationId: details.workspace.id, groupId: group.id };
	const inIt = details.members.filter(({ id }) => group.members.includes(id));
	const outside = details.members.filter(({ id }) => !group.members.includes(id));
	const usedBy = details.apps.filter(({ groups }) => groups.includes(group.id));

	/** What went wrong was about the last thing tried, and would read as being about the next. */
	function turnTo(next: typeof mode) {
		setError(null);
		setMode(next);
	}

	/** Reports what went wrong, and says whether it went right. */
	async function run(path: string, body: object): Promise<boolean> {
		setPending(true);
		setError(null);
		const failure = await send(path, { ...which, ...body });
		if (failure) setError(failure);
		// Held until the list is new: what this changed is on the page till then, and a second press
		// would go for something that has gone.
		try {
			await reload();
		} finally {
			setPending(false);
		}
		return !failure;
	}

	async function onRename(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const named = nameIn(event.currentTarget);
		if ("problem" in named) {
			setError(named.problem);
			return;
		}
		if (await run("/workspaces/groups/rename", { name: named.name })) setMode(null);
	}

	async function onAdd(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const memberId = String(new FormData(event.currentTarget).get("member"));
		if (memberId) await run("/workspaces/groups/add-member", { memberId });
	}

	return (
		<li className="space-y-3 px-4 py-3 text-sm">
			<div className="min-w-0 space-y-0.5">
				<p className="font-medium break-words">{group.name}</p>
				<p className="break-words text-muted-foreground">
					{usedBy.length > 0
						? `Used by ${usedBy.map(({ name }) => name).join(", ")}.`
						: "No app uses it yet."}
				</p>
			</div>
			{error && (
				<p role="alert" className="text-destructive">
					{error}
				</p>
			)}
			{inIt.length > 0 && (
				<ul aria-label={`People in ${group.name}`} className="space-y-1">
					{inIt.map((member) => (
						<li key={member.id} className="flex items-center justify-between gap-3">
							<span className="min-w-0 break-words">{member.name}</span>
							<Button
								variant="ghost"
								size="sm"
								className="shrink-0"
								disabled={pending}
								aria-label={`Take ${member.name} out of ${group.name}`}
								onClick={() => run("/workspaces/groups/remove-member", { memberId: member.id })}
							>
								Take out
							</Button>
						</li>
					))}
				</ul>
			)}
			{usedBy.length > 0 && inIt.length > 0 && (
				<p className="text-xs text-muted-foreground">
					Taking someone out ends their access to what only this group opens.
				</p>
			)}
			{outside.length > 0 && (
				<form onSubmit={onAdd} className="flex items-center gap-2">
					<select name="member" aria-label={`Add someone to ${group.name}`} className={SELECT}>
						{outside.map((member) => (
							<option key={member.id} value={member.id}>
								{member.name} ({member.email})
							</option>
						))}
					</select>
					<LiveButton
						type="submit"
						variant="outline"
						size="sm"
						disabled={pending}
						aria-label={`Add to ${group.name}`}
					>
						Add
					</LiveButton>
				</form>
			)}
			{mode === "renaming" && (
				<form onSubmit={onRename} className="space-y-3">
					<div className="space-y-2">
						<Label htmlFor={`group-name-${group.id}`}>Group name</Label>
						<Input
							id={`group-name-${group.id}`}
							name="name"
							defaultValue={group.name}
							maxLength={60}
							required
						/>
						{usedBy.length > 0 && (
							<p className="text-xs text-muted-foreground">
								Apps that ask are told its name, and will see the new one.
							</p>
						)}
					</div>
					<div className="flex flex-wrap gap-2">
						<LiveButton
							type="submit"
							size="sm"
							disabled={pending}
							aria-label={`Save ${group.name}`}
						>
							Save
						</LiveButton>
						<Button type="button" variant="ghost" size="sm" onClick={() => turnTo(null)}>
							Cancel
						</Button>
					</div>
				</form>
			)}
			{mode === "deleting" && (
				<div className="flex flex-wrap gap-2">
					<Button
						variant="destructive"
						size="sm"
						disabled={pending}
						aria-label={`Yes, delete ${group.name}`}
						onClick={async () => {
							// Refused, there is no asking again until something has changed.
							await run("/workspaces/groups/delete", {});
							setMode(null);
						}}
					>
						Yes, delete
					</Button>
					<Button variant="ghost" size="sm" onClick={() => turnTo(null)}>
						Keep it
					</Button>
				</div>
			)}
			{mode === null && (
				<div className="flex flex-wrap gap-2">
					<Button
						variant="outline"
						size="sm"
						aria-label={`Rename ${group.name}`}
						onClick={() => turnTo("renaming")}
					>
						Rename
					</Button>
					<Button
						variant="ghost"
						size="sm"
						aria-label={`Delete ${group.name}`}
						onClick={() => turnTo("deleting")}
					>
						Delete
					</Button>
				</div>
			)}
		</li>
	);
}

interface SectionProps {
	details: WorkspaceDetails;
	reload: () => Promise<void>;
}

/** What a workspace's admins can do about its groups. The server decides again at each of these. */
function ManageGroups({ details, reload }: SectionProps) {
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const formElement = event.currentTarget;
		const named = nameIn(formElement);
		setError(null);
		if ("problem" in named) {
			setError(named.problem);
			return;
		}
		setPending(true);
		const failure = await send("/workspaces/groups/create", {
			organizationId: details.workspace.id,
			name: named.name,
		});
		setPending(false);
		if (failure) {
			setError(failure);
			return;
		}
		formElement.reset();
		await reload();
	}

	return (
		<section aria-labelledby="groups-heading" className="space-y-4">
			<div className="space-y-1">
				<h2 id="groups-heading" className="text-sm font-semibold">
					Groups
				</h2>
				<p className="text-sm text-muted-foreground">
					Keep an app to part of {details.workspace.name}, under Apps. Apps can also ask which of
					these someone is in, and each person is asked before they are told.
				</p>
			</div>
			{details.groups.length > 0 && (
				<ul aria-label="Groups" className="divide-y rounded-lg border">
					{details.groups.map((group) => (
						<GroupRow key={group.id} group={group} details={details} reload={reload} />
					))}
				</ul>
			)}
			<form onSubmit={onSubmit} className="space-y-4 rounded-lg border p-4">
				<div className="space-y-2">
					<Label htmlFor="group-name">Group name</Label>
					<Input id="group-name" name="name" maxLength={60} required autoComplete="off" />
				</div>
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
				<LiveButton type="submit" variant="outline" size="sm" disabled={pending}>
					Add group
				</LiveButton>
			</form>
		</section>
	);
}

/** A member is told which groups they are in, since an app can ask. Admins decide, so they see them all. */
export function WorkspaceGroups({ details, reload }: SectionProps) {
	if (can(details.you, "manageGroups")) return <ManageGroups details={details} reload={reload} />;
	if (details.groups.length === 0) return null;
	return (
		<section aria-labelledby="groups-heading" className="space-y-2">
			<h2 id="groups-heading" className="text-sm font-semibold">
				Your groups
			</h2>
			<ul className="divide-y rounded-lg border text-sm">
				{details.groups.map((group) => (
					<li key={group.id} className="px-4 py-3 break-words">
						{group.name}
					</li>
				))}
			</ul>
		</section>
	);
}
