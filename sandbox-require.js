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
const events = require("events");
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

// Every own enumerable member, nested plain objects copied the same way (to `depth`).
function freezeCopy(source, depth = 2) {
  const out = Object.create(null);
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (value && typeof value === "object" && depth > 0) {
      out[key] = value === source ? out : freezeCopy(value, depth - 1);
    } else {
      out[key] = value;
    }
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
  "logEnvVar", "makeDefaultDict", "noCasePropObj", "readFile", "runShellCommand", "writeFile",
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
    {constants: freezeCopy(nodeBuffer.constants, 0)}));
  const webcrypto = makeWebcrypto();
  const crypto = Object.freeze(Object.assign(Object.create(null), pick(nodeCrypto, CRYPTO_MEMBERS), {
    constants: freezeCopy(nodeCrypto.constants, 0),
    subtle: webcrypto.subtle,
    webcrypto,
  }));
  const util = Object.freeze(Object.assign(Object.create(null), {
    TextDecoder: nodeUtil.TextDecoder,
    TextEncoder: nodeUtil.TextEncoder,
    callbackify: nodeUtil.callbackify,
    format: nodeUtil.format,
    inherits: nodeUtil.inherits,
    inspect,
    isDeepStrictEqual: nodeUtil.isDeepStrictEqual,
    promisify: nodeUtil.promisify,
    types: freezeCopy(nodeUtil.types, 0),
  }));
  const path = Object.freeze(Object.assign(Object.create(null), freezeCopy(nodePath, 0), {
    posix: freezeCopy(nodePath.posix, 0),
    win32: freezeCopy(nodePath.win32, 0),
  }));
  const table = {
    // box-js's own files, as boilerplate.js and patch.js require them.
    "./lib.js": makeLibFacade(lib),
    "./argv.js": Object.freeze({run: deepFreezeCopy(argv)}),
    "./local_text_decoder.js": pick(localTextDecoder, ["decode"]),
    "node-html-parser": pick(htmlParser, ["parse"]),
    // Pure-computation node modules.
    buffer,
    crypto,
    events: pick(events, ["EventEmitter", "once"]),
    path,
    querystring: freezeCopy(querystring, 0),
    string_decoder: pick(stringDecoder, ["StringDecoder"]),
    url: pick(url, ["URL", "URLSearchParams", "parse", "format", "resolve"]),
    util,
    vm: Object.freeze(Object.assign(Object.create(null), {Script})),
  };
  table["./lib"] = table["./lib.js"];
  table["./argv"] = table["./argv.js"];
  table["./local_text_decoder"] = table["./local_text_decoder.js"];
  for (const name of Object.keys(table)) {
    if (!name.startsWith(".") && !name.includes("-")) table["node:" + name] = table[name];
  }
  return table;
}

function makeSandboxRequire(lib, argv) {
  const modules = buildModules(lib, argv);
  return function require(id) {
    id = String(id);
    if (Object.prototype.hasOwnProperty.call(modules, id)) return modules[id];
    const err = new Error(`Cannot find module '${id}' (not available inside the box-js sandbox)`);
    err.code = "MODULE_NOT_FOUND";
    throw err;
  };
}

module.exports = {makeSandboxRequire, makeLibFacade, LIB_MEMBERS};
