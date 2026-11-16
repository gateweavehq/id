import { describe, expect, it } from "vitest";
import { describeBrowser, describeDevice } from "./device";

describe("describeDevice", () => {
	it.each([
		[
			"Chrome on Windows",
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
		],
		[
			"Edge on Windows",
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
		],
		[
			"Opera on macOS",
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0",
		],
		[
			"Safari on macOS",
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
		],
		[
			"Safari on iPhone",
			"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
		],
		[
			"Safari on iPad",
			"Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
		],
		[
			"Chrome on iPhone",
			"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1",
		],
		[
			"Chrome on Android",
			"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
		],
		[
			"Samsung Internet on Android",
			"Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
		],
		["Firefox on Linux", "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0"],
		[
			"Chrome on ChromeOS",
			"Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
		],
		[
			"Chrome on Linux",
			"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/130.0.0.0 Safari/537.36",
		],
	])("calls it %s", (expected, userAgent) => {
		expect(describeDevice(userAgent)).toBe(expected);
	});

	it("says what it can when only one half is known", () => {
		expect(describeDevice("Mozilla/5.0 (Windows NT 10.0)")).toBe("Windows");
		expect(describeDevice("Firefox/132.0")).toBe("Firefox");
	});

	it("does not guess", () => {
		expect(describeDevice(null)).toBe("Unknown device");
		expect(describeDevice(undefined)).toBe("Unknown device");
		expect(describeDevice("")).toBe("Unknown device");
		expect(describeDevice("curl/8.5.0")).toBe("Unknown device");
	});
});

describe("describeBrowser", () => {
	it("names the browser and the system where the user agent says both", () => {
		expect(
			describeBrowser(
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
			),
		).toBe("Chrome on Windows");
		expect(
			describeBrowser(
				"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
			),
		).toBe("Safari on iPhone");
	});

	it("says a browser where it cannot tell which", () => {
		expect(describeBrowser("Mozilla/5.0 (Windows NT 10.0)")).toBe("A browser on Windows");
		expect(describeBrowser("Firefox/132.0")).toBe("Firefox");
	});

	it("says a browser, and no more, when it is unsure", () => {
		expect(describeBrowser(null)).toBe("A browser");
		expect(describeBrowser(undefined)).toBe("A browser");
		expect(describeBrowser("")).toBe("A browser");
		expect(describeBrowser("curl/8.5.0")).toBe("A browser");
		expect(describeBrowser("Mozilla/5.0 (compatible; SomethingNew/1.0)")).toBe("A browser");
	});
});
