// Runs the OpenID Foundation's conformance suite against a local build of ID, plays the person in a
// browser, and compares every test's result with `expected.ts`. `pnpm test:conformance`; it needs Docker.
//
//   node conformance/run.mjs [first-party] [workspace]   which apps to test with (default both)
//   CONFORMANCE_TESTS=a,b   only these tests of the Basic OP plan, and Config OP is left out
//   CONFORMANCE_NO_BUILD=1  uses the build already there, which has to be this script's
//   CONFORMANCE_KEEP=1      leaves the suite running, which saves a minute next time
//
// Everything is local and thrown away: the database is e2e/server.mjs's, wiped when it starts, and the
// suite keeps its data in memory. See docs/conformance.md.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { hashPassword } from "better-auth/crypto";
import { PERSON } from "../e2e/fixtures.ts";
import { appRow, insertStatement, workspaceAppRow } from "../src/server/auth/app-row.ts";
import { expectedOf, namedTests } from "./expected.ts";

const here = import.meta.dirname;
const root = resolve(here, "..");
const output = resolve(here, "results");
const compose = ["compose", "-f", resolve(here, "docker-compose.yml")];

// ID as the browser and the suite both see it, through the `id` service of docker-compose.yml.
const ID = "https://id.localhost:4734";
const SUITE = "https://localhost.emobix.co.uk:8443";
// The suite itself, for this script to talk to, without the certificate nothing here could check.
const SUITE_API = "http://127.0.0.1:4735";
const PREVIEW = "http://localhost:4732";
const WORKSPACE = "conformance-workspace";
// The preview listens on every address for a run, and the seeded person's password is in this repository.
const PASSWORD = randomBytes(24).toString("base64url");

const named = process.argv.slice(2);
const kinds = named.length > 0 ? named : ["first-party", "workspace"];
const only = process.env.CONFORMANCE_TESTS?.split(",") ?? null;
const say = (line) => console.log(line);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Talks to the suite. */
function suite(method, path, body, contentType = "application/json") {
	return new Promise((done, fail) => {
		const data = body === undefined || typeof body === "string" ? body : JSON.stringify(body);
		const req = request(
			`${SUITE_API}/${path}`,
			{
				method,
				headers: {
					accept: "application/json",
					// It answers 500 to a request that says it did not come over https, as nginx would say.
					"x-forwarded-proto": "https",
					...(data === undefined
						? {}
						: { "content-type": contentType, "content-length": Buffer.byteLength(data) }),
				},
			},
			(res) => {
				const chunks = [];
				res.on("data", (chunk) => chunks.push(chunk));
				res.on("end", () => {
					const text = Buffer.concat(chunks).toString("utf8");
					let json;
					try {
						json = JSON.parse(text);
					} catch {
						json = undefined;
					}
					done({ status: res.statusCode, json, text });
				});
			},
		);
		req.on("error", fail);
		req.setTimeout(60_000, () => req.destroy(new Error(`timed out: ${method} ${path}`)));
		if (data !== undefined) req.write(data);
		req.end();
	});
}

async function untilUp(what, check, ms) {
	const end = Date.now() + ms;
	for (;;) {
		if (await check().catch(() => false)) return;
		if (Date.now() > end) throw new Error(`${what} did not come up`);
		await sleep(2000);
	}
}

function docker(...args) {
	const run = spawnSync("docker", [...compose, ...args], { cwd: here, stdio: "inherit" });
	if (run.status !== 0) throw new Error(`docker ${args.join(" ")} failed`);
}

/**
 * Three apps of one kind for one alias, since the suite has a test each for a second app and for a
 * secret in the body. None insists on PKCE: this plan does not use it, as many real libraries do not.
 */
