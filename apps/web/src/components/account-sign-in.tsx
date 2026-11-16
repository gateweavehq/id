import { AccountCard, CARD_ROW } from "#/components/account-section";
import { signInSummary, type WaysOffered, type WaysToSignIn } from "#/lib/sign-in-summary";

/**
 * What this account signs in with, before the cards that change each of them. Someone who came
 * through GitHub has no password and no reason to think they need one, and the cards below would
 * otherwise read as things left undone.
 */
export function AccountSignIn({ has, offered }: { has: WaysToSignIn; offered: WaysOffered }) {
	const { lead, ways } = signInSummary(has, offered);
	return (
		<AccountCard id="sign-in-summary-heading" title="How you sign in">
			<p className={CARD_ROW}>{lead}</p>
			<dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 px-4 py-3">
				{ways.map(({ name, state, on }) => (
					<div key={name} className="col-span-2 grid grid-cols-subgrid">
						<dt className="text-muted-foreground">{name}</dt>
						<dd className={on ? "font-medium" : "text-muted-foreground"}>{state}</dd>
					</div>
				))}
			</dl>
		</AccountCard>
	);
}
