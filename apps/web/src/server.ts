import handler from "@tanstack/react-start/server-entry";

export { RateLimiter } from "./server/rate-limit";

export default {
	fetch(request) {
		return handler.fetch(request);
	},
} satisfies ExportedHandler<Cloudflare.Env>;
