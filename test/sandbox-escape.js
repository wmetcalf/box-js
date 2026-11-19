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

function runProbe(probe, extraArgs) {
	const work = fs.mkdtempSync(path.join(os.tmpdir(), "boxjs-escape-"));
	const mark = path.join(work, "MARK");
	const sample = path.join(work, "sample.js");
	fs.writeFileSync(sample, (helpers + "\n" + fixture(probe)).split("__MARK__").join(mark));
	// Read only if a preprocessor include escapes; reports itself through the sample's hit().
	fs.writeFileSync(`${mark}.leak.js`, "\nhit(\"preprocessor-include\");\n");
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
	return {urls, marks};
}

const MODES = [
	["bare sandbox", [], ["setInterval-global", "setInterval", "setTimeout-global", "listener"]],
	// boilerplate.js shadows the bare setInterval and document; the global ones still reach
	// analyze.js's handlers.
	["default boilerplate (the engine's mode)", ["--prepended-code=default", "--rewrite-loops",
		"--activex-as-ioc", "--no-shell-error", "--ignore-wscript-quit"], ["setInterval-global", "setTimeout-global"]],
];
const CC_ON = ["m4-syscmd", "m4-prefixed-syscmd", "m4-esyscmd", "m4-include", "cpp-include",
	"cpp-include-indented", "cpp-include-digraph"];

for (const [label, args, handlers] of MODES) {
	for (const probe of ["escape-payloads.js", "escape-strings.js"]) {
		describe(`sandbox isolation: ${probe}, ${label}`, function() {
			this.timeout(120000);
			let run;
			before(function() {
				run = runProbe(probe, args);
			});
			it("runs every escape attempt to the end", function() {
				const want = ["done"];
				if (probe === "escape-strings.js") {
					want.push(...handlers.map((h) => "ran-" + h), ...CC_ON.map((c) => "cc-" + c));
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
		});
	}
}
