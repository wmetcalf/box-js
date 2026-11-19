// JScript conditional compilation (@if/@elif/@else/@end, @set), evaluated in JS.
//
// This used to be done by piping the sample through m4 and then the C preprocessor on the
// host. Both are programs whose input the sample wrote, and every escaping scheme put in
// front of them was eventually walked around (m4 syscmd/include; cpp #include via digraphs,
// trigraphs, line splices, NUL bytes m4 drops, UCN-spelled __has_include / _Pragma; a "#"
// that made m4 fail and leave an empty program). Here the sample's text is only ever
// scanned as a string, and an @if condition is parsed with acorn and evaluated over a
// whitelist of operators, literals and @variables. No process is started.

const acorn = require("acorn");

// Undefined variables (including _win16, _mac, ...) are NaN, as in JScript.
// The values cscript.exe/wscript.exe report on 32-bit Windows (the C preprocessor
// defines box-js used to pass, plus the version and build JScript 5.8 reports).
const DEFAULT_VARS = Object.freeze({
  _jscript: true,
  _jscript_build: 18702,
  _jscript_version: 5.8,
  _win32: true,
  _win64: true,
  _x86: true,
});

// Not after a word character: "user@end.example" is an address, not a directive.
const DIRECTIVE = /(?<![\w$@])@(if|elif|else|end|set)(?![\w$])/gi;
// JScript's @set values are numbers and booleans. Strings are only allowed as literals
// inside an expression, and bounded, so a sample cannot grow one across @set lines.
const MAX_STRING = 4096;

// The text of a balanced "( ... )" starting at code[i] (after blanks), or a condition up
// to the end of the line when there is no parenthesis (cpp's reading of the old rewrite).
function readCondition(code, i) {
  while (i < code.length && /[ \t]/.test(code[i])) i++;
  if (code[i] !== "(") {
    const eol = code.indexOf("\n", i);
    const end = eol < 0 ? code.length : eol;
    return {text: code.slice(i, end), end};
  }
  let depth = 0;
  let quote = null;
  for (let j = i; j < code.length; j++) {
    const c = code[j];
    if (quote) {
      if (c === "\\") j++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "\"" || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return {text: code.slice(i, j + 1), end: j + 1};
  }
  return {text: code.slice(i), end: code.length};
}

function lookup(vars, name) {
  return Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : NaN;
}

// Evaluate a condition/@set expression. Anything outside the whitelist is an error.
function evaluate(text, vars) {
  const source = text.replace(/@([A-Za-z_$][\w$]*)/g, "__boxjs_cc_$1");
  const ast = acorn.parse("(" + source + "\n)", {ecmaVersion: 2020});
  if (ast.body.length !== 1 || ast.body[0].type !== "ExpressionStatement") {
    throw new Error("not a single expression");
  }
  let steps = 0;
  function ev(node) {
    if (++steps > 10000) throw new Error("expression too large");
    switch (node.type) {
    case "Literal":
      if (node.regex || typeof node.value === "bigint") throw new Error("unsupported literal");
      return node.value;
    case "Identifier":
      if (node.name.startsWith("__boxjs_cc_")) return lookup(vars, node.name.slice(11));
      if (node.name === "undefined") return undefined;
      if (node.name === "NaN") return NaN;
      if (node.name === "Infinity") return Infinity;
      throw new Error("unknown identifier " + node.name);
    case "UnaryExpression": {
      const v = ev(node.argument);
      switch (node.operator) {
      case "!": return !v;
      case "-": return -v;
      case "+": return +v;
      case "~": return ~v;
      default: throw new Error("unsupported operator " + node.operator);
      }
    }
    case "BinaryExpression": {
      const a = ev(node.left);
      const b = ev(node.right);
      if ((typeof a === "string" && a.length > MAX_STRING) || (typeof b === "string" && b.length > MAX_STRING)) {
        throw new Error("string too long");
      }
      switch (node.operator) {
      case "+": return a + b;
      case "-": return a - b;
      case "*": return a * b;
      case "/": return a / b;
      case "%": return a % b;
      case "==": return a == b; // eslint-disable-line eqeqeq
      case "!=": return a != b; // eslint-disable-line eqeqeq
      case "===": return a === b;
      case "!==": return a !== b;
      case "<": return a < b;
      case "<=": return a <= b;
      case ">": return a > b;
      case ">=": return a >= b;
      case "&": return a & b;
      case "|": return a | b;
      case "^": return a ^ b;
      case "<<": return a << b;
      case ">>": return a >> b;
      case ">>>": return a >>> b;
      default: throw new Error("unsupported operator " + node.operator);
      }
    }
    case "LogicalExpression": {
      const a = ev(node.left);
      if (node.operator === "&&") return a && ev(node.right);
      if (node.operator === "||") return a || ev(node.right);
      throw new Error("unsupported operator " + node.operator);
    }
    case "ConditionalExpression":
      return ev(node.test) ? ev(node.consequent) : ev(node.alternate);
    case "SequenceExpression": {
      let v;
      for (const e of node.expressions) v = ev(e);
      return v;
    }
    default:
      throw new Error("unsupported expression " + node.type);
    }
  }
  const v = ev(ast.body[0].expression);
  if (typeof v === "string" && v.length > MAX_STRING) throw new Error("string too long");
  // Only primitives come out (strings, numbers, booleans): nothing reaches the sandbox.
  return v;
}

// Replace @name in active code with the variable's value, as JScript does. Unknown names
// are left as they are, and so is an @ that follows a word character ("user@_win32.example"
// in a string): a conditional-compilation variable in code never does. String literals are
// not tracked: a quote in a regex would hide every later variable on its line, leaving a
// bare "@name" that fails to parse.
function substitute(text, vars) {
  return text.replace(/(^|[^\w$@])@([A-Za-z_$][\w$]*)/g, (m, pre, name) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) return m;
    const v = vars[name];
    return pre + (typeof v === "number" && Number.isNaN(v) ? "NaN" : String(v));
  });
}

