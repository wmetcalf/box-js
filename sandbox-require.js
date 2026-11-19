// The only `require` the sandbox ever sees.
//
// The sample, box-js's own in-sandbox code (patch.js, boilerplate.js, require_override.js,
// appended-code.js) and anything they eval all share one global scope inside vm2, so
// whatever that code can require, the sample can require too. This used to be the host's
// real `require`: `require("child_process").execFileSync(...)` ran a process in the worker,
// `require("fs")` read and wrote anything the worker could, and `require("vm")` handed out
// runInThisContext, i.e. the host realm itself.
//
// So the sandbox gets a fixed table instead. Each entry is a frozen facade built here, on
// the host, holding only what the in-sandbox code uses and nothing that reaches the
// process, the filesystem, the network or a loader. Host module objects are never handed
// out themselves: vm2 lets the sandbox assign to a host object's properties, so passing
// e.g. the real `path` would let a sample replace `path.win32.join` under the host's own
// emulator code. Unknown ids throw like node's MODULE_NOT_FOUND, which
// require_override.js already turns into a logged empty module.
//
// Process-level isolation (the blastbox worker: one job per disposable VM, network none)
// stays the outer boundary; this is what keeps a sample from crossing into the worker
// process in the first place.

const nodeBuffer = require("buffer");
const nodeCrypto = require("crypto");
const nodePath = require("path");
const nodeUtil = require("util");
const nodeVm = require("vm");
const nodeZlib = require("zlib");
const querystring = require("querystring");
const stringDecoder = require("string_decoder");
const url = require("url");
const htmlParser = require("node-html-parser");
const localTextDecoder = require("./local_text_decoder.js");

// A frozen null-prototype copy of the named members of `source` that exist.
function pick(source, names) {
  const out = Object.create(null);
  for (const name of names) {
    if (source[name] !== undefined) out[name] = source[name];
  }
  return Object.freeze(out);
}

// Every own enumerable non-object member. Nested objects are left out, never copied by
// reference: node's path.posix.posix is the real path module, and a sample may assign to
// the properties of any host object it holds.
function freezeCopy(source) {
  const out = Object.create(null);
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (value === null || typeof value !== "object") out[key] = value;
  }
  return Object.freeze(out);
}

function deepFreezeCopy(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(deepFreezeCopy));
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) out[key] = deepFreezeCopy(value[key]);
    return Object.freeze(out);
  }
  return value;
}

// The lib members in-sandbox code calls. Not argv (the sample could turn on --download),
// not the throttle switches, not kill/doWscriptQuit. Each is a fresh host closure, so the
// sandbox holds no reference to lib or to lib's own function objects.
const LIB_MEMBERS = [
  "debug", "verbose", "info", "warning", "error",
  "fetchUrl", "getUUID", "logIOC", "logJS", "logResource", "logSnippet", "logUrl",
  "logEnvVar", "makeDefaultDict", "noCasePropObj", "runShellCommand", "writeFile",
  // Not readFile: nothing in-sandbox calls it, and the emulated FSO/ADODB reach it host-side.
];

function makeLibFacade(lib) {
  const out = Object.create(null);
  for (const name of LIB_MEMBERS) {
    if (typeof lib[name] !== "function") continue;
    const target = lib[name];
    out[name] = function () {
      return target.apply(lib, arguments);
    };
  }
  return Object.freeze(out);
}

// Syntax check only (appended-code.js); compiling a Script never runs it.
function Script(source) {
  new nodeVm.Script(String(source));
}

function inspect() {
  return nodeUtil.inspect.apply(null, arguments);
}

