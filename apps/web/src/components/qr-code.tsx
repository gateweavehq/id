import { encode } from "uqr";

/**
 * A QR code as an SVG in the page. An image would have to come from a `data:` address, which the
 * Content Security Policy leaves out, and a service that drew it would learn what it says. It is black
 * on white whatever the page's theme, because that is what cameras read reliably.
 */
export function QrCode({ text, label }: { text: string; label: string }) {
	const { data, size } = encode(text, { border: 2 });
	const modules = data.flatMap((row, y) =>
		row.flatMap((dark, x) => (dark ? [`M${x} ${y}h1v1h-1z`] : [])),
	);
	return (
		<svg
			role="img"
			aria-label={label}
			viewBox={`0 0 ${size} ${size}`}
			shapeRendering="crispEdges"
			className="size-48 rounded-md bg-white"
		>
			<path d={modules.join("")} fill="#000" />
		</svg>
	);
}
