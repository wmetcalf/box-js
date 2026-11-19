/* eslint-env mocha */

// The sample must never reach the worker's own process: not `process`, not the host
// `require`, not a module that can (fs, child_process, vm, ...), not a host eval, not the
// m4/cpp that @cc_on/@if source is piped through. These run box-js end to end on probes
// under test/fixtures/ (escape-helpers.js prefixed to each) that try known vm2 /
// host-reference escapes and, on success, log http://escaped.example/<name> and drop a
// marker file next to the results dir through the host's real fs.

const assert = require("assert");
const {execFileSync} = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const boxDir = path.join(__dirname, "..");
const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
const helpers = fixture("escape-helpers.js");

// The @cc_on/@if payloads in escape-strings.js only reach m4 and cpp when both are
// installed; without them box-js skips the rewrite and those payloads prove nothing. Say
// so instead of passing (and fail under CI, which must have them).
function has(bin) {
	try {
		execFileSync("sh", ["-c", `command -v ${bin}`], {stdio: "ignore"});
		return true;
	} catch (e) {
		return false;
	}
}
const ccToolchain = has("m4") && has("cc");

function runProbe(probe, extraArgs) {
	const work = fs.mkdtempSync(path.join(os.tmpdir(), "boxjs-escape-"));
	const mark = path.join(work, "MARK");
	const sample = path.join(work, "sample.js");
	fs.writeFileSync(sample, (helpers + "\n" + fixture(probe)).split("__MARK__").join(mark));
	// A real host file the sample must never read back (via a preprocessor include, lib,
	// the emulated FSO/ADODB or the <a download> handler). Run, it reports itself.
	fs.writeFileSync(`${mark}.leak.js`, "\nhit(\"host-file-" + "read\");\n");
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
	const marks = fs.readdirSync(work).filter((n) => n.startsWith("MARK") && n !== "MARK.leak.js");
	let leaked = [];
	try {
		leaked = fs.readdirSync(results).filter((n) =>
			fs.readFileSync(path.join(results, n), "latin1").includes("host-file-" + "read"));
	} catch (e) {}
	return {work, urls, marks, leaked};
}

const MODES = [
	["bare sandbox", [], ["setInterval-global", "setInterval", "setTimeout-global", "listener"]],
	// boilerplate.js shadows the bare setInterval and document; the global ones still reach
	// analyze.js's handlers.
	["default boilerplate (the engine's mode)", ["--prepended-code=default", "--rewrite-loops",
		"--activex-as-ioc", "--no-shell-error", "--ignore-wscript-quit"], ["setInterval-global", "setTimeout-global"]],
	// The <a download> handler only saves with --fake-download.
	["default boilerplate, --fake-download", ["--prepended-code=default", "--no-shell-error",
		"--ignore-wscript-quit", "--fake-download"], ["setInterval-global", "setTimeout-global"]],
];
const CC_ON = ["m4-syscmd", "m4-prefixed-syscmd", "m4-esyscmd", "m4-include", "cpp-include",
	"cpp-include-indented", "cpp-include-digraph", "cpp-include-splice", "cpp-include-splice-crlf",
	"cpp-include-splice-space", "cpp-include-trigraph"];

for (const [label, args, handlers] of MODES) {
	for (const probe of ["escape-payloads.js", "escape-strings.js", "escape-capabilities.js"]) {
		describe(`sandbox isolation: ${probe}, ${label}`, function() {
			this.timeout(120000);
			let run;
			before(function() {
				run = runProbe(probe, args);
			});
			after(function() {
				if (run) fs.rmSync(run.work, {recursive: true, force: true});
			});
			if (probe === "escape-strings.js") {
				it("has m4 and cc, so the @cc_on payloads reach them", function() {
					if (ccToolchain) return;
					if (process.env.CI) assert.fail("m4 and cc are required for the @cc_on escape payloads");
					this.skip();
				});
			}
			it("runs every escape attempt to the end", function() {
				const want = ["done"];
				if (probe === "escape-strings.js") {
					want.push(...handlers.map((h) => "ran-" + h));
					if (ccToolchain) want.push(...CC_ON.map((c) => "cc-" + c));
				}
				if (probe === "escape-capabilities.js") {
					want.push("events-work", "events-statics", "zlib-works", "zlib-callback-works", "after-splice", "after-json");
				}
				for (const w of want) {
					assert(run.urls.includes("http://attempted.example/" + w),
						`probe step ${w} did not run; urls: ` + JSON.stringify(run.urls));
				}
			});
			it("reaches no host process, require or capability module", function() {
				const escaped = run.urls.filter((u) => String(u).startsWith("http://escaped.example/"));
				assert.deepStrictEqual(escaped, []);
			});
			it("writes nothing through the host's real fs or child_process", function() {
				assert.deepStrictEqual(run.marks, []);
			});
			it("reads no host file into the results", function() {
				assert.deepStrictEqual(run.leaked, []);
			});
		});
	}
}
