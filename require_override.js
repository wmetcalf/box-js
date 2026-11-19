// Use stubbed box-js packages in some cases. Stubbed packages are
// defined in boilerplate.js.
function require(arg) {
    // "node:fs" is "fs": look the stub up without the prefix.
    if (typeof arg === "string" && arg.startsWith("node:")) arg = arg.slice(5);
    
    // Override some Node packages with stubbed box-js versions. Add
    // any new stubbed packages here so they are loaded via require()
    // when sandboxing with box-js.
    const overrides = {
	"child_process" : {
	    execSync: _execSync,
	    spawn: _spawn,
            fork: _fork,
	    exec: _execSync,
	},
	"http" : _http,
	// https used to fall through to the real module, whose requests fail asynchronously
	// in a network-less worker. Emulate that: log the request, hand back an emitter, and
	// fire "error" (ECONNREFUSED) on a later tick if anyone listens, so promise wrappers,
	// error-driven C2 fallbacks and the code after a beacon all keep running.
	"https" : _https_module(),
        "net" : {
            createConnection: _createConnection,
            Socket: _Socket,
	    createServer: _createServer,
        },
        "request" : {
        },
        "socket.io-client" : _io_client,
        "axios" : {
            post: _axiosPost,
            get: _axiosGet,
        },
        "better-sqlite3" : {
        },
        "node-machine-id" : {
            machineId : _machineId,
            machineIdSync : _machineIdSync,
        },
	"express" : {
	    Router : _router,
	},
	"fs" : {
	    writeFileSync : _writeFileSync,
	    mkdirSync : _mkdirSync,
	    existsSync : _existsSync,
	    statSync : _statSync,
	},
        "os" : {
            hostname: _NODE_os_hostname,
            userInfo: _NODE_os_userInfo,
            platform: _NODE_os_platform,
            arch: _NODE_os_arch,
            totalmem: _NODE_os_totalmem,
            cpus: _NODE_os_cpus,
            uptime: _NODE_os_uptime,
            userInfo: _NODE_os_userInfo,
            hostname: _NODE_os_hostname,
            networkInterfaces: _NODE_os_networkInterfaces,
        }
    }
    if (typeof overrides[arg] !== "undefined") return overrides[arg];
    try {
	return _origRequire(arg);
    }
    catch (e) {
	lib.error("require(" + arg + ") failed (module unknown). Returning empty module ...");
	return {};
    }
}

// The emulated https module (see "https" above). Built here, inside the sandbox, from the
// sandbox's own EventEmitter.
function _https_module() {
    const EventEmitter = _origRequire("events");
    function str(v) {
	return (v === undefined || v === null) ? "" : String(v);
    }
    // The URL node would contact: a string or URL object, with an options object's fields
    // taking precedence (as http.request(url, options) merges them).
    function target(a, b) {
	let o = {};
	// Parsed by hand: the sandbox's URL is box-js's own emulation.
	const from = (href) => {
	    const m = /^([a-z][a-z0-9+.-]*:)\/\/([^\/?#:]*)(?::(\d*))?([^#]*)/i.exec(href);
	    return m ? {protocol: m[1].toLowerCase(), hostname: m[2], port: m[3], path: m[4] || "/"} : null;
	};
	// A URL object: node's has href; boilerplate.js's emulated URL keeps it in .url.
	const urlText = (x) => typeof x === "string" ? x :
	      (x && typeof x === "object" && typeof x.href === "string") ? x.href :
	      (x && typeof x === "object" && typeof x.url === "string" && /^[a-z][a-z0-9+.-]*:\/\//i.test(x.url)) ? x.url : null;
	if (urlText(a) !== null) {
	    const href = urlText(a);
	    o = from(href);
	    if (!o) return href;
	} else if (a && typeof a === "object") {
	    b = a;
	}
	if (b && typeof b === "object") {
	    for (const k of ["protocol", "hostname", "host", "port", "path", "pathname", "search"]) {
		if (b[k] !== undefined && b[k] !== null) o[k] = b[k];
	    }
	    if (b.path === undefined && (b.pathname !== undefined || b.search !== undefined)) {
		o.path = str(b.pathname) + str(b.search);
	    }
	}
	let host = str(o.hostname);
	let port = str(o.port);
	if (!host && o.host !== undefined) {
	    const m = /^(.*?)(?::(\d+))?$/.exec(str(o.host));
	    host = m[1];
	    if (!port && m[2]) port = m[2];
	}
	const protocol = str(o.protocol) || "https:";
	const dflt = protocol === "http:" ? "80" : "443";
	return protocol + "//" + (host || "localhost") + (port && port !== dflt ? ":" + port : "") + (str(o.path) || "/");
    }
    function fakeRequest(method, url, options, callback) {
	if (typeof options === "function") {
	    callback = options;
	    options = undefined;
	}
	const where = target(url, options);
	logIOC("https." + method + "()", {url: where, options: (url && typeof url === "object") ? url : options},
	       "The script made a web request with https." + method + "().");
	lib.logUrl("https." + method + "()", where);
	const req = new EventEmitter();
	for (const m of ["write", "end", "setTimeout", "setHeader", "removeHeader", "destroy", "abort",
			 "setNoDelay", "setSocketKeepAlive", "flushHeaders", "cork", "uncork"]) {
	    req[m] = function () { return req; };
	}
	req.getHeader = function () { return undefined; };
	req.addListener = req.on;
	// A microtask, not setTimeout: boilerplate.js's setTimeout runs its callback at once,
	// before the caller has attached its "error" listener.
	Promise.resolve().then(function () {
	    if (req.listenerCount("error") > 0) {
		const err = new Error("connect ECONNREFUSED " + where);
		err.code = "ECONNREFUSED";
		req.emit("error", err);
	    }
	});
	return req;
    }
    function Agent(options) {
	this.options = options || {};
	this.destroy = function () {};
    }
    return {
	__name: "_https",
	request: function (url, options, callback) { return fakeRequest("request", url, options, callback); },
	get: function (url, options, callback) { return fakeRequest("get", url, options, callback); },
	Agent: Agent,
	globalAgent: new Agent(),
    };
}