// Built in the sandbox's own realm by analyze.js (vm.run(PRELUDE)) and handed to
// installPrelude. The real events module is the EventEmitter constructor, which node itself
// reads statics from (EventEmitter.init on every construction, defaultMaxListeners), so a
// sample holding it could run its code in every host emitter and stream; util.inherits
// runs Object.setPrototypeOf in the host realm, where vm2 has turned the sample's Array or
// Error into the host's, so it could re-parent host built-ins. Sandbox-realm versions can
// only ever touch the sandbox.
const PRELUDE = `(function () {
  "use strict";
  function EventEmitter() {
    if (!this._events || this._events === Object.getPrototypeOf(this)._events) {
      this._events = Object.create(null);
    }
    this._maxListeners = this._maxListeners || undefined;
  }
  EventEmitter.EventEmitter = EventEmitter;
  EventEmitter.defaultMaxListeners = 10;
  EventEmitter.prototype._events = undefined;
  EventEmitter.prototype._maxListeners = undefined;
  function list(self, name) {
    if (!self._events) self._events = Object.create(null);
    if (!self._events[name]) self._events[name] = [];
    return self._events[name];
  }
  function add(self, name, fn, prepend) {
    if (typeof fn !== "function") throw new TypeError("The \\"listener\\" argument must be of type function");
    if (self._events && self._events.newListener) self.emit("newListener", name, fn.listener || fn);
    const l = list(self, name);
    if (prepend) l.unshift(fn); else l.push(fn);
    return self;
  }
  function wrapOnce(self, name, fn) {
    const w = function () {
      self.removeListener(name, w);
      return fn.apply(self, arguments);
    };
    w.listener = fn;
    return w;
  }
  const P = EventEmitter.prototype;
  P.on = P.addListener = function (name, fn) { return add(this, name, fn, false); };
  P.prependListener = function (name, fn) { return add(this, name, fn, true); };
  P.once = function (name, fn) { return add(this, name, wrapOnce(this, name, fn), false); };
  P.prependOnceListener = function (name, fn) { return add(this, name, wrapOnce(this, name, fn), true); };
  P.off = P.removeListener = function (name, fn) {
    const l = this._events && this._events[name];
    if (!l) return this;
    for (let i = l.length - 1; i >= 0; i--) {
      if (l[i] === fn || l[i].listener === fn) { l.splice(i, 1); break; }
    }
    if (l.length === 0) delete this._events[name];
    return this;
  };
  P.removeAllListeners = function (name) {
    if (!this._events) return this;
    if (arguments.length === 0) this._events = Object.create(null); else delete this._events[name];
    return this;
  };
  P.emit = function (name) {
    const l = this._events && this._events[name];
    const args = Array.prototype.slice.call(arguments, 1);
    if (!l || l.length === 0) {
      if (name === "error") throw (args[0] instanceof Error ? args[0] : new Error("Unhandled error. (" + args[0] + ")"));
      return false;
    }
    for (const fn of l.slice()) fn.apply(this, args);
    return true;
  };
  P.listeners = function (name) {
    return ((this._events && this._events[name]) || []).map(function (f) { return f.listener || f; });
  };
  P.rawListeners = function (name) { return ((this._events && this._events[name]) || []).slice(); };
  P.listenerCount = function (name) { return ((this._events && this._events[name]) || []).length; };
  P.eventNames = function () { return this._events ? Object.keys(this._events) : []; };
  P.setMaxListeners = function (n) { this._maxListeners = n; return this; };
  P.getMaxListeners = function () {
    return this._maxListeners === undefined ? EventEmitter.defaultMaxListeners : this._maxListeners;
  };
  EventEmitter.once = function (emitter, name) {
    return new Promise(function (resolve, reject) {
      emitter.once(name, function () { resolve(Array.prototype.slice.call(arguments)); });
      if (name !== "error") emitter.once("error", reject);
    });
  };
  EventEmitter.listenerCount = function (emitter, name) { return emitter.listenerCount(name); };
  function inherits(ctor, superCtor) {
    if (typeof ctor !== "function") throw new TypeError("The \\"ctor\\" argument must be of type function");
    if (typeof superCtor !== "function" || superCtor.prototype === undefined) {
      throw new TypeError("The \\"superCtor.prototype\\" property must be of type object");
    }
    Object.defineProperty(ctor, "super_", {value: superCtor, writable: true, configurable: true});
    Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
  }
  return {EventEmitter: EventEmitter, inherits: inherits};
})()`;

// zlib is pure computation, and Node droppers inflate their next stage with it. Only the
// synchronous calls, with numeric options only, an output cap, and the result copied into
// a fresh unpooled Buffer: a pooled one shares its ArrayBuffer (buf.buffer) with other
// host data.
const ZLIB_MAX_OUTPUT = 64 * 1024 * 1024;
const ZLIB_OPTIONS = ["level", "windowBits", "memLevel", "strategy", "chunkSize", "flush", "finishFlush"];
const ZLIB_SYNC = ["deflateSync", "deflateRawSync", "gzipSync", "inflateSync", "inflateRawSync",
  "gunzipSync", "unzipSync", "brotliCompressSync", "brotliDecompressSync"];

function makeZlib() {
  const out = Object.create(null);
  for (const name of ZLIB_SYNC) {
    if (typeof nodeZlib[name] !== "function") continue;
    out[name] = function (input, options) {
      const opts = {maxOutputLength: ZLIB_MAX_OUTPUT};
      if (options && typeof options === "object") {
        for (const key of ZLIB_OPTIONS) {
          if (typeof options[key] === "number") opts[key] = options[key];
        }
      }
      const data = typeof input === "string" ? String(input) : nodeBuffer.Buffer.from(input);
      const result = nodeZlib[name](data, opts);
      const copy = nodeBuffer.Buffer.alloc(result.length);
      result.copy(copy);
      return copy;
    };
  }
  out.constants = freezeCopy(nodeZlib.constants);
  return Object.freeze(out);
}

const CRYPTO_MEMBERS = [
  "createCipheriv", "createDecipheriv", "createDiffieHellman", "createECDH",
  "createHash", "createHmac", "createPrivateKey", "createPublicKey", "createSecretKey",
  "createSign", "createVerify", "generateKeyPair", "generateKeyPairSync", "getCiphers",
  "getCurves", "getDiffieHellman", "getHashes", "getRandomValues", "hash", "hkdf", "hkdfSync",
  "pbkdf2", "pbkdf2Sync", "privateDecrypt", "privateEncrypt", "publicDecrypt", "publicEncrypt",
  "randomBytes", "randomFill", "randomFillSync", "randomInt", "randomUUID", "scrypt",
  "scryptSync", "sign", "timingSafeEqual", "verify",
  // Not setEngine: it loads an OpenSSL engine, i.e. a shared object, by path.
];