function appsOf(kind) {
	const alias = `gwid-${kind}`;
	const redirectUris = [`${SUITE}/test/a/${alias}/callback`];
	const make = (name, clientAuth) => {
		const library = { name, redirectUris, clientAuth, requirePkce: false };
		return kind === "workspace"
			? workspaceAppRow({ ...library, workspace: WORKSPACE, addedBy: "seeded-person" })
			: appRow({ ...library, app: `conformance-${randomBytes(3).toString("hex")}` });
	};
	const client = make("Conformance app", "client_secret_basic");
	const client2 = make("Conformance app two", "client_secret_basic");
	const post = make("Conformance app post", "client_secret_post");
	const held = ({ clientId, clientSecret }) => ({
		client_id: clientId,
		client_secret: clientSecret,
	});
	return {
		rows: [client, client2, post].map((app) => app.row),
		config: {
			alias,
			description: `Gateweave ID, ${kind} apps`,
			server: { discoveryUrl: `${ID}/.well-known/openid-configuration`, login_hint: PERSON.email },
			client: held(client),
			client2: held(client2),
			client_secret_post: held(post),
		},
	};
}

async function seedStatements(apps) {
	const now = Date.now();
	return [
		`UPDATE "account" SET password = '${await hashPassword(PASSWORD)}' WHERE user_id = 'seeded-person';`,
		`INSERT INTO "organization" (id, name, slug, created_at) VALUES ('${WORKSPACE}', 'Conformance', 'conformance', ${now});`,
		`INSERT INTO "member" (id, organization_id, user_id, role, created_at) VALUES ('conformance-member', '${WORKSPACE}', 'seeded-person', 'owner', ${now});`,
		...apps.flatMap((app) => app.rows.map(insertStatement)),
	].join("\n");
}

/** Each test is someone new to the limits, which allow one address three sign-ins in ten seconds. */
let clients = 0;
function nextAddress() {
	clients += 1;
	return `192.0.${Math.floor(clients / 250) + 2}.${(clients % 250) + 1}`;
}

async function fillSignIn(page) {
	await page.waitForLoadState("networkidle").catch(() => {});
	await page.getByRole("heading", { name: "Sign in to Gateweave ID" }).waitFor({ timeout: 15_000 });
	await page.getByLabel("Email").fill(PERSON.email);
	await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

async function leftLogin(page, ms) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const url = new URL(page.url());
		if (url.origin !== ID || url.pathname !== "/login") return true;
		await page.waitForTimeout(200);
	}
	return false;
}

/** Plays the person from a page the suite named, until the page comes to rest. */
async function settle(page, test, folder, seen) {
	const end = Date.now() + 60_000;
	let signIns = 0;
	let lastPath = "";
	let sameSince = Date.now();
	for (;;) {
		if (Date.now() > end) return `timed out at ${new URL(page.url()).pathname}`;
		const url = new URL(page.url());
		const path = `${url.origin}${url.pathname}`;
		if (path !== lastPath) {
			lastPath = path;
			sameSince = Date.now();
			seen.push(url.pathname);
		}
		if (url.origin === SUITE && url.pathname.endsWith("/callback")) {
			const submitted = await page
				.locator("#submission_complete")
				.waitFor({ state: "attached", timeout: 20_000 })
				.then(() => true)
				.catch(() => false);
			return submitted ? "back at the app" : "at the callback, not submitted";
		}
		if (url.origin === ID && url.pathname === "/login") {
			await page.waitForLoadState("networkidle").catch(() => {});
			await page.screenshot({ path: resolve(folder, `${test}-login.png`) }).catch(() => {});
			signIns += 1;
			if (signIns > 2) return "asked to sign in a third time";
			await fillSignIn(page);
			if (!(await leftLogin(page, 30_000))) return "stuck at sign-in";
			continue;
		}
		if (url.origin === ID && url.pathname === "/consent") {
			await page.waitForLoadState("networkidle").catch(() => {});
			await page.getByRole("button", { name: "Allow" }).click({ timeout: 10_000 });
			const answered = await page
				.waitForURL((next) => next.pathname !== "/consent", { timeout: 30_000 })
				.then(() => true)
				.catch(() => false);
			if (!answered) return "stuck at consent";
			continue;
		}
		// Anywhere else at ID, for a while: a page that stops here, which is what some tests want.
		if (url.origin === ID && Date.now() - sameSince > 4000) return `stopped at ${url.pathname}`;
		if (url.protocol === "chrome-error:") return "browser error page";
		await page.waitForTimeout(200);
	}
}

