import { useRef, useState } from "react";
import {
	AccountCard,
	CARD_ROW,
	LoadFailure,
	ROW_BUTTON,
	useFocusBack,
	useLoaded,
} from "#/components/account-section";
import { Button } from "#/components/ui/button";
import { type AllowedApp, scopeWords, type UsedProduct } from "#/lib/allowed-app";
import { authClient } from "#/lib/auth-client";

const PRODUCTS_NOT_LOADED = "The products you use could not be loaded";
const NOT_LOADED = "The apps you allowed could not be loaded";
const NOT_TAKEN_BACK = "That app could not be taken back. Please try again.";

function dayOf(date: string | Date) {
	return new Date(date).toLocaleDateString(undefined, { dateStyle: "medium" });
}

const listProducts = () => authClient.$fetch<{ products: UsedProduct[] }>("/account/products");
const listAllowed = () => authClient.$fetch<{ apps: AllowedApp[] }>("/account/allowed-apps");

/**
 * Where this account is in use: the server's own apps this person has signed in to, and the way back
 * to each. They do not ask before they see an account, so there is nothing here to take back. It
 * loads in the browser, as the sessions above it do, so that dates read in their own time zone.
 */
export function AccountProducts() {
	const { data, failure, loading, reload } = useLoaded(listProducts, PRODUCTS_NOT_LOADED);
	const heading = useRef<HTMLHeadingElement>(null);
	const products = data?.products ?? null;

	return (
		// Not "Gateweave products": a server someone else runs lists whatever apps it registered here.
		<AccountCard id="products-heading" title="Products you use" headingRef={heading}>
			<p className={`${CARD_ROW} text-xs text-muted-foreground`}>
				These are part of this service, so they do not ask first.
			</p>
			{failure && (
				<LoadFailure
					message={failure}
					loading={loading}
					onRetry={async () => {
						if (await reload()) heading.current?.focus();
					}}
				/>
			)}
			{products === null ? (
				!failure && <p className={`${CARD_ROW} text-muted-foreground`}>Loading…</p>
			) : products.length === 0 ? (
				<p className={`${CARD_ROW} text-muted-foreground`}>
					You have not signed in to a product with this account in the last 90 days. The ones you
					sign in to are listed here, with a way back to each.
				</p>
			) : (
				<ul aria-labelledby="products-heading" className="divide-y">
					{products.map((product) => (
						<li
							key={product.app}
							className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3"
						>
							<div className="min-w-0">
								<p className="break-words font-medium">{product.name}</p>
								<p className="break-words text-xs text-muted-foreground">
									{product.host && `${product.host} · `}
									Last signed in {dayOf(product.lastSignIn)}
								</p>
							</div>
							{product.openUrl && (
								<Button asChild variant="outline" size="sm" className={ROW_BUTTON}>
									<a href={product.openUrl} aria-label={`Open ${product.name}`}>
										Open
									</a>
								</Button>
							)}
						</li>
					))}
				</ul>
			)}
		</AccountCard>
	);
}

/**
 * The apps this person told ID they may have, and where they can change their mind. Only a workspace's
 * apps ask, so most people have none. It loads in the browser, as the sessions above it do, so that
 * dates read in their own time zone.
 */
