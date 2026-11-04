import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { z } from "zod";
import { AuthPage } from "#/components/auth-page";
import { failureMessage } from "#/components/expired-link";
import { LiveButton } from "#/components/live-button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/lib/auth-client";
import { asksForNewAccount, flowSearch, inFlow, onItsWay, welcomeIsDone } from "#/lib/oauth-flow";
import { safeRedirect } from "#/lib/redirect";
import { getSession, signInMethods } from "#/lib/session";
import { useDocumentTitle } from "#/lib/title";

// Loose, because on the way to an app the query is the app's signed request. See `lib/oauth-flow`.
const welcomeSearch = z.looseObject({
	/** Where to go once there is a password. */
	redirect: z.string().optional().catch(undefined),
});

/**
 * The last step of signing up: the address is proven, so now a password can belong to the person
 * who proved it. The provider sends people here on the way to an app too: those who have only proved
 * an address, and everyone an app asked to see this for, with `prompt=create`, until told they are
 * done.
 */
export const Route = createFileRoute("/welcome")({
	validateSearch: welcomeSearch,
	beforeLoad: async ({ search }) => {
		const next = safeRedirect(search.redirect) ?? "/account";
		const flow = inFlow(search);
		const session = await getSession();
		if (!session) {
			if (flow && asksForNewAccount(search)) {
				throw redirect({ to: "/signup", search: flowSearch(search) });
			}
			throw redirect({ to: "/login", search: flow ? flowSearch(search) : { redirect: next } });
		}
		const settled = welcomeIsDone(search, await signInMethods());
		if (settled && !flow) throw redirect({ href: next });
		return { session, next, settled };
	},
	component: WelcomePage,
});

/** Tells the provider this person is done here, and it takes them on to the app. */
async function carryOn() {
	const { data, error } = await authClient.$fetch("/oauth2/continue", {
		method: "POST",
		body: { created: true },
	});
	return onItsWay(data) ? null : (error ?? {});
}

/** Someone with nothing left to do here, whom the provider sent on the way to an app. */
function CarryingOn() {
	const search = Route.useSearch();
	const [error, setError] = useState<ReactNode>(null);
	useDocumentTitle("Signing you in");

	useEffect(() => {
		carryOn().then((failure) => {
			if (failure) setError(failureMessage(failure, search));
		});
	}, [search]);

	return (
		<AuthPage title="Signing you in">
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
		</AuthPage>
	);
}

function WelcomePage() {
	const { settled } = Route.useRouteContext();
	return settled ? <CarryingOn /> : <PasswordForm />;
}

function PasswordForm() {
	const { session, next } = Route.useRouteContext();
	const search = Route.useSearch();
	const router = useRouter();
	const [error, setError] = useState<ReactNode>(null);
	const [pending, setPending] = useState(false);
	useDocumentTitle("Choose a password");

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		const newPassword = String(form.get("password"));
		if (newPassword !== String(form.get("confirm"))) {
			setError("The passwords do not match");
			return;
		}
		setPending(true);
		setError(null);
		const result = await authClient.$fetch("/account/first-password", {
			method: "POST",
			body: { newPassword },
		});
		if (result.error) {
			setPending(false);
			setError(failureMessage(result.error, search));
			return;
		}
		if (inFlow(search)) {
			const failure = await carryOn();
			if (failure) {
				setPending(false);
				setError(failureMessage(failure, search));
			}
			return;
		}
		await router.navigate({ href: next });
	}

	return (
		<AuthPage
			title="Choose a password"
			description={
				<>
					You will use it to sign in as{" "}
					<span className="text-foreground">{session.user.email}</span>.
				</>
			}
		>
			<form onSubmit={onSubmit} className="space-y-4">
				{/* Tells a password manager which account this password belongs to. */}
				<input
					type="email"
					name="email"
					autoComplete="username"
					value={session.user.email}
					readOnly
					hidden
				/>
				<div className="space-y-2">
					<Label htmlFor="password">Password</Label>
					<Input
						id="password"
						name="password"
						type="password"
						minLength={8}
						autoComplete="new-password"
						autoFocus
						required
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="confirm">Repeat it</Label>
					<Input
						id="confirm"
						name="confirm"
						type="password"
						minLength={8}
						autoComplete="new-password"
						required
					/>
				</div>
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
				<LiveButton type="submit" className="w-full" disabled={pending}>
					Continue
				</LiveButton>
			</form>
		</AuthPage>
	);
}