// node's webcrypto object is also the host's globalThis.crypto, and its methods live on the
// prototype, so a sample assigning an own property to it would shadow them for the host.
// Hand out wrappers bound to the real objects instead.
function bindAll(target, names) {
  const out = Object.create(null);
  for (const name of names) {
    if (typeof target[name] === "function") {
      out[name] = function () {
        return target[name].apply(target, arguments);
      };
    }
  }
  return out;
}

function makeWebcrypto() {
  const wc = nodeCrypto.webcrypto;
  const subtle = Object.freeze(bindAll(wc.subtle, [
    "decrypt", "deriveBits", "deriveKey", "digest", "encrypt", "exportKey", "generateKey",
    "importKey", "sign", "unwrapKey", "verify", "wrapKey",
  ]));
  return Object.freeze(Object.assign(bindAll(wc, ["getRandomValues", "randomUUID"]), {subtle}));
}

function buildModules(lib, argv) {
  const buffer = Object.freeze(Object.assign(Object.create(null),
    pick(nodeBuffer, ["Buffer", "kMaxLength", "atob", "btoa"]),
    {constants: freezeCopy(nodeBuffer.constants)}));
  const webcrypto = makeWebcrypto();
  const crypto = Object.freeze(Object.assign(Object.create(null), pick(nodeCrypto, CRYPTO_MEMBERS), {
    constants: freezeCopy(nodeCrypto.constants),
    subtle: webcrypto.subtle,
    webcrypto,
  }));
  const util = makeUtil(undefined);
  // posix/win32 (and their own posix/win32 self-references) point at these facades only.
  const posix = Object.assign(Object.create(null), freezeCopy(nodePath.posix));
  const win32 = Object.assign(Object.create(null), freezeCopy(nodePath.win32));
  for (const p of [posix, win32]) Object.assign(p, {posix, win32});
  Object.freeze(posix);
  Object.freeze(win32);
  const path = nodePath === nodePath.win32 ? win32 : posix;
  const table = {
    // box-js's own files, as boilerplate.js and patch.js require them.
    "./lib.js": makeLibFacade(lib),
    "./argv.js": Object.freeze({run: deepFreezeCopy(argv)}),
    "./local_text_decoder.js": pick(localTextDecoder, ["decode"]),
    "node-html-parser": pick(htmlParser, ["parse"]),
    // Pure-computation node modules.
    buffer,
    crypto,
    // events is filled in by installPrelude.
    path,
    querystring: freezeCopy(querystring, 0),
    string_decoder: pick(stringDecoder, ["StringDecoder"]),
    url: pick(url, ["URL", "URLSearchParams", "parse", "format", "resolve"]),
    util,
    vm: Object.freeze(Object.assign(Object.create(null), {Script})),
    zlib: makeZlib(),
  };
  table["./lib"] = table["./lib.js"];
  table["./argv"] = table["./argv.js"];
  table["./local_text_decoder"] = table["./local_text_decoder.js"];
  return table;
}

function makeUtil(inherits) {
  const util = Object.assign(Object.create(null), {
    TextDecoder: nodeUtil.TextDecoder,
    TextEncoder: nodeUtil.TextEncoder,
    callbackify: nodeUtil.callbackify,
    format: nodeUtil.format,
    inspect,
    isDeepStrictEqual: nodeUtil.isDeepStrictEqual,
    promisify: nodeUtil.promisify,
    types: freezeCopy(nodeUtil.types),
  });
  if (inherits) util.inherits = inherits;
  return Object.freeze(util);
}

const NODE_PREFIXED = ["buffer", "crypto", "events", "path", "querystring", "string_decoder", "url",
  "util", "vm", "zlib"];

// The sandbox gets `require`; analyze.js keeps installPrelude, and calls it with
// vm.run(PRELUDE) from each VM before the sample runs.
function makeSandboxRequire(lib, argv) {
  const modules = buildModules(lib, argv);
  function lookup(id) {
    if (id.startsWith("node:") && NODE_PREFIXED.includes(id.slice(5))) id = id.slice(5);
    return Object.prototype.hasOwnProperty.call(modules, id) ? modules[id] : undefined;
  }
  return {
    require: function require(id) {
      id = String(id);
      const found = lookup(id);
      if (found !== undefined) return found;
      const err = new Error(`Cannot find module '${id}' (not available inside the box-js sandbox)`);
      err.code = "MODULE_NOT_FOUND";
      throw err;
    },
    installPrelude(prelude) {
      modules.events = prelude.EventEmitter;
      modules.util = makeUtil(prelude.inherits);
    },
  };
}

module.exports = {makeSandboxRequire, makeLibFacade, LIB_MEMBERS, PRELUDE};
