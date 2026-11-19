// Prefixed with escape-helpers.js by test/sandbox-escape.js. Kept apart from
// escape-payloads.js, whose walks call every global with odd arguments and can leave
// handlers behind that derail the string timers below.
attempt("string-timers", function () {
  // A string handler must run in the sandbox, not through the host's own eval.
  // (boilerplate.js defines its own fake `process`; useProc/useReq test for the real ones.)
  var probe = "url('http://attempted.example/ran-STR');" +
    "useProc('STR', typeof process !== 'undefined' ? process : undefined);" +
    "useReq('STR-require', typeof require !== 'undefined' ? require : undefined);";
  try { globalThis.setInterval(probe.split("STR").join("setInterval-global"), 0); } catch (e) {}
  try { setInterval(probe.split("STR").join("setInterval"), 0); } catch (e) {}
  try { globalThis.setTimeout(probe.split("STR").join("setTimeout-global"), 0); } catch (e) {}
  try { document.getElementById("x").addEventListener("click", probe.split("STR").join("listener")); } catch (e) {}
});
attempt("cc_on-preprocessors", function () {
  // Conditional-compilation (cc_on / if) source goes through m4 and cpp on the host; built at runtime so this file
  // itself is not preprocessed. __MARK__.leak.js (written by the test) calls hit().
  var A = String.fromCharCode(64), H = String.fromCharCode(35);
  var leak = MARK + ".leak.js";
  var bodies = {
    "m4-syscmd": "syscmd(: > '" + MARK + ".m4-syscmd')",
    "m4-prefixed-syscmd": "m4_syscmd(: > '" + MARK + ".m4-prefixed-syscmd')",
    "m4-esyscmd": "esyscmd(: > '" + MARK + ".m4-esyscmd')",
    "m4-include": "include(" + leak + ")",
    "cpp-include": "\n" + H + "include \"" + leak + "\"\n",
    "cpp-include-indented": "\n \t" + H + "include \"" + leak + "\"\n",
    "cpp-include-digraph": "\n%:include \"" + leak + "\"\n",
  };
  Object.keys(bodies).forEach(function (k) {
    // An escaped "#include" is not JS, so the eval may throw; that is the blocked outcome.
    url("http://attempted.example/cc-" + k);
    var src = "var cc = 1; // " + A + "cc_on " + A + "if (1) " + bodies[k] + "\n";
    try { eval(src); } catch (e) {}
  });
});
url("http://attempted.example/done");
