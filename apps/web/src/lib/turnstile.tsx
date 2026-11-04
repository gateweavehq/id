import { useCallback, useEffect, useRef } from "react";
import { TURNSTILE_ACTION } from "./turnstile-action";

declare global {
	interface Window {
		turnstile?: {
			render(
				container: HTMLElement,
				options: {
					sitekey: string;
					action: string;
					size: "flexible";
					appearance: "interaction-only";
					callback: (token: string) => void;
					"error-callback": () => void;
					"expired-callback": () => void;
					"timeout-callback": () => void;
				},
			): string;
			remove(widgetId: string): void;
		};
	}
}

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let script: Promise<NonNullable<Window["turnstile"]>> | undefined;

function loadTurnstile() {
	script ??= new Promise((resolve, reject) => {
		const element = document.createElement("script");
		element.src = SCRIPT;
		element.async = true;
		element.onload = () => {
			if (window.turnstile) resolve(window.turnstile);
			else reject(new Error("Turnstile did not start"));
		};
		element.onerror = () => {
			// Let the next attempt try again.
			script = undefined;
			element.remove();
			reject(new Error("Turnstile did not load"));
		};
		document.head.appendChild(element);
	});
	return script;
}

/** What a page shows when the check could not run, which a retry usually fixes. */
export const TURNSTILE_FAILED =
	"We could not check that this is a person. Reload the page and try again.";

/**
 * The bot check in front of a form. `element` goes in the form, and stays empty unless Cloudflare
 * wants someone to click. `check` runs one check and resolves to the headers of the request it
 * covers.
 *
 * A token works once and these pages stay open after a refused request, so every check renders a
 * widget of its own and removes it. That also means a form left open for an hour still works.
 *
 * Without a site key this server has no Turnstile, and `check` adds nothing.
 */
export function useTurnstile(siteKey: string | undefined) {
	const container = useRef<HTMLDivElement>(null);

	useEffect(() => {
		// Ready before the first click, so submitting waits as little as it can. A failure here
		// shows up when the form is sent.
		if (siteKey) loadTurnstile().catch(() => {});
	}, [siteKey]);

	const check = useCallback(async (): Promise<Record<string, string>> => {
		if (!siteKey) return {};
		const target = container.current;
		if (!target) throw new Error(TURNSTILE_FAILED);
		const turnstile = await loadTurnstile().catch(() => {
			throw new Error(TURNSTILE_FAILED);
		});
		let widgetId: string | undefined;
		try {
			const token = await new Promise<string>((resolve, reject) => {
				const fail = () => reject(new Error(TURNSTILE_FAILED));
				widgetId = turnstile.render(target, {
					sitekey: siteKey,
					action: TURNSTILE_ACTION,
					size: "flexible",
					appearance: "interaction-only",
					callback: resolve,
					"error-callback": fail,
					"expired-callback": fail,
					"timeout-callback": fail,
				});
			});
			return { "x-captcha-response": token };
		} finally {
			if (widgetId) turnstile.remove(widgetId);
		}
	}, [siteKey]);

	return { element: <div ref={container} className="empty:hidden" />, check };
}
