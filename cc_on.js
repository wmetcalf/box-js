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

// The values cscript.exe/wscript.exe report on 32-bit Windows (the C preprocessor
// defines box-js used to pass, plus the version and build JScript 5.8 reports).
const DEFAULT_VARS = Object.freeze({
  _jscript: true,
  _jscript_build: 18702,
  _jscript_version: 5.8,
  _win16: false,
  _win32: true,
  _win64: true,
  _x86: true,
});

const DIRECTIVE = /@(if|elif|else|end|set)(?![\w$])/gi;

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

// Whether code[idx] is inside a string literal, judged from the start of its line: JScript
// leaves literals alone (an "@set" or "user@_win32.example" in a string is text). Strings do
// not span lines, so a quote in a comment or regex can only mislead the rest of its own
// line; a "//" comment is code for this purpose (that is where //@if lives), and a
// "/* ... */" on the line is skipped.
function inString(code, idx) {
  let i = code.lastIndexOf("\n", idx - 1) + 1;
  let quote = null;
  while (i < idx) {
    const c = code[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === "/" && code[i + 1] === "/") {
      return false;
    } else if (c === "/" && code[i + 1] === "*") {
      const close = code.indexOf("*/", i + 2);
      if (close < 0 || close >= idx) return false;
      i = close + 1;
    } else if (c === "\"" || c === "'" || c === "`") {
      quote = c;
    }
    i++;
  }
  return quote !== null;
}

function lookup(vars, name) {
  return Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : 0;
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
  // Only primitives come out (strings, numbers, booleans): nothing reaches the sandbox.
  return v;
}

// Replace @name in active code with the variable's value, as JScript does; unknown names
// are left as they are.
function substitute(text, vars) {
  return text.replace(/@([A-Za-z_$][\w$]*)/g, (m, name, offset) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name) || inString(text, offset)) return m;
    const v = vars[name];
    return typeof v === "string" ? JSON.stringify(v) : String(v);
  });
}

// `code` has had /*@cc_on, @cc_on, /*@ and @*/ removed already. `warn` gets a message
// for each condition that could not be evaluated (taken as false).
function preprocess(code, warn = () => {}) {
  const vars = Object.assign(Object.create(null), DEFAULT_VARS);
  // One frame per open @if: whether this level emits code, and whether a branch was taken.
  const stack = [];
  const active = () => stack.every((f) => f.on);
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
    if (inString(code, m.index)) continue;
    if (active()) out += substitute(code.slice(pos, m.index), vars);
    let next = m.index + m[0].length;
    const kind = m[1].toLowerCase();
    if (kind === "if") {
      const c = readCondition(code, next);
      next = c.end;
      const parentOn = active();
      const on = parentOn && cond(c.text);
      stack.push({on, taken: on, parentOn});
    } else if (kind === "elif") {
      const c = readCondition(code, next);
      next = c.end;
      const f = stack[stack.length - 1];
      if (f) {
        const on = f.parentOn && !f.taken && cond(c.text);
        f.on = on;
        f.taken = f.taken || on;
      }
    } else if (kind === "else") {
      const f = stack[stack.length - 1];
      if (f) {
        f.on = f.parentOn && !f.taken;
        f.taken = true;
      }
    } else if (kind === "end") {
      stack.pop();
    } else if (kind === "set") {
      // @set @name = expression (to the end of the line or a ";")
      let i = next;
      while (i < code.length && /[ \t]/.test(code[i])) i++;
      let end = i;
      while (end < code.length && code[end] !== "\n" && code[end] !== ";") end++;
      const stmt = code.slice(i, end);
      next = end;
      const sm = /^@([A-Za-z_$][\w$]*)\s*=([\s\S]*)$/.exec(stmt);
      if (active() && sm) {
        try {
          vars[sm[1]] = evaluate(sm[2], vars);
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
