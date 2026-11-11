/** Where someone can ask for an account on a server that takes them by invitation, when its owner says. */
export function AskForAccess({ url }: { url: string | null | undefined }) {
	if (!url) return null;
	return (
		<p className="text-center text-sm text-muted-foreground">
			Not invited yet?{" "}
			<a
				href={url}
				rel="noopener noreferrer"
				className="font-medium text-foreground underline-offset-4 hover:underline"
			>
				Ask for access
			</a>
		</p>
	);
}
