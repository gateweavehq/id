import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("update-copy.mjs", import.meta.url));

const wrangler = (name, { database = "", comment = "// Optional: A." } = {}) =>
	`{\n\t"name": "${name}",\n\t"main": "server.js",\n\t"d1_databases": [{ "binding": "DB"${database} }],\n\t${comment}\n\t"vars": {}\n}\n`;

const RELEASES = {
	"v0.9.0": {
		"CHANGELOG.md": "# Changelog\n\n## [0.9.0] - 2026-01-01\n",
		"wrangler.jsonc": wrangler("gateweave-id"),
		"package.json": '{ "name": "gateweave-id" }\n',
		".github/workflows/ci.yml": "name: CI\n",
		"src/app.txt": "one\n",
		"src/gone.txt": "removed in the next release\n",
	},
	"v0.10.0": {
		"CHANGELOG.md": "# Changelog\n\n## [0.10.0] - 2026-02-01\n\n## [0.9.0] - 2026-01-01\n",
		"wrangler.jsonc": wrangler("gateweave-id", { comment: "// Optional: A, B." }),
		"package.json": '{ "name": "gateweave-id" }\n',
		".github/workflows/ci.yml": "name: CI\non: push\n",
		".github/workflows/release-notes.yml": "name: Release notes\n",
		"src/app.txt": "two\n",
		"src/new.txt": "added\n",
	},
};

let dir;
let upstream;
let copy;

function run(cwd, ...args) {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

function setUpRepository(path) {
	mkdirSync(path, { recursive: true });
	run(path, "init", "--quiet", "--initial-branch=main");
	run(path, "config", "user.name", "Test");
	run(path, "config", "user.email", "test@example.com");
	run(path, "config", "core.autocrlf", "false");
}

function writeTree(path, files) {
	for (const file of run(path, "ls-files").split("\n").filter(Boolean)) {
		rmSync(join(path, file));
	}
	for (const [file, text] of Object.entries(files)) {
		mkdirSync(dirname(join(path, file)), { recursive: true });
		writeFileSync(join(path, file), text);
	}
	run(path, "add", "-A");
}

function release(tag, files) {
	writeTree(upstream, files);
	run(upstream, "commit", "--quiet", "-m", `release ${tag}`);
	run(upstream, "tag", tag);
}

function update(...args) {
	return spawnSync("node", [SCRIPT, ...args], { cwd: copy, encoding: "utf8" });
}

const read = (file) => readFileSync(join(copy, file), "utf8");

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "id-update-"));
	upstream = join(dir, "upstream");
	copy = join(dir, "copy");
	setUpRepository(upstream);
	release("v0.9.0", RELEASES["v0.9.0"]);
	release("v0.10.0", RELEASES["v0.10.0"]);

	// What the button makes from v0.9.0: one new commit, other names and no workflows.
	setUpRepository(copy);
	const { ".github/workflows/ci.yml": _, ...files } = RELEASES["v0.9.0"];
	writeTree(copy, {
		...files,
		"wrangler.jsonc": wrangler("my-id", { database: ', "database_id": "my-database"' }),
		"package.json": '{ "name": "my-id" }\n',
	});
	run(copy, "commit", "--quiet", "-m", "source repo import");
	run(copy, "remote", "add", "upstream", upstream);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

test("a plain pull fails on a copy, which is why this script exists", () => {
	const pull = spawnSync("git", ["pull", "--no-rebase", "upstream", "main"], {
		cwd: copy,
		encoding: "utf8",
	});
	assert.notEqual(pull.status, 0);
	assert.match(pull.stderr, /unrelated histories/);
});