async function visit(context, entry, test, folder, seen, index) {
	const page = await context.newPage();
	// A page's address changes only once something other than a redirect has answered, so a page resting
	// at a path of the API was given something, and what it was is the first thing to ask.
	let answered;
	page.on("response", (response) => {
		const request = response.request();
		if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
			answered = response.status();
		}
	});
	try {
		if (entry.method === "POST") {
			const target = new URL(entry.url);
			const fields = [...target.searchParams.entries()];
			target.search = "";
			await page.goto(`data:text/html,<!doctype html><form id="f" method="POST"></form>`);
			await page.evaluate(
				({ action, fields }) => {
					const form = document.getElementById("f");
					form.action = action;
					for (const [name, value] of fields) {
						const input = document.createElement("input");
						input.type = "hidden";
						input.name = name;
						input.value = value;
						form.appendChild(input);
					}
					form.submit();
				},
				{ action: target.href, fields },
			);
			await page.waitForTimeout(300);
		} else {
			await page.goto(entry.url, { waitUntil: "load" }).catch(() => {});
		}
		const where = await settle(page, test, folder, seen);
		const shot = resolve(folder, `${test}-${index}.png`);
		await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
		const resting = where.startsWith("back") || answered === undefined;
		return { where: resting ? where : `${where}, answered ${answered}`, shot };
	} finally {
		await page.close().catch(() => {});
	}
}

/** What these tests ask to see is the page that asked to sign in again, not where it ended. */
async function uploadPicture(id, test, folder, last) {
	const login = resolve(folder, `${test}-login.png`);
	const picture = existsSync(login) ? login : last;
	const images = await suite("GET", `api/log/${id}/images`);
	for (const item of images.json ?? []) {
		if (!item.upload) continue;
		const body = `data:image/png;base64,${readFileSync(picture).toString("base64")}`;
		const type = "text/plain;charset=UTF-8";
		await suite("POST", `api/log/${id}/images/${encodeURIComponent(item.upload)}`, body, type);
	}
}

/** What a test's log says went wrong. Names and messages only, since a log holds tokens elsewhere. */
function findingsOf(entries) {
	return (entries ?? [])
		.filter((entry) => ["FAILURE", "WARNING", "REVIEW", "INTERRUPTED"].includes(entry.result))
		.map((entry) => ({
			result: entry.result,
			src: entry.src,
			msg: String(entry.msg ?? "").slice(0, 300),
		}));
}

async function runTest(browser, signedIn, planId, module, kind, folder) {
	const test = module.testModule;
	const variant = module.variant
		? `&variant=${encodeURIComponent(JSON.stringify(module.variant))}`
		: "";
	const made = await suite("POST", `api/runner?test=${test}&plan=${planId}${variant}`);
	if (made.status !== 201) return { test, status: "NOT STARTED", result: null, path: [] };
	const id = made.json.id;
	const anonymous = test === "oidcc-prompt-none-not-logged-in" ? await newContext(browser) : null;
	const context = anonymous ?? signedIn;
	await context.setExtraHTTPHeaders({ "cf-connecting-ip": nextAddress() });
	const seen = new Set();
	const path = [];
	const pages = [];
	const stopAt = Date.now() + 120_000;
	let lastShot;
	let uploaded = false;
	let status;
	for (;;) {
		status = (await suite("GET", `api/info/${id}`)).json?.status;
		if (status === "FINISHED" || status === "INTERRUPTED") break;
		if (Date.now() > stopAt) {
			await suite("DELETE", `api/runner/${id}`).catch(() => {});
			status = "TIMED OUT";
			break;
		}
		const browserState = (await suite("GET", `api/runner/${id}`)).json?.browser;
		const entries =
			browserState?.urlsWithMethod ??
			(browserState?.urls ?? []).map((url) => ({ url, method: "GET" }));
		for (const entry of entries) {
			if (seen.has(entry.url)) continue;
			seen.add(entry.url);
			const visited = `api/runner/browser/${id}/visit?url=${encodeURIComponent(entry.url)}&method=${entry.method ?? "GET"}`;
			await suite("POST", visited);
			try {
				const page = await visit(context, entry, test, folder, path, seen.size);
				pages.push(page.where);
				lastShot = page.shot;
			} catch (error) {
				pages.push(`the runner failed: ${String(error?.message).split("\n")[0]}`);
			}
		}
		if ((browserState?.uploadsRequired ?? 0) > 0 && lastShot && !uploaded) {
			uploaded = true;
			await uploadPicture(id, test, folder, lastShot);
		}
		await sleep(500);
	}
	if (anonymous) await anonymous.close().catch(() => {});
	const final = await suite("GET", `api/info/${id}`);
	const log = await suite("GET", `api/log/${id}`);
	return {
		test,
		kind,
		status,
		result: final.json?.result ?? null,
		path,
		pages,
		findings: findingsOf(log.json),
	};
}

