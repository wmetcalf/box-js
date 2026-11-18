// String.prototype.valueOf of each sandbox realm, registered by analyze.js before the sample
// runs. Kept out of lib.js, whose exports the sandbox can reach, so a sample cannot register
// a fake verifier.
const valueOfs = [];

module.exports = {
	register(fn) {
		if (typeof fn === "function" && !valueOfs.includes(fn)) valueOfs.push(fn);
	},
	list() {
		return valueOfs.slice();
	},
};