test("brings in the latest release as one commit, keeping what the copy changed", () => {
	const before = run(copy, "rev-parse", "HEAD");
	const result = update();
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /from v0\.9\.0 to v0\.10\.0/);

	// The release's changes, additions and removals.
	assert.equal(read("src/app.txt"), "two\n");
	assert.equal(read("src/new.txt"), "added\n");
	assert.equal(existsSync(join(copy, "src/gone.txt")), false);
	assert.match(read("wrangler.jsonc"), /Optional: A, B\./);

	// The copy's own names, without which a deploy would make a new, empty app.
	assert.match(read("wrangler.jsonc"), /"name": "my-id"/);
	assert.match(read("wrangler.jsonc"), /"database_id": "my-database"/);
	assert.equal(read("package.json"), '{ "name": "my-id" }\n');

	// None of our workflows, changed or new.
	assert.equal(existsSync(join(copy, ".github/workflows/ci.yml")), false);
	assert.equal(existsSync(join(copy, ".github/workflows/release-notes.yml")), false);

	// One commit on the copy's history, with nothing left behind.
	assert.equal(run(copy, "log", "-1", "--format=%P"), before);
	assert.equal(run(copy, "log", "-1", "--format=%s"), "chore: update ID to v0.10.0");
	assert.equal(run(copy, "status", "--porcelain"), "");
	assert.equal(run(copy, "replace", "--list"), "");
	assert.equal(run(copy, "tag", "--list"), "");
});

test("runs from a pipe, as the first update of an old copy has to", () => {
	const piped = spawnSync("node", ["--input-type=module", "-", "--to", "v0.10.0"], {
		cwd: copy,
		input: readFileSync(SCRIPT, "utf8"),
		encoding: "utf8",
	});
	assert.equal(piped.status, 0, piped.stderr);
	assert.equal(read("src/app.txt"), "two\n");
});

test("runs from Windows PowerShell's pipe, which starts with a byte order mark", () => {
	const piped = spawnSync("node", ["--input-type=module"], {
		cwd: copy,
		input: `\uFEFF${readFileSync(SCRIPT, "utf8")}`,
		encoding: "utf8",
	});
	assert.equal(piped.status, 0, piped.stderr);
	assert.equal(read("src/app.txt"), "two\n");
});

test("updates again from the release it reached, with the copy's later changes kept", () => {
	assert.equal(update().status, 0);
	writeFileSync(join(copy, "local.txt"), "ours\n");
	run(copy, "add", "-A");
	run(copy, "commit", "--quiet", "-m", "something of ours");

	release("v0.11.0", {
		...RELEASES["v0.10.0"],
		"CHANGELOG.md": `# Changelog\n\n## [0.11.0] - 2026-03-01\n\n${RELEASES["v0.10.0"]["CHANGELOG.md"].slice(13)}`,
		".github/workflows/ci.yml": "name: CI\non: pull_request\n",
		"src/app.txt": "three\n",
	});
	const result = update();
	assert.equal(result.status, 0, result.stderr);
	assert.equal(read("src/app.txt"), "three\n");
	assert.equal(read("local.txt"), "ours\n");
	assert.match(read("wrangler.jsonc"), /"name": "my-id"/);
	assert.equal(existsSync(join(copy, ".github/workflows/ci.yml")), false);
});

test("orders releases as numbers, and takes the one it is asked for", () => {
	const result = update("--to", "v0.9.0");
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Already on v0\.9\.0/);
	assert.equal(update().status, 0);
	assert.match(read("CHANGELOG.md"), /## \[0\.10\.0\]/);
});

test("says so when the copy is up to date, and refuses to go back", () => {
	assert.equal(update().status, 0);
	const head = run(copy, "rev-parse", "HEAD");

	const again = update();
	assert.equal(again.status, 0);
	assert.match(again.stdout, /Already on v0\.10\.0/);

	const back = update("--to", "v0.9.0");
	assert.equal(back.status, 1);
	assert.match(back.stderr, /newer than v0\.9\.0/);
	assert.equal(run(copy, "rev-parse", "HEAD"), head);
});

test("refuses a release that does not exist", () => {
	const result = update("--to", "v9.9.9");
	assert.equal(result.status, 1);
	assert.match(result.stderr, /no release v9\.9\.9/);
});

test("touches nothing while there are uncommitted changes", () => {
	writeFileSync(join(copy, "src/app.txt"), "being edited\n");
	const result = update();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /uncommitted changes/);
	assert.equal(read("src/app.txt"), "being edited\n");
});