/** What failed in a page. The suite cannot see it, and a page that throws is wrong whatever it says. */
const pageErrors = new Set();

async function newContext(browser) {
	const context = await browser.newContext({
		ignoreHTTPSErrors: true,
		viewport: { width: 1100, height: 760 },
	});
	context.on("page", (page) => {
		page.on("pageerror", (error) => pageErrors.add(error.message.slice(0, 200)));
	});
	return context;
}

async function runPlan(browser, planName, variant, config, kind) {
	const folder = resolve(output, kind);
	mkdirSync(folder, { recursive: true });
	const query = variant ? `&variant=${encodeURIComponent(JSON.stringify(variant))}` : "";
	const created = await suite("POST", `api/plan?planName=${planName}${query}`, config);
	if (created.status !== 201) throw new Error(`the suite refused the plan: ${created.status}`);
	const signedIn = await newContext(browser);
	await signedIn.setExtraHTTPHeaders({ "cf-connecting-ip": nextAddress() });
	const first = await signedIn.newPage();
	await first.goto(`${ID}/login`, { waitUntil: "networkidle" });
	await fillSignIn(first);
	await first.waitForURL((url) => url.pathname === "/account", { timeout: 30_000 });
	await first.close();

	const rows = [];
	const planned = created.json.modules.map((module) => module.testModule);
	const filtered = only && planName === "oidcc-basic-certification-test-plan";
	const unknown = filtered ? only.filter((test) => !planned.includes(test)) : [];
	if (unknown.length > 0) throw new Error(`the plan has no such test: ${unknown.join(", ")}`);
	const wanted = created.json.modules.filter(
		(module) => !filtered || only.includes(module.testModule),
	);
	for (const module of wanted) {
		const started = Date.now();
		const row = await runTest(browser, signedIn, created.json.id, module, kind, folder);
		rows.push(row);
		const seconds = Math.round((Date.now() - started) / 1000);
		say(`  ${row.test}: ${row.result ?? row.status} (${seconds} s)`);
	}
	await signedIn.close().catch(() => {});
	return { rows, planned };
}

/** Everything that differs from `expected.ts`. */
function differences(kind, rows) {
	const out = [];
	for (const row of rows) {
		const expected = expectedOf(kind, row.test);
		if (row.result !== expected.result) {
			out.push({
				test: row.test,
				said: `expected ${expected.result}, got ${row.result ?? row.status}`,
				findings: row.findings ?? [],
				pages: row.pages ?? [],
			});
		} else if (expected.shows && !row.path.includes(expected.shows)) {
			out.push({
				test: row.test,
				said: `expected it to show ${expected.shows}, it went ${row.path.join(" > ")}`,
				findings: [],
				pages: row.pages ?? [],
			});
		}
	}
	return out;
}

/** A test `expected.ts` names and a new version of the suite has dropped. */
function dropped(kind, planned) {
	return namedTests(kind)
		.filter((test) => !planned.includes(test))
		.map((test) => ({ test, said: "expected.ts names it, and the plan has no such test" }));
}

function report(sections) {
	const lines = ["## OpenID conformance suite", ""];
	for (const { title, rows, differ } of sections) {
		const counts = {};
		for (const row of rows) {
			const key = row.result ?? row.status;
			counts[key] = (counts[key] ?? 0) + 1;
		}
		const summary = Object.entries(counts)
			.map(([result, count]) => `${count} ${result}`)
			.join(", ");
		lines.push(`**${title}:** ${summary}. ${differ.length === 0 ? "As expected." : "Differs:"}`);
		for (const item of differ) {
			lines.push(`- \`${item.test}\`: ${item.said}`);
			for (const finding of item.findings ?? []) {
				if (finding.result === "FAILURE" || finding.result === "INTERRUPTED") {
					lines.push(`  - ${finding.src}: ${finding.msg}`);
				}
			}
			for (const page of item.pages ?? []) {
				if (!page.startsWith("back")) lines.push(`  - the page: ${page}`);
			}
		}
		lines.push("");
	}
	const text = lines.join("\n");
	say(`\n${text}`);
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
}