// `code` has had /*@cc_on, @cc_on, /*@ and @*/ removed already. `warn` gets a message
// for each condition that could not be evaluated (taken as false).
function preprocess(code, warn = () => {}) {
  const vars = Object.assign(Object.create(null), DEFAULT_VARS);
  // One frame per open @if: whether this level emits code, and whether a branch was taken.
  const stack = [];
  // Number of open frames that are off: the code is live when there are none. (Checking
  // every frame per directive was quadratic in the nesting depth.)
  let off = 0;
  const active = () => off === 0;
  const setOn = (f, on) => {
    if (f.on !== on) off += on ? -1 : 1;
    f.on = on;
  };
  let out = "";
  let pos = 0;
  function cond(text) {
    try {
      return Boolean(evaluate(text, vars));
    } catch (e) {
      warn(`could not evaluate conditional compilation condition ${JSON.stringify(text.slice(0, 200))}: ${e.message}`);
      return false;
    }
  }
  DIRECTIVE.lastIndex = 0;
  let m;
  while ((m = DIRECTIVE.exec(code)) !== null) {
    if (active()) out += substitute(code.slice(pos, m.index), vars);
    let next = m.index + m[0].length;
    const kind = m[1].toLowerCase();
    // @elif/@else/@end with no open @if are text (e.g. "at @end" in a string).
    if (stack.length === 0 && (kind === "elif" || kind === "else" || kind === "end")) {
      if (active()) out += m[0];
      pos = next;
      continue;
    }
    if (kind === "if") {
      const c = readCondition(code, next);
      next = c.end;
      const parentOn = active();
      const on = parentOn && cond(c.text);
      stack.push({on, taken: on, parentOn});
      if (!on) off++;
    } else if (kind === "elif") {
      const c = readCondition(code, next);
      next = c.end;
      const f = stack[stack.length - 1];
      if (f) {
        const on = f.parentOn && !f.taken && cond(c.text);
        setOn(f, on);
        f.taken = f.taken || on;
      }
    } else if (kind === "else") {
      const f = stack[stack.length - 1];
      if (f) {
        setOn(f, f.parentOn && !f.taken);
        f.taken = true;
      }
    } else if (kind === "end") {
      const f = stack.pop();
      if (f && !f.on) off--;
    } else if (kind === "set") {
      // @set @name = expression (to the end of the line or a ";")
      let i = next;
      while (i < code.length && /[ \t]/.test(code[i])) i++;
      let end = i;
      while (end < code.length && code[end] !== "\n" && code[end] !== ";") end++;
      const stmt = code.slice(i, end);
      next = end;
      const sm = /^@([A-Za-z_$][\w$]*)\s*=([\s\S]*)$/.exec(stmt);
      if (!sm) {
        // Not "@set @name = ..." (e.g. "@set" in a string): plain text.
        if (active()) out += m[0];
        pos = m.index + m[0].length;
        DIRECTIVE.lastIndex = pos;
        continue;
      }
      if (active()) {
        try {
          const v = evaluate(sm[2], vars);
          if (typeof v !== "number" && typeof v !== "boolean") throw new Error("@set values are numbers or booleans");
          vars[sm[1]] = v;
        } catch (e) {
          warn(`could not evaluate @set ${JSON.stringify(stmt.slice(0, 200))}: ${e.message}`);
        }
      }
    }
    // Keep line numbers roughly where they were.
    out += "\n";
    pos = next;
    DIRECTIVE.lastIndex = next;
  }
  if (active()) out += substitute(code.slice(pos), vars);
  return out;
}

module.exports = {preprocess, evaluate, DEFAULT_VARS};