test("leaves real conflicts to be resolved, naming them, with nothing grafted", () => {
	writeFileSync(join(copy, "src/app.txt"), "our own one\n");
	run(copy, "add", "-A");
	run(copy, "commit", "--quiet", "-m", "something of ours");
	const head = run(copy, "rev-parse", "HEAD");

	const result = update();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /src\/app\.txt/);
	assert.doesNotMatch(result.stderr, /workflows/);
	assert.equal(run(copy, "rev-parse", "HEAD"), head);
	assert.equal(run(copy, "replace", "--list"), "");
	assert.match(read("src/app.txt"), /<<<<<<</);
});

test("stops rather than point the copy at another Worker", () => {
	// A copy that renamed nothing takes a rename from a release without a conflict, so only this
	// check catches it.
	writeTree(copy, {
		...Object.fromEntries(
			Object.entries(RELEASES["v0.9.0"]).filter(([file]) => !file.includes("workflows")),
		),
	});
	run(copy, "commit", "--quiet", "-m", "back to the original names");
	release("v0.11.0", {
		...RELEASES["v0.10.0"],
		"CHANGELOG.md": "# Changelog\n\n## [0.11.0] - 2026-03-01\n",
		"wrangler.jsonc": wrangler("renamed-by-us"),
	});
	const head = run(copy, "rev-parse", "HEAD");
	const result = update();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /another Worker, database or queue/);
	assert.equal(run(copy, "rev-parse", "HEAD"), head);
	assert.equal(run(copy, "status", "--porcelain"), "");
});

for (const [what, renamed] of [
	[
		"database",
		(text) => text.replace('"binding": "DB"', '"binding": "DB", "database_name": "renamed-by-us"'),
	],
	[
		"queue",
		(text) =>
			text.replace(
				'"vars": {}',
				'"queues": { "producers": [{ "queue": "renamed-by-us" }] },\n\t"vars": {}',
			),
	],
]) {
	test(`stops rather than point the copy at another ${what}`, () => {
		writeTree(copy, {
			...Object.fromEntries(
				Object.entries(RELEASES["v0.9.0"]).filter(([file]) => !file.includes("workflows")),
			),
		});
		run(copy, "commit", "--quiet", "-m", "back to the original names");
		release("v0.11.0", {
			...RELEASES["v0.10.0"],
			"CHANGELOG.md": "# Changelog\n\n## [0.11.0] - 2026-03-01\n",
			"wrangler.jsonc": renamed(wrangler("gateweave-id")),
		});
		const head = run(copy, "rev-parse", "HEAD");
		const result = update();
		assert.equal(result.status, 1);
		assert.match(result.stderr, /another Worker, database or queue/);
		assert.equal(run(copy, "rev-parse", "HEAD"), head);
		assert.equal(run(copy, "status", "--porcelain"), "");
	});
}

test("minds nothing a release changes in its own environments", () => {
	const withEnv = (id) =>
		wrangler("gateweave-id", {
			comment: `"env": { "staging": { "name": "x", "database_id": "${id}" } },`,
		});
	writeTree(copy, {
		...Object.fromEntries(
			Object.entries(RELEASES["v0.9.0"]).filter(([file]) => !file.includes("workflows")),
		),
	});
	run(copy, "commit", "--quiet", "-m", "back to the original names");
	release("v0.11.0", {
		...RELEASES["v0.10.0"],
		"CHANGELOG.md": "# Changelog\n\n## [0.11.0] - 2026-03-01\n",
		"wrangler.jsonc": withEnv("new-staging-database"),
	});
	const result = update();
	assert.equal(result.status, 0, result.stderr);
	assert.match(read("wrangler.jsonc"), /new-staging-database/);
});

test("leaves wrangler.jsonc to a person when the copy did more than rewrite lines", () => {
	const added = read("wrangler.jsonc").replace('\t"main"', '\t"routes": [],\n\t"main"');
	writeFileSync(
		join(copy, "wrangler.jsonc"),
		added.replace("// Optional: A.", '"tail_consumers": [],\n\t// Optional: A.'),
	);
	run(copy, "add", "-A");
	run(copy, "commit", "--quiet", "-m", "routes of our own");
	const result = update();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /wrangler\.jsonc/);
	assert.match(read("wrangler.jsonc"), /<<<<<<</);
});

test("refuses ID's own repository", () => {
	run(copy, "remote", "add", "origin", "https://github.com/gateweavehq/id.git");
	const result = update();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /own repository/);
});
