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
		const body = "var s = \"#include </etc/passwd> %:include ??= m4_syscmd(x) \\\n\"; /* c */ `q'`\n";
		assert.strictEqual(preprocess(`@if (1)${body}@end`).replace(/^\n|\n$/g, ""), body);
	});
	it("leaves string literals alone", function() {
		assert.strictEqual(run("var note = \"@set probe\"; var answer = 42;").out, "var note = \"@set probe\"; var answer = 42;");
		assert.strictEqual(run("@if (1) var d = \"user@_win32.example\"; f(@_win32); @end").out,
			"var d = \"user@_win32.example\"; f(true);");
		// A quote in a regex does not hide directives (they are found as text, as before)
		// and the branch is still taken.
		assert.strictEqual(run("q = q.replace(/'/g, \"\"); @if (@_win32) A(@_win32); @end\nB(@_win32);").out,
			"q = q.replace(/'/g, \"\"); A(true); B(true);");
		// A quote in a // comment only affects its own line.
		assert.strictEqual(run("// don't\n@if (0) A(); @else B(); @end").out, "// don't B();");
	});
	it("treats undefined variables as NaN, as JScript does", function() {
		assert.strictEqual(run("@if (@nope != @nope) A(); @else B(); @end").out, "A();");
		assert.strictEqual(run("@if (@_win16) A(); @else B(); @end").out, "B();");
	});
	it("keeps @set to numbers and booleans and bounds strings", function() {
		const r = run("@set @a = \"x\"\n@if (@a == \"x\") A(); @else B(); @end");
		assert.strictEqual(r.out, "B();");
		assert.strictEqual(r.warnings.length, 1);
		const big = "\"" + "y".repeat(3000) + "\"";
		const r2 = run(`@if ((${big} + ${big}).length) A(); @else B(); @end`);
		assert.strictEqual(r2.out, "B();");
		const huge = "@if (" + Array(20000).fill("1").join("+") + ") A(); @else B(); @end";
		assert.strictEqual(run(huge).out, "B();"); // over the step cap
	});
	it("substitutes after a quote inside a regex", function() {
		assert.strictEqual(run("@if (1) var r = /\"/; WScript.Echo(@_win32); @end").out, "var r = /\"/; WScript.Echo(true);");
	});
	it("is linear in the nesting depth", function() {
		const n = 80000;
		const t = Date.now();
		const r = run("@if (1) ".repeat(n) + "A();" + " @end".repeat(n));
		assert.strictEqual(r.out, "A();");
		assert(Date.now() - t < 5000, `took ${Date.now() - t} ms`);
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
