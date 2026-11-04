import type { Email } from "./mailer";

/** An email before it is addressed. */
export type Message = Omit<Email, "to">;

const PRODUCT = "Gateweave ID";

export function passwordResetEmail({ url }: { url: string }): Message {
	return compose({
		subject: `Reset your ${PRODUCT} password`,
		heading: "Reset your password",
		body: [
			`Someone asked to reset the password of your ${PRODUCT} account. If it was you, choose a new password below. The link works for one hour, once.`,
			"Resetting it signs you out on every device.",
		],
		action: { label: "Choose a new password", url },
		footer: "If you did not ask for this, ignore this email. Your password stays as it is.",
	});
}

export function verificationEmail({ url }: { url: string }): Message {
	return compose({
		subject: `Verify your email for ${PRODUCT}`,
		heading: "Verify your email",
		body: [
			`Confirm that this address is yours to finish setting up your ${PRODUCT} account. You cannot sign in until you do, and the apps you sign in to trust that you have. The link works for 24 hours.`,
		],
		action: { label: "Verify email", url },
		footer: `If you did not create a ${PRODUCT} account, ignore this email.`,
	});
}

function compose({
	subject,
	heading,
	body,
	action,
	footer,
}: {
	subject: string;
	heading: string;
	body: string[];
	action: { label: string; url: string };
	footer: string;
}): Message {
	const text = [...body, `${action.label}: ${action.url}`, footer, `— ${PRODUCT}`].join("\n\n");
	const paragraphs = body
		.map((line) => `<p style="margin:0 0 16px">${escapeHtml(line)}</p>`)
		.join("");
	const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:24px;background:#f5f5f5;color:#171717;font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
<div style="max-width:480px;margin:0 auto;padding:32px;background:#ffffff;border:1px solid #e5e5e5;border-radius:8px">
<p style="margin:0 0 24px;font-size:13px;font-weight:600;color:#525252">${PRODUCT}</p>
<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3">${escapeHtml(heading)}</h1>
${paragraphs}
<p style="margin:24px 0"><a href="${escapeHtml(action.url)}" style="display:inline-block;padding:10px 16px;background:#171717;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600">${escapeHtml(action.label)}</a></p>
<p style="margin:0 0 16px;font-size:13px;color:#525252">Or paste this link into your browser:<br><span style="word-break:break-all">${escapeHtml(action.url)}</span></p>
<p style="margin:24px 0 0;font-size:13px;color:#737373">${escapeHtml(footer)}</p>
</div>
</body>
</html>`;
	return { subject: oneLine(subject), text, html };
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}