function stop(server) {
	if (!server || server.exitCode !== null) return;
	if (process.platform === "win32") {
		// Killing a process does not reach its children here, and they would hold the database open.
		spawnSync("taskkill", ["/T", "/F", "/PID", String(server.pid)], { stdio: "ignore" });
	} else {
		server.kill("SIGTERM");
	}
}

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

let server;
let failed = false;
try {
	if (!process.env.CONFORMANCE_NO_BUILD) {
		const built = spawnSync(process.execPath, [resolve(root, "e2e/build.mjs")], {
			cwd: root,
			stdio: "inherit",
			env: { ...process.env, ID_E2E_URL: ID },
		});
		if (built.status !== 0) throw new Error("the build failed");
	}

	docker("up", "-d", "--quiet-pull");
	await untilUp(
		"the suite",
		async () => (await suite("GET", "api/plan?length=1")).status === 200,
		180_000,
	);

	const apps = Object.fromEntries(kinds.map((kind) => [kind, appsOf(kind)]));
	const seedFile = resolve(output, "seed.sql");
	writeFileSync(seedFile, await seedStatements(Object.values(apps)));
	const log = openSync(resolve(output, "server.log"), "w");
	server = spawn(process.execPath, [resolve(root, "e2e/server.mjs")], {
		cwd: root,
		stdio: ["ignore", log, log],
		// The containers reach this machine by an address other than localhost.
		env: { ...process.env, ID_E2E_HOST: "0.0.0.0", ID_E2E_SEED: seedFile },
	});
	await untilUp("ID", async () => (await fetch(`${PREVIEW}/login`)).status === 200, 120_000);
	rmSync(seedFile);

	const browser = await chromium.launch();
	const sections = [];
	if (!only) {
		const [config] = Object.values(apps);
		say("Config OP");
		const plan = await runPlan(
			browser,
			"oidcc-config-certification-test-plan",
			undefined,
			config.config,
			kinds[0],
		);
		sections.push({
			title: "Config OP",
			rows: plan.rows,
			differ: differences(kinds[0], plan.rows),
		});
	}
	for (const kind of kinds) {
		say(`Basic OP, ${kind} apps`);
		const variant = { server_metadata: "discovery", client_registration: "static_client" };
		const plan = await runPlan(
			browser,
			"oidcc-basic-certification-test-plan",
			variant,
			apps[kind].config,
			kind,
		);
		sections.push({
			title: `Basic OP, ${kind} apps`,
			rows: plan.rows,
			differ: [...differences(kind, plan.rows), ...(only ? [] : dropped(kind, plan.planned))],
		});
		writeFileSync(resolve(output, `${kind}.json`), JSON.stringify(plan.rows, null, 1));
	}
	await browser.close();
	if (pageErrors.size > 0) {
		sections.push({
			title: "Pages",
			rows: [],
			differ: [...pageErrors].map((error) => ({ test: "a page threw", said: error })),
		});
	}
	report(sections);
	failed = sections.some((section) => section.differ.length > 0);
} catch (error) {
	failed = true;
	say(`The run stopped: ${error?.stack ?? error}`);
} finally {
	stop(server);
	if (failed) {
		// What the containers said goes with the results, which CI keeps when a run fails. Taking the
		// containers down loses it. Nothing in it outlives the run: the apps, the person and the server
		// are all made for it. The Worker's own log is server.log, which is why these have other names.
		for (const [service, name] of [
			["id", "proxy.log"],
			["server", "suite.log"],
		]) {
			const logs = spawnSync("docker", [...compose, "logs", "--no-color", service], {
				cwd: here,
				maxBuffer: 512 * 1024 * 1024,
			});
			writeFileSync(resolve(output, name), logs.stdout ?? "");
		}
	}
	if (!process.env.CONFORMANCE_KEEP) docker("down", "--volumes", "--timeout", "5");
}
process.exit(failed ? 1 : 0);