export function AccountApps() {
	const { data, failure, loading, reload } = useLoaded(listAllowed, NOT_LOADED);
	const [error, setError] = useState<string | null>(null);
	const [takenBack, setTakenBack] = useState<string | null>(null);
	const heading = useRef<HTMLHeadingElement>(null);
	const apps = data?.apps ?? null;

	return (
		<AccountCard id="apps-heading" title="Other apps you allowed" headingRef={heading}>
			{error && (
				<p role="alert" className={`${CARD_ROW} text-destructive`}>
					{error}
				</p>
			)}
			{failure && (
				<LoadFailure
					message={failure}
					loading={loading}
					onRetry={async () => {
						if (await reload()) heading.current?.focus();
					}}
				/>
			)}
			{/* In the page from the start, or a screen reader would not hear it arrive. */}
			<p role="status" className={takenBack ? `${CARD_ROW} text-muted-foreground` : "sr-only"}>
				{takenBack && `${takenBack} can no longer see your account.`}
			</p>
			{apps === null ? (
				!failure && <p className={`${CARD_ROW} text-muted-foreground`}>Loading…</p>
			) : apps.length === 0 ? (
				!takenBack && (
					<p className={`${CARD_ROW} text-muted-foreground`}>
						An app added by one of your workspaces asks before it can see your account. The ones you
						allow are listed here, where you can take them back.
					</p>
				)
			) : (
				<ul aria-labelledby="apps-heading" className="divide-y">
					{apps.map((app) => (
						<AppRow
							key={app.clientId}
							app={app}
							onTakenBack={async (name) => {
								setTakenBack(name);
								await reload();
								// The button that had the focus is gone with its row.
								heading.current?.focus();
							}}
							onError={setError}
						/>
					))}
				</ul>
			)}
		</AccountCard>
	);
}

function AppRow({
	app,
	onTakenBack,
	onError,
}: {
	app: AllowedApp;
	onTakenBack: (name: string) => Promise<void>;
	onError: (message: string | null) => void;
}) {
	const [asking, setAsking] = useState(false);
	const [pending, setPending] = useState(false);
	// The question takes the button's place, so the button gets the focus back when it returns.
	const opener = useFocusBack<HTMLButtonElement>(asking);
	const name = app.name || "This app";
	const scopes = scopeWords(app.scopes);
	const consequence = `take-back-${app.clientId}`;

	async function takeBack() {
		setPending(true);
		onError(null);
		try {
			const result = await authClient.$fetch("/account/allowed-apps/take-back", {
				method: "POST",
				body: { clientId: app.clientId },
			});
			if (result.error) {
				onError(result.error.message ?? NOT_TAKEN_BACK);
				setAsking(false);
				return;
			}
			await onTakenBack(name);
		} catch {
			onError(NOT_TAKEN_BACK);
			setAsking(false);
		} finally {
			setPending(false);
		}
	}

	return (
		<li className="space-y-2 px-4 py-3">
			<div className="min-w-0">
				<p className="break-words font-medium">{name}</p>
				<p className="break-words text-xs text-muted-foreground">
					Added by an admin of {app.workspace}
					{app.host && ` · ${app.host}`}
				</p>
			</div>
			{scopes.length > 0 && (
				<ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
					{scopes.map((words) => (
						<li key={words}>{words}</li>
					))}
				</ul>
			)}
			{asking ? (
				<div className="space-y-2">
					<p id={consequence} className="text-xs text-muted-foreground">
						It stops getting anything from your account at once, and has to ask you again next time.
						What it has already seen stays with it, and so does any session it keeps for you.
					</p>
					<div className="flex flex-wrap gap-2">
						{/* Buttons do not wrap, and an admin can give an app a long name. */}
						<Button
							variant="destructive"
							size="sm"
							className={ROW_BUTTON}
							aria-label={`Yes, take back ${name}`}
							aria-describedby={consequence}
							disabled={pending}
							onClick={takeBack}
						>
							{pending ? "Taking back…" : "Yes, take back"}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							className={ROW_BUTTON}
							disabled={pending}
							// The button that was pressed has gone, and this is the one that changes nothing.
							autoFocus
							onClick={() => setAsking(false)}
						>
							Keep it
						</Button>
					</div>
				</div>
			) : (
				<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
					<p className="text-xs text-muted-foreground">
						Allowed {dayOf(app.allowedAt)}
						{app.lastSignIn && ` · Last signed in ${dayOf(app.lastSignIn)}`}
					</p>
					<Button
						ref={opener}
						variant="outline"
						size="sm"
						className={ROW_BUTTON}
						aria-label={`Take back ${name}`}
						onClick={() => setAsking(true)}
					>
						Take back
					</Button>
				</div>
			)}
		</li>
	);
}
