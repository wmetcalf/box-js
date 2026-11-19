/* eslint-env mocha */

// cc_on.js evaluates JScript conditional compilation in JS; these pin its semantics.

const assert = require("assert");
const child_process = require("child_process");
const {preprocess} = require("../cc_on");

const run = (src) => {
	const warnings = [];
	const out = preprocess(src, (w) => warnings.push(w));
	return {out: out.replace(/\s+/g, " ").trim(), warnings};
};

describe("conditional compilation (cc_on.js)", function() {
	it("takes the branch a float @_jscript_version test selects", function() {
		assert.strictEqual(run("@if (@_jscript_version >= 5.5) A(); @else B(); @end").out, "A();");
		assert.strictEqual(run("@if (@_jscript_version < 5) A(); @else B(); @end").out, "B();");
	});
	it("handles @elif, nesting and @set", function() {
		assert.strictEqual(run("@if (@_win16) A(); @elif (@_win32) B(); @else C(); @end").out, "B();");
		assert.strictEqual(run("@if (1) X(); @if (0) Y(); @else Z(); @end W(); @end").out, "X(); Z(); W();");
		assert.strictEqual(run("@if (0) @if (1) Y(); @end @else Z(); @end").out, "Z();");
		assert.strictEqual(run("@set @v = 2 * 3\n@if (@v == 6) A(@v); @end").out, "A(6);");
	});
	it("substitutes known @variables in code and leaves unknown ones", function() {
		assert.strictEqual(run("@if (1) f(@_jscript, @nope); @end").out, "f(true, @nope);");
	});
	it("takes an unevaluable condition as false and says so", function() {
		for (const c of ["__has_include(\"/etc/passwd\")", "__has\\u005finclude(\"/etc/passwd\")",
			"require('fs')", "(function(){})()", "x = 1", "this"]) {
			const r = run(`@if (${c}) A(); @else B(); @end`);
			assert.strictEqual(r.out, "B();", c);
			assert.strictEqual(r.warnings.length, 1, c);
		}
	});
	it("leaves the text of the taken branch untouched", function() {
		const body = "var s = \"#include </etc/passwd> %:include ??= m4_syscmd(x) \\\n\"; /* c */ `q'";
		assert.strictEqual(preprocess(`@if (1)${body}@end`).replace(/^\n|\n$/g, ""), body);
	});
	it("starts no process", function() {
		const names = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"];
		const saved = names.map((n) => child_process[n]);
		names.forEach((n) => {
			child_process[n] = () => {
				throw new Error("started a process");
			};
		});
		try {
			run("@if (@_jscript) A(); @elif (1) B(); @else C(); @end @set @x = 1");
		} finally {
			names.forEach((n, i) => {
				child_process[n] = saved[i];
			});
		}
	});
});
