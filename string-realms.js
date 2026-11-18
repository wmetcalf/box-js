// String.prototype.valueOf of each sandbox realm, registered by analyze.js before the sample
// runs, read as "".valueOf (the realm intrinsic, not a String global the sample could plant
// on the shared sandbox before a fallback VM is made). Kept out of lib.js, whose exports the
// sandbox can reach. The host require the sandbox is given (a known residual) could still
// reach this module.
const valueOfs = [];

module.exports = {
	register(fn) {
		if (typeof fn === "function" && !valueOfs.includes(fn)) valueOfs.push(fn);
	},
	list() {
		return valueOfs.slice();
	},
};
