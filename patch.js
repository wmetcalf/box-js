/* !!!! Patches from box-js !!!! */
const argv = require("./argv.js").run;
let __PATCH_CODE_ADDED__ = true;
// Initialize window object with necessary methods
window = this;
if (!window.addEventListener) {
  window.addEventListener = function (event, callback, useCapture) {
    // Extract callback function source for analysis
    var callbackSource = "";
    if (typeof callback === "function") {
      callbackSource = callback.toString();
    } else if (typeof callback === "string") {
      callbackSource = callback;
    }

    // Log detailed event listener information
    console.log("[ANALYSIS] window.addEventListener called:");
    console.log("  Event: " + event);
    console.log("  Callback type: " + typeof callback);
    console.log("  Use capture: " + useCapture);
    if (callbackSource.length > 0) {
      console.log("  Callback source: " + callbackSource);
    }

    // Store the callback for analysis through box-js emulation pipeline
    if (typeof window._eventListeners === "undefined") {
      window._eventListeners = {};
    }
    if (!window._eventListeners[event]) {
      window._eventListeners[event] = [];
    }
    window._eventListeners[event].push({
      callback: callback,
      source: callbackSource,
      useCapture: useCapture,
    });

    // Add callback to box-js's listenerCallbacks array for full emulation analysis
    if (typeof listenerCallbacks === "undefined") {
      listenerCallbacks = [];
    }

    console.log(
      "[ANALYSIS] Adding " + event + " event listener to emulation pipeline"
    );
    listenerCallbacks.push(callback);

    // For critical events like 'load', also execute immediately to capture early behavior
    if (event === "load" || event === "DOMContentLoaded") {
      console.log(
        "[ANALYSIS] Executing " +
          event +
          " event listener immediately for early analysis"
      );
      try {
        if (typeof callback === "function") {
          callback();
        } else if (typeof callback === "string") {
          eval(callback);
        }
      } catch (e) {
        console.log(
          "[ANALYSIS] Error executing " + event + " callback: " + e.message
        );
      }
    }
  };
}
if (!window.removeEventListener) {
  window.removeEventListener = function (event, callback, useCapture) {
    console.log(
      "[ANALYSIS] window.removeEventListener called for event: " + event
    );
  };
}

_globalTimeOffset = 0;
_sleepCount = 0;
WScript.sleep = function (delay) {
  _globalTimeOffset += delay;
  _sleepCount++;
};

let fullYearGetter = Date.prototype.getFullYear;
Date.prototype.getFullYear = function () {
  console.log("Warning: the script tried to read the current date.");
  console.log("If it doesn't work correctly (eg. fails to decrypt a string,");
  console.log("try editing patch.js with a different year.");

  // return 2017;
  return fullYearGetter.call(this);
};
Date.prototype.getYear = function () {
  return this.getFullYear();
};
Date.prototype.toString = function () {
  // Example format: Thu Aug 24 18:17:18 UTC+0200 2017
  const dayName = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][
    this.getDay()
  ];
  const monName = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ][this.getMonth()];
  return [
    dayName,
    monName,
    this.getUTCDay(),
    this.getUTCHours() +
      ":" +
      this.getUTCMinutes() +
      ":" +
      this.getUTCSeconds(),
    "UTC-0500", // New York timezone
    this.getFullYear(),
  ].join(" ");
};
let toLocaleStringGetter = Date.prototype.toLocaleString;
Date.prototype.toLocaleString = function (lang, opts) {
  try {
    // Try doing the real toLocaleDateString() with the given args.
    return toLocaleStringGetter.call(this, lang, opts);
  } catch (e) {
    // Invalid args. cscript defaults to some sensible options in
    // this case, so return that result.
    const sensibleOpts = {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    };
    return toLocaleStringGetter
      .call(this, undefined, sensibleOpts)
      .replace(" at ", " ");
  }
};
Date.prototype.gethours = Date.prototype.getHours;
Date.prototype.getminutes = Date.prototype.getMinutes;

