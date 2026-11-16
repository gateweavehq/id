import { Link } from "@tanstack/react-router";
import { AccountCard, CARD_ACTION_ROW, useLoaded } from "#/components/account-section";
import { Button } from "#/components/ui/button";
import { authClient } from "#/lib/auth-client";
import { workspaceCounts } from "#/lib/workspace";

interface Listing {
	workspaces: unknown[];
	invitations: unknown[];
}

const listWorkspaces = () => authClient.$fetch<Listing>("/workspaces/list");

/**
 * The way to the workspaces page, with how many there are once the browser has asked. It is the same
 * list that page shows. Without it, the card still leads there, so a failure here says nothing.
 */
export function AccountWorkspaces() {
	const { data } = useLoaded(listWorkspaces, "");
	return (
		<AccountCard id="workspaces-heading" title="Workspaces">
			<div className={CARD_ACTION_ROW}>
				<p className="text-muted-foreground">
					{data
						? workspaceCounts(data.workspaces.length, data.invitations.length)
						: "The teams you belong to, and invitations."}
				</p>
				<Button asChild variant="outline" size="sm">
					<Link to="/workspaces">Open workspaces</Link>
				</Button>
			</div>
		</AccountCard>
	);
}
