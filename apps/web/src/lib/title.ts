import { useEffect } from "react";

/** Names the browser tab after what is on screen, e.g. "Repositories · Gateweave ID". */
export function useDocumentTitle(title: string | undefined): void {
	useEffect(() => {
		if (title) document.title = `${title} · Gateweave ID`;
	}, [title]);
}