const legacyDate = Date;
Date = function () {
  // Use a fixed old date for the current date if the --use-old-date
  // command line option is used.
  if (argv["use-old-date"] && (arguments.length == 0)) {
    arguments = [2017, 3, 6];
  }
  var proxiedDate = new legacyDate(...arguments);
  return new Proxy(
    {
      _actualTime: proxiedDate,
    },
    {
      get: (target, prop) => {
        // Fast forward through time to foil anti-sandboxing busy
        // loops. The _myOffset field caches the faked time offset
        // used when the Date object was 1st looked at and
        // advances if so future date objects jump forward in
        // time.
        if (typeof target._myOffset == "undefined") {
          target._myOffset = _globalTimeOffset;
          _globalTimeOffset += 100;
        }
        const modifiedDate = new legacyDate(
          target._actualTime.getTime() + target._myOffset
        );
        if (prop === Symbol.toPrimitive)
          return (hint) => {
            switch (hint) {
              case "string":
              case "default": {
                return modifiedDate.toString();
              }
              case "number": {
                return modifiedDate.getTime();
              }
              default:
                throw new Error("Unknown hint!");
            }
          };
        if (typeof prop !== "symbol") {
          if (!(prop in modifiedDate) && prop in legacyDate)
            return legacyDate[prop];
          if (!(prop in legacyDate.prototype)) return undefined;
        }
        if (typeof modifiedDate[prop] === "undefined") return undefined;
        const boundFn = modifiedDate[prop].bind(modifiedDate);
        return function () {
          const ret = boundFn.apply(null, arguments);
          target._actualTime = new legacyDate(
            modifiedDate.getTime() - _globalTimeOffset
          );
          return ret;
        };
      },
    }
  );
};
Date.now = () => legacyDate.now() + _globalTimeOffset;
Date.length = 7;
Date.parse = legacyDate.parse;
Date.UTC = legacyDate.UTC;
Date.toString = () => legacyDate.toString();
Date.valueOf = () => legacyDate.valueOf();

Array.prototype.Count = function () {
  return this.length;
};

let _OriginalFnToString = Function.prototype.toString;
Function.prototype.toString = function () {
  /**
   * WSH's toString() looks a bit different for built-in functions
   * than result generated by Node.js (tabbed and wrapped with newlines)
   * which is sometimes checked by malicious scripts.
   */
  let source = _OriginalFnToString.call(this);
  let r = source.replace(
    /^function (\S+) { \[native code\] }$/,
    (m, fnName) => `\nfunction ${fnName} {\n    [native code]\n}\n`
  );
  // Some obfuscators flag funcs with newlines.
  r = r.replace(/\n/g, "").replace(/{ +/g, "{").replace(/ +}/g, "}");
  return r;
};

// Handle dynamic code executed via c("...") where c = SomeFunc.constructor.
let _OriginalFnConstructor = Function.prototype.constructor;
function _CreateFunc(...args) {
  let originalSource = args.pop();
  let source;
  if (typeof originalSource === "function") {
    originalSource = originalSource.toString();
    source = rewrite("(" + originalSource + ")");
  } else if (typeof originalSource === "string") {
    // Sheesh. Looks like in a browser you can obfuscate a
    // function call like `(function
    // def...)..constructor("debugger").call("action")`, all this
    // does is call the defined function.
    //
    // Look for that case here.
    if (originalSource === "debugger") {
      var r = {};
      r._func = this;
      r.call = function (cmd) {
        // Call the original function?
        if (cmd === "action") return this._func();
      };
      return r;
    }
    source =
      `/* Function arguments: ${JSON.stringify(args)} */\n` +
      rewrite(originalSource);
  } else {
    // What the fuck JS
    // For some reason, IIFEs result in a call to Function.
    //return new _OriginalFunction(...args, source);
    return new _OriginalFnConstructor(...args, source);
  }
  logJS(source);
  //return new _OriginalFunction(...args, source);
  return new _OriginalFnConstructor(...args, source);
}

Function.prototype.constructor = _CreateFunc;

// Handle dynamic code executed via Function("...").
let _OriginalFunction = Function;
Function = _CreateFunc;
Function.toString = () => _OriginalFunction.toString();
Function.valueOf = () => _OriginalFunction.valueOf();

if (typeof String !== 'undefined' && String.prototype) {
  String.prototype.xstrx = function () {
    const hex = this.valueOf();
    var str = "";
    for (let i = 0; i < hex.length; i += 2) {
      const hexValue = hex.substr(i, 2);
      const decimalValue = parseInt(hexValue, 16);
      str += String.fromCharCode(decimalValue);
    }
    return str;
  };
}

// Track the values of elements set by JQuery $("#q").val(...) uses.
var jqueryVals = {};

// Fake up JQuery $("#q").val(...) uses.
if (typeof String !== 'undefined' && String.prototype) {
  String.prototype.val = function (value) {
    if (!this.startsWith("#")) return;
    logIOC(
      "JQuery",
      value,
      'The script used JQuery $("#q").val(...) to set an element.'
    );
    var name = this.slice(1);
    jqueryVals[name] = value;
  };

  // Fake up JQuery $("#q").fadeIn(...) uses.
  String.prototype.fadeIn = function () {};
}

if (typeof Object !== 'undefined' && Object.prototype) {
  Object.prototype.replace = function () {
    return "";
  };
}

constructor.prototype.bind = function (context, func) {
  const r = function () {
    if (typeof func !== "undefined") {
      return func.apply(context, arguments);
    }
  };
  return r;
};

// Fake version of require() to fake importing some packages.
/*
let _origRequire = require;
console.log(_origRequire);
const require = function(pname) {
    if (pname == "requests") return fakeRequests;
    return _origRequire(pname);
}
*/

/* End patches */
