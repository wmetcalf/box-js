/* eslint-env mocha */

// The sample must never reach the worker's own process: not `process`, not the host
// `require`, not a module that can (fs, child_process, vm, ...). These run box-js end to
// end on test/fixtures/escape-payloads.js, which tries known vm2 / host-reference escapes
// and, on success, logs http://escaped.example/<name> and drops a marker file next to the
// results dir through the host's real fs.

const assert = require("assert");
const {execFileSync} = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const boxDir = path.join(__dirname, "..");
const payload = fs.readFileSync(path.join(__dirname, "fixtures", "escape-payloads.js"), "utf8");

function runProbe(extraArgs) {
	const work = fs.mkdtempSync(path.join(os.tmpdir(), "boxjs-escape-"));
	const mark = path.join(work, "MARK");
	const sample = path.join(work, "sample.js");
	fs.writeFileSync(sample, payload.split("__MARK__").join(mark));
	try {
		execFileSync(process.execPath, [path.join(boxDir, "run.js"), sample, `--output-dir=${work}`,
			"--no-kill", "--timeout=20", ...extraArgs], {cwd: work, stdio: "ignore", timeout: 90000});
	} catch (e) {
		// box-js exits non-zero for some samples; the outputs are what is checked.
	}
	const results = path.join(work, "sample.js.results");
	let urls = [];
	try {
		urls = JSON.parse(fs.readFileSync(path.join(results, "urls.json"), "utf8"));
	} catch (e) {}
	const marks = fs.readdirSync(work).filter((n) => n.startsWith("MARK"));
	return {urls, marks};
}

for (const [label, args] of [
	["bare sandbox", []],
	["default boilerplate (the engine's mode)", ["--prepended-code=default", "--rewrite-loops", "--activex-as-ioc",
		"--no-shell-error", "--ignore-wscript-quit"]],
]) {
	describe(`sandbox isolation: ${label}`, function() {
		this.timeout(120000);
		let run;
		before(function() {
			run = runProbe(args);
		});
		it("runs every escape attempt to the end", function() {
			assert(run.urls.includes("http://attempted.example/done"),
				"probe did not finish; urls: " + JSON.stringify(run.urls));
		});
		it("reaches no host process, require or capability module", function() {
			const escaped = run.urls.filter((u) => String(u).startsWith("http://escaped.example/"));
			assert.deepStrictEqual(escaped, []);
		});
		it("writes nothing through the host's real fs or child_process", function() {
			assert.deepStrictEqual(run.marks, []);
		});
	});
}
