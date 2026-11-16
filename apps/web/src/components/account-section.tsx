import { type ReactNode, type Ref, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/utils";

/** A button in a row of a list. A finger needs more than a pointer does, so it is taller on a phone. */
export const ROW_BUTTON = "max-sm:h-9";

/** A part of the account page that the row of links at its top leads to. */
export function AccountGroup({
	id,
	title,
	children,
}: {
	id: string;
	title: string;
	children: ReactNode;
}) {
	return (
		// Below the row of links, which stays at the top of the window.
		<div id={id} className="scroll-mt-16 space-y-6">
			<h2 className="text-base font-semibold tracking-tight">{title}</h2>
			{children}
		</div>
	);
}

/**
 * One thing on the account page, with its heading and everything about it in one frame. What goes
 * inside is a row each: `CARD_ROW` for a line of words, `CARD_FORM` for a form.
 */
export function AccountCard({
	id,
	title,
	level = 3,
	headingRef,
	aside,
	danger = false,
	children,
}: {
	/** The heading's id, which names the section. */
	id: string;
	title: string;
	/** 2 for a card that stands alone, outside any group. */
	level?: 2 | 3;
	/** For moving the focus here when what had it has gone. */
	headingRef?: Ref<HTMLHeadingElement>;
	/** What sits across from the heading: a word about its state, or what adds to the list. */
	aside?: ReactNode;
	/** For what cannot be undone. */
	danger?: boolean;
	children: ReactNode;
}) {
	const Heading = level === 2 ? "h2" : "h3";
	return (
		<section aria-labelledby={id} className="space-y-3">
			<div className="flex min-h-8 flex-wrap items-center justify-between gap-x-4 gap-y-1">
				<Heading
					id={id}
					ref={headingRef}
					tabIndex={-1}
					className={cn(
						"font-semibold outline-none",
						level === 2 ? "text-base tracking-tight" : "text-sm",
					)}
				>
					{title}
				</Heading>
				{aside}
			</div>
			<div className={cn("divide-y rounded-lg border text-sm", danger && "border-destructive/50")}>
				{children}
			</div>
		</section>
	);
}

export const CARD_ROW = "px-4 py-3";
export const CARD_FORM = "space-y-4 p-4";
/** A row with words on one side and what acts on them on the other, which goes under on a phone. */
export const CARD_ACTION_ROW =
	"flex flex-col items-start gap-x-4 gap-y-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between [&>:last-child]:shrink-0";

/** A list that could not be read, and the way to ask again. Without it the list would only be gone. */
export function LoadFailure({
	message,
	loading,
	onRetry,
}: {
	message: string;
	loading: boolean;
	onRetry: () => void;
}) {
	return (
		<div className={CARD_ACTION_ROW}>
			<p role="alert" className="text-destructive">
				{message}
			</p>
			{/* Not disabled while it tries, which would take the focus from whoever pressed it. */}
			<Button
				variant="outline"
				size="sm"
				className={ROW_BUTTON}
				aria-disabled={loading}
				onClick={() => {
					if (!loading) onRetry();
				}}
			>
				{loading ? "Trying…" : "Try again"}
			</Button>
		</div>
	);
}

interface Answer<Data> {
	data: Data | null;
	error: { message?: string | undefined } | null;
}

/**
 * Something the page reads in the browser, such as a list. A request that fails outright rejects, and
 * one the server refuses comes back with an error, and either way this ends up with a failure to show
 * and `reload` to ask again, where a list would otherwise stay on "Loading…" for good. `reload` says
 * whether it worked. What was read before stays while it asks again, and when asking again fails.
 *
 * `read` is called again whenever it changes, so it has to be the same function each render.
 */
export function useLoaded<Data>(read: () => Promise<Answer<Data>>, notLoaded: string) {
	const [data, setData] = useState<Data | null>(null);
	const [failure, setFailure] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	/** Which request is the latest. An earlier one that answers late must not put back an older list. */
	const asked = useRef(0);

	const reload = useCallback(async (): Promise<boolean> => {
		const mine = ++asked.current;
		const latest = () => asked.current === mine;
		setLoading(true);
		try {
			const answer = await read();
			const failed = answer.error || answer.data === null;
			if (!latest()) return !failed;
			if (failed) {
				setFailure(answer.error?.message ?? notLoaded);
				return false;
			}
			setData(answer.data);
			setFailure(null);
			return true;
		} catch {
			if (latest()) setFailure(notLoaded);
			return false;
		} finally {
			if (latest()) setLoading(false);
		}
	}, [read, notLoaded]);

	useEffect(() => {
		reload();
	}, [reload]);

	return { data, failure, loading, reload };
}

/**
 * For a step that takes the place of the button that opened it: gives that button the focus back
 * once the step closes, where it would otherwise be left on nothing.
 */
export function useFocusBack<Opener extends HTMLElement>(open: boolean) {
	const opener = useRef<Opener>(null);
	const wasOpen = useRef(false);
	useEffect(() => {
		if (wasOpen.current && !open) opener.current?.focus();
		wasOpen.current = open;
	}, [open]);
	return opener;
}
