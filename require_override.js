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
	// https used to fall through to the real module; now logged through the http stub,
	// with the URL as https (the http stub builds "http://" from an options object).
	"https" : (function () {
	    // The http stub logs the request and then throws "Fake error". The real https
	    // module (which this id reached before) fails asynchronously instead, so the code
	    // after a beacon kept running; keep that: log, then hand back an inert request.
	    function fakeRequest() {
		const req = {__name: "_https_request"};
		for (const m of ["on", "once", "write", "end", "setTimeout", "setHeader", "destroy", "abort",
				 "setNoDelay", "setSocketKeepAlive", "removeListener", "off"]) {
		    req[m] = function () { return req; };
		}
		return req;
	    }
	    function log(url, options) {
		try { _http.request(url, options); } catch (e) {}
	    }
	    return {
		__name: "_https",
		request: function (url, options) {
		    if (url && typeof url === "object" && typeof url.href === "string") {
			log(url.href, options); // A URL object.
		    } else if (url && typeof url === "object" && typeof url.hostname !== "undefined") {
			const p = url.port === undefined || url.port === null ? "" : String(url.port);
			const port = (p !== "" && p !== "443") ? ":" + p : "";
			const where = url.path || ((url.pathname || "") + (url.search || ""));
			log("https://" + url.hostname + port + where, url);
		    } else {
			log(url, options);
		    }
		    return fakeRequest();
		},
		get: function (url, headers) {
		    return _http.get(url, headers);
		},
	    };
	})(),
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
