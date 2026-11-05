// Brings a copy of ID made with the Deploy button up to a release of this repository.
//
//   git remote add upstream https://github.com/gateweavehq/id.git   (once)
//   git fetch upstream
//   git show upstream/main:scripts/update-copy.mjs | node --input-type=module
//   git push
//
// Run that way it works from any old copy, even one from before this file existed. It takes the
// latest release; `node --input-type=module - --to v1.2.3` takes that one instead.
//
// A plain `git pull upstream main` cannot do this. The button makes the copy in one new commit,
// with no history in common with this repository, and changes a few files: the names in
// wrangler.jsonc and package.json, and no workflows. So this is a three-way merge from the release
// named in the copy's CHANGELOG.md: what the copy changed stays, what the release changed comes
// in, and the result is one commit on top of the copy. Nothing is pushed.
//
// This file has no shebang and only ASCII: Windows PowerShell starts piped text with a byte order
// mark, which is harmless before a comment and a syntax error before a shebang.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const UPSTREAM_URL = "https://github.com/gateweavehq/id.git";
const OWN_REPOSITORY = /gateweavehq\/id(\.git)?\/?$/;
const RELEASE = /^v\d+\.\d+\.\d+$/;
const WORKFLOWS = ".github/workflows";
// Kept apart from the copy's own tags, which may share these names.
const RELEASES = "refs/id-upstream/tags";

function stop(message) {
	console.error(message);
	process.exit(1);
}

function attempt(...args) {
	const result = spawnSync("git", args, { encoding: "utf8" });
	return { ok: result.status === 0, out: result.stdout.trim(), err: result.stderr.trim() };
}

function git(...args) {
	const result = attempt(...args);
	if (!result.ok) stop(`git ${args[0]} failed: ${result.err}`);
	return result.out;
}

const lines = (text) => (text ? text.split("\n").map((line) => line.trim()) : []);

function compareReleases(a, b) {
	const [x, y] = [a, b].map((tag) => tag.slice(1).split(".").map(Number));
	for (let i = 0; i < 3; i++) {
		if (x[i] !== y[i]) return x[i] - y[i];
	}
	return 0;
}

/** The release a copy is on, from the newest entry of its changelog. */
function currentRelease() {
	const changelog = attempt("show", "HEAD:CHANGELOG.md");
	const match = changelog.ok && /^## \[(\d+\.\d+\.\d+)\]/m.exec(changelog.out);
	if (!match) stop("CHANGELOG.md names no release, so this does not look like a copy of ID.");
	return `v${match[1]}`;
}

/**
 * What says which Worker, database and queue a deploy reaches. A change here would look like lost
 * data. Only the top level: a release's own environments are nothing to a copy.
 */
function identity(wrangler) {
	const [topLevel = ""] = wrangler.split(/"env"\s*:/);
	const named = (key) =>
		[...topLevel.matchAll(new RegExp(`"${key}":\\s*"([^"]*)"`, "g"))].map((found) => found[1]);
	return {
		worker: ["name", "database_id", "database_name"].flatMap(named).join(" "),
		queues: named("queue").join(" "),
	};
}

/** A release may bring a copy its first queue, which the deploy makes. One it has must stay. */
function sameResources(before, after) {
	return before.worker === after.worker && (!before.queues || before.queues === after.queues);
}

/**
 * Puts the lines a copy rewrote onto a newer file, or null when that is not all the copy did or
 * a line it rewrote is no longer there.
 */
function rewriteLines(base, ours, theirs) {
	const [from, to, result] = [base, ours, theirs].map((text) => text.split("\n"));
	if (from.length !== to.length) return null;
	for (let i = 0; i < from.length; i++) {
		if (from[i] === to[i]) continue;
		const at = result.indexOf(from[i]);
		if (at === -1) return null;
		result[at] = to[i];
	}
	return result.join("\n");
}

const root = attempt("rev-parse", "--show-toplevel");
if (!root.ok) stop("Run this inside your copy of ID.");
process.chdir(root.out);

const toIndex = process.argv.indexOf("--to");
const requested = toIndex === -1 ? null : process.argv[toIndex + 1];
if (toIndex !== -1 && !RELEASE.test(requested ?? "")) stop("--to takes a release, such as v1.2.3.");

