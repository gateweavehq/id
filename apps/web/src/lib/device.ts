const BROWSERS: [RegExp, string][] = [
	// These all say "Chrome" as well, and Chrome says "Safari", so the order matters.
	[/\bEdg(e|A|iOS)?\//, "Edge"],
	[/\bOPR\//, "Opera"],
	[/\bSamsungBrowser\//, "Samsung Internet"],
	[/\b(Firefox|FxiOS)\//, "Firefox"],
	[/\b(Chrome|HeadlessChrome|Chromium|CriOS)\//, "Chrome"],
	[/\bSafari\//, "Safari"],
];

const SYSTEMS: [RegExp, string][] = [
	// iPhones and iPads say "like Mac OS X", and Android says "Linux".
	[/\b(iPhone|iPod)\b/, "iPhone"],
	[/\biPad\b/, "iPad"],
	[/\bAndroid\b/, "Android"],
	[/\bCrOS\b/, "ChromeOS"],
	[/\bWindows\b/, "Windows"],
	[/\bMac OS X\b/, "macOS"],
	[/\bLinux\b/, "Linux"],
];

function find(names: [RegExp, string][], userAgent: string): string | undefined {
	return names.find(([pattern]) => pattern.test(userAgent))?.[1];
}

/**
 * A short name for the browser and system in a user agent, such as "Chrome on Windows", so a person
 * can tell their devices apart. It is only a label: a user agent says whatever the client likes, so
 * nothing may depend on it.
 */
export function describeDevice(userAgent: string | null | undefined): string {
	if (!userAgent) return "Unknown device";
	const browser = find(BROWSERS, userAgent);
	const system = find(SYSTEMS, userAgent);
	if (browser && system) return `${browser} on ${system}`;
	return browser ?? system ?? "Unknown device";
}
