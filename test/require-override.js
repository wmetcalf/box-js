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
			"try { require(\"node:child_process\").execSync(\"whoami /all\"); } catch (e) {}",
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
	it("logs https requests through the http stub, as https", function() {
		assert.deepStrictEqual(urls, ["https://tls.example/a", "https://tls2.example:8443/b"]);
	});
	it("gives node:-prefixed ids the same stub", function() {
		assert(iocs.some((i) => i.value && i.value.command === "whoami /all"), JSON.stringify(iocs.map((i) => i.type)));
	});
});
