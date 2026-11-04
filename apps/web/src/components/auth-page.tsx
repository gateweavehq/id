import type { ReactNode } from "react";

/** The narrow centered column of the pages around signing in. */
export function AuthPage({
	title,
	description,
	children,
}: {
	title: string;
	description?: ReactNode;
	children: ReactNode;
}) {
	return (
		<main className="flex min-h-svh items-center justify-center p-6">
			<div className="w-full max-w-sm space-y-6">
				<div className="space-y-1.5">
					<h1 className="text-xl font-semibold tracking-tight">{title}</h1>
					{description && <p className="text-sm text-muted-foreground">{description}</p>}
				</div>
				{children}
			</div>
		</main>
	);
}