const origin = attempt("remote", "get-url", "origin");
if (origin.ok && OWN_REPOSITORY.test(origin.out)) {
	stop("This is ID's own repository, not a copy: git pull is all it needs.");
}
if (git("status", "--porcelain", "--untracked-files=no")) {
	stop("You have uncommitted changes. Commit them or put them aside first.");
}

if (!attempt("remote", "get-url", "upstream").ok) git("remote", "add", "upstream", UPSTREAM_URL);
git("fetch", "--quiet", "--no-tags", "upstream", `+refs/tags/*:${RELEASES}/*`);

const releases = lines(git("for-each-ref", "--format=%(refname:lstrip=3)", RELEASES))
	.filter((tag) => RELEASE.test(tag))
	.sort(compareReleases);
const target = requested ?? releases.at(-1);
if (!target || !releases.includes(target)) stop(`Upstream has no release ${target ?? ""}.`.trim());

const current = currentRelease();
if (!releases.includes(current)) stop(`Upstream has no release ${current} to start from.`);
const order = compareReleases(current, target);
if (order === 0) {
	console.log(`Already on ${target}.`);
	process.exit(0);
}
if (order > 0) stop(`This copy is on ${current}, which is newer than ${target}.`);

// Git finds the merge base by itself once the copy's commit seems to descend from its release.
// That stays local and ends with the merge: the commit made below has the copy's real history.
const head = git("rev-parse", "HEAD");
git("replace", "--graft", head, `${RELEASES}/${current}^{commit}`);
attempt("merge", "--squash", `${RELEASES}/${target}`);
git("replace", "--delete", head);

// The button leaves workflows out of a copy, so new and changed ones of ours stay out too. They
// would run our CI on the copy, and pushing them takes a token with the workflow scope.
const kept = new Set(lines(git("ls-tree", "-r", "--name-only", head, "--", WORKFLOWS)));
for (const file of new Set(lines(git("ls-files", "--", WORKFLOWS)))) {
	if (!kept.has(file)) git("rm", "--force", "--quiet", "--", file);
}

// The button rewrites lines of wrangler.jsonc that sit beside lines our releases change, which
// git calls a conflict though nothing really is one. Where the copy only rewrote lines, those go
// onto the release's file.
if (lines(git("diff", "--name-only", "--diff-filter=U")).includes("wrangler.jsonc")) {
	const merged = rewriteLines(
		git("show", `${RELEASES}/${current}:wrangler.jsonc`),
		git("show", `${head}:wrangler.jsonc`),
		git("show", `${RELEASES}/${target}:wrangler.jsonc`),
	);
	if (merged !== null) {
		writeFileSync("wrangler.jsonc", `${merged}\n`);
		git("add", "--", "wrangler.jsonc");
	}
}

const conflicts = lines(git("diff", "--name-only", "--diff-filter=U"));
if (conflicts.length > 0) {
	stop(
		[
			`Updating from ${current} to ${target} left conflicts with what this copy changed:`,
			...conflicts.map((file) => `  ${file}`),
			"",
			"Fix those files, keeping your Worker's, database's and queue's names in wrangler.jsonc, then:",
			"  git add -A",
			`  git commit -m "chore: update ID to ${target}"`,
			"To start over instead: git reset --hard",
		].join("\n"),
	);
}

const before = identity(git("show", `${head}:wrangler.jsonc`));
const after = identity(git("show", ":wrangler.jsonc"));
if (!sameResources(before, after)) {
	git("reset", "--hard", "--quiet");
	stop(
		"The update would point wrangler.jsonc at another Worker, database or queue, so nothing was changed.",
	);
}

git("commit", "--quiet", "-m", `chore: update ID to ${target}`, "-m", `From ${current}.`);
console.log(
	[
		`Updated from ${current} to ${target}, in one commit. Nothing has been pushed.`,
		"",
		"Read CHANGELOG.md for what changed between them, then:",
		"  git push                 Workers Builds deploys it and applies the migrations",
		"To undo before pushing:",
		"  git reset --hard HEAD~1",
	].join("\n"),
);
