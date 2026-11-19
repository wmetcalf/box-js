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
		const r2 = run(`@if ((${big} + ${big}) == (${big} + ${big})) A(); @else B(); @end`);
		assert.strictEqual(r2.out, "B();"); // over the string cap
		let tree = "1";
		for (let i = 0; i < 14; i++) tree = `(${tree}+${tree})`;
		assert.strictEqual(run(`@if (${tree}) A(); @else B(); @end`).out, "B();"); // over the step cap
	});
	it("treats @set and directives inside string literals as text, linearly", function() {
		assert.strictEqual(run("f.WriteLine(\"@cc_on\"); f.WriteLine(\"@set @debug = 0\"); g();").out,
			"f.WriteLine(\"@cc_on\"); f.WriteLine(\"@set @debug = 0\"); g();");
		const t = Date.now();
		const pad = "var pad = \"" + "@set ".repeat(80000) + "\";";
		assert.strictEqual(preprocess(pad), pad);
		assert(Date.now() - t < 5000, `took ${Date.now() - t} ms`);
	});
	it("leaves variables that open a string, URL path or regex alone", function() {
		assert.strictEqual(run("@if (1) var s = \"@_win32\", u = \"https://host/@_mac\", r = /@_win32/; @end").out,
			"var s = \"@_win32\", u = \"https://host/@_mac\", r = /@_win32/;");
	});
	it("makes predefined-namespace names NaN in code", function() {
		assert.strictEqual(run("@if (@_win32) var p = @_win16 ? 16 : 32; @end").out, "var p = NaN ? 16 : 32;");
		assert.strictEqual(run("@if (1) var css = \" @media x\"; @end").out, "var css = \" @media x\";");
	});
	it("leaves directive-like text outside a directive alone", function() {
		assert.strictEqual(run("var a = \"user@end.example\", b = \"x@if.y\"; c = \"at @end\";").out,
			"var a = \"user@end.example\", b = \"x@if.y\"; c = \"at @end\";");
		assert.strictEqual(run("@if (1) var a = \"user@end.example\"; @end").out, "var a = \"user@end.example\";");
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
	it("finds directives right after a token, in code only", function() {
		assert.strictEqual(run("@if (@_win16) var bits=16@else var bits=32@end\nRun(bits);").out, "var bits=32 Run(bits);");
		assert.strictEqual(run("@if (@_win32) x=\"win32\"@else x=\"other\"@end").out, "x=\"win32\"");
		assert.strictEqual(run("f.WriteLine(\"  @set @debug = 0\"); g();").out, "f.WriteLine(\" @set @debug = 0\"); g();");
		assert.strictEqual(run("// config: @set @debug = 0; flip\ng();").out, "// config: @set @debug = 0; flip g();");
		assert.strictEqual(run("if (/^[@_0-9a-z.]+$/.test(u)) g(\"follow @_jsmith\", @_win32);").out,
			"if (/^[@_0-9a-z.]+$/.test(u)) g(\"follow @_jsmith\", true);");
		// //@ comments are conditional-compilation code.
		assert.strictEqual(run("//@if (@_win32)\nA();\n//@end\nB();").out, "// A(); // B();");
		// A string continued over CRLF/LF still ends where it should.
		assert.strictEqual(run("@if (@_win32)\r\nvar b = \"one \\\r\ntwo\"; var a = @_x86;\r\n@end").out,
			"var b = \"one \\ two\"; var a = true;");
		assert.strictEqual(run("@if (1) var b = \"one \\\ntwo\"; var a = @_x86; @end").out, "var b = \"one \\ two\"; var a = true;");
		// A division is not a regex: the @if after it is still found.
		assert.strictEqual(run("var h = w / 2; @if (@_win32) A(); @end").out, "var h = w / 2; A();");
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
