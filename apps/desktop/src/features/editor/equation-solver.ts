export type LocalEquationKind = "arithmetic" | "linear" | "quadratic";

export interface LocalEquationSolution {
  kind: LocalEquationKind;
  originalLatex: string;
  solvedLatex: string;
  variable?: string;
  values: number[];
}

type TokenKind =
  | "number" | "symbol" | "plus" | "minus" | "mul" | "div" | "pow"
  | "lparen" | "rparen" | "frac" | "sqrt" | "func" | "constant" | "eof";

interface Token { kind: TokenKind; value?: string | number }

type Expr =
  | { kind: "number"; value: number }
  | { kind: "symbol"; name: string }
  | { kind: "unary"; op: "+" | "-"; value: Expr }
  | { kind: "binary"; op: "+" | "-" | "*" | "/" | "^"; left: Expr; right: Expr }
  | { kind: "function"; name: string; value: Expr };

type Poly = [number, number, number];

const EPS = 1e-10;
const MAX_ABS_VALUE = 1e14;
const FUNCTION_NAMES = new Set(["sin", "cos", "tan", "ln", "log", "exp"]);
const IGNORED_COMMANDS = new Set(["left", "right", "big", "Big", "bigg", "Bigg", "quad", "qquad"]);

function stripMathDelimiters(latex: string): string {
  let source = latex.trim();
  if (source.startsWith("$$") && source.endsWith("$$") && source.length >= 4) source = source.slice(2, -2).trim();
  else if (source.startsWith("$") && source.endsWith("$") && source.length >= 2) source = source.slice(1, -1).trim();
  if (source.startsWith("\\(") && source.endsWith("\\)")) source = source.slice(2, -2).trim();
  if (source.startsWith("\\[") && source.endsWith("\\]")) source = source.slice(2, -2).trim();
  return source;
}

function splitEquation(latex: string): { source: string; left: string; right: string } | null {
  const source = stripMathDelimiters(latex);
  let depth = 0;
  let equalIndex = -1;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === "\\") { // skip a command name so escaped/control content cannot fake an equals
      i += 1;
      while (i < source.length && /[A-Za-z]/.test(source[i])) i += 1;
      i -= 1;
      continue;
    }
    if (char === "{" || char === "(" || char === "[") depth += 1;
    else if (char === "}" || char === ")" || char === "]") depth = Math.max(0, depth - 1);
    else if (char === "=" && depth === 0) {
      if (equalIndex >= 0) return null;
      equalIndex = i;
    }
  }
  if (equalIndex < 0) return null;
  return { source, left: source.slice(0, equalIndex).trim(), right: source.slice(equalIndex + 1).trim() };
}

function tokenize(source: string): Token[] | null {
  const tokens: Token[] = [];
  for (let i = 0; i < source.length;) {
    const char = source[i];
    if (/\s/.test(char)) { i += 1; continue; }
    if (/[0-9.]/.test(char)) {
      const match = source.slice(i).match(/^(?:\d+(?:\.\d*)?|\.\d+)/);
      if (!match) return null;
      const value = Number(match[0]);
      if (!Number.isFinite(value)) return null;
      tokens.push({ kind: "number", value });
      i += match[0].length;
      continue;
    }
    if (/[A-Za-z]/.test(char)) {
      // In ordinary math, adjacent letters mean implicit multiplication. Keeping
      // each letter separate also prevents "randomword=..." from masquerading
      // as one supported unknown.
      if (char === "e") tokens.push({ kind: "constant", value: Math.E });
      else tokens.push({ kind: "symbol", value: char });
      i += 1;
      continue;
    }
    if (char === "+") { tokens.push({ kind: "plus" }); i += 1; continue; }
    if (char === "-" || char === "−" || char === "–") { tokens.push({ kind: "minus" }); i += 1; continue; }
    if (char === "*" || char === "·" || char === "×") { tokens.push({ kind: "mul" }); i += 1; continue; }
    if (char === "/" || char === "÷") { tokens.push({ kind: "div" }); i += 1; continue; }
    if (char === "^") { tokens.push({ kind: "pow" }); i += 1; continue; }
    if (char === "(" || char === "{" || char === "[") { tokens.push({ kind: "lparen" }); i += 1; continue; }
    if (char === ")" || char === "}" || char === "]") { tokens.push({ kind: "rparen" }); i += 1; continue; }
    if (char === "\\") {
      if (source[i + 1] && /[,;! ]/.test(source[i + 1])) { i += 2; continue; }
      const command = source.slice(i + 1).match(/^[A-Za-z]+/)?.[0] ?? "";
      if (!command) return null;
      i += command.length + 1;
      if (command === "frac" || command === "dfrac" || command === "tfrac") tokens.push({ kind: "frac" });
      else if (command === "sqrt") {
        // Indexed roots (for example \sqrt[3]{8}) need different semantics.
        // Reject them instead of accidentally treating the index as the radicand.
        let lookahead=i;
        while(lookahead<source.length&&/\s/.test(source[lookahead]))lookahead+=1;
        if(source[lookahead]==="[")return null;
        tokens.push({ kind: "sqrt" });
      }
      else if (command === "cdot" || command === "times") tokens.push({ kind: "mul" });
      else if (command === "div") tokens.push({ kind: "div" });
      else if (command === "pi") tokens.push({ kind: "constant", value: Math.PI });
      else if (FUNCTION_NAMES.has(command)) tokens.push({ kind: "func", value: command });
      else if (IGNORED_COMMANDS.has(command)) { /* visual-only command */ }
      else return null;
      continue;
    }
    // Commas, relations, text, factorials, percent, matrices, subscripts, etc.
    // are intentionally unsupported instead of guessed at.
    return null;
  }
  tokens.push({ kind: "eof" });
  return tokens;
}

class Parser {
  private index = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) { this.tokens = tokens; }

  parse(): Expr | null {
    try {
      const expression = this.parseAddSub();
      if (this.peek().kind !== "eof") return null;
      return expression;
    } catch { return null; }
  }

  private peek(): Token { return this.tokens[this.index] ?? { kind: "eof" }; }
  private take(kind: TokenKind): Token {
    const token = this.peek();
    if (token.kind !== kind) throw new Error("unexpected token");
    this.index += 1;
    return token;
  }

  private parseAddSub(): Expr {
    let left = this.parseMulDiv();
    while (this.peek().kind === "plus" || this.peek().kind === "minus") {
      const op = this.peek().kind === "plus" ? "+" : "-";
      this.index += 1;
      left = { kind: "binary", op, left, right: this.parseMulDiv() };
    }
    return left;
  }

  private startsPrimary(kind: TokenKind): boolean {
    return kind === "number" || kind === "symbol" || kind === "constant" || kind === "lparen" || kind === "frac" || kind === "sqrt" || kind === "func";
  }

  private parseMulDiv(): Expr {
    let left = this.parseUnary();
    for (;;) {
      if (this.peek().kind === "mul" || this.peek().kind === "div") {
        const op = this.peek().kind === "mul" ? "*" : "/";
        this.index += 1;
        left = { kind: "binary", op, left, right: this.parseUnary() };
        continue;
      }
      if (this.startsPrimary(this.peek().kind)) {
        left = { kind: "binary", op: "*", left, right: this.parseUnary() };
        continue;
      }
      return left;
    }
  }

  private parseUnary(): Expr {
    if (this.peek().kind === "plus" || this.peek().kind === "minus") {
      const op = this.peek().kind === "plus" ? "+" : "-";
      this.index += 1;
      return { kind: "unary", op, value: this.parseUnary() };
    }
    return this.parsePower();
  }

  private parsePower(): Expr {
    let left = this.parsePrimary();
    if (this.peek().kind === "pow") {
      this.index += 1;
      left = { kind: "binary", op: "^", left, right: this.parseUnary() };
    }
    return left;
  }

  private parseGroup(): Expr {
    this.take("lparen");
    const expression = this.parseAddSub();
    this.take("rparen");
    return expression;
  }

  private parsePrimary(): Expr {
    const token = this.peek();
    if (token.kind === "number") { this.index += 1; return { kind: "number", value: Number(token.value) }; }
    if (token.kind === "constant") { this.index += 1; return { kind: "number", value: Number(token.value) }; }
    if (token.kind === "symbol") { this.index += 1; return { kind: "symbol", name: String(token.value) }; }
    if (token.kind === "lparen") return this.parseGroup();
    if (token.kind === "frac") {
      this.index += 1;
      const numerator = this.parseGroup();
      const denominator = this.parseGroup();
      return { kind: "binary", op: "/", left: numerator, right: denominator };
    }
    if (token.kind === "sqrt") {
      this.index += 1;
      return { kind: "function", name: "sqrt", value: this.parseGroup() };
    }
    if (token.kind === "func") {
      this.index += 1;
      return { kind: "function", name: String(token.value), value: this.parseGroup() };
    }
    throw new Error("expected expression");
  }
}

function parseExpression(source: string): Expr | null {
  const tokens = tokenize(source);
  return tokens ? new Parser(tokens).parse() : null;
}

function symbols(expr: Expr, output = new Set<string>()): Set<string> {
  if (expr.kind === "symbol") output.add(expr.name);
  else if (expr.kind === "unary" || expr.kind === "function") symbols(expr.value, output);
  else if (expr.kind === "binary") { symbols(expr.left, output); symbols(expr.right, output); }
  return output;
}

function finite(value: number): number | null {
  return Number.isFinite(value) && Math.abs(value) <= MAX_ABS_VALUE ? value : null;
}

function evaluate(expr: Expr, variables: Record<string, number> = {}): number | null {
  if (expr.kind === "number") return finite(expr.value);
  if (expr.kind === "symbol") return Object.prototype.hasOwnProperty.call(variables, expr.name) ? finite(variables[expr.name]) : null;
  if (expr.kind === "unary") {
    const value = evaluate(expr.value, variables);
    return value === null ? null : finite(expr.op === "-" ? -value : value);
  }
  if (expr.kind === "function") {
    const value = evaluate(expr.value, variables);
    if (value === null) return null;
    if (expr.name === "sqrt") return value < -EPS ? null : finite(Math.sqrt(Math.max(0, value)));
    if (expr.name === "sin") return finite(Math.sin(value));
    if (expr.name === "cos") return finite(Math.cos(value));
    if (expr.name === "tan") return finite(Math.tan(value));
    if (expr.name === "ln") return value <= 0 ? null : finite(Math.log(value));
    if (expr.name === "log") return value <= 0 ? null : finite(Math.log10(value));
    if (expr.name === "exp") return finite(Math.exp(value));
    return null;
  }
  const left = evaluate(expr.left, variables);
  const right = evaluate(expr.right, variables);
  if (left === null || right === null) return null;
  if (expr.op === "+") return finite(left + right);
  if (expr.op === "-") return finite(left - right);
  if (expr.op === "*") return finite(left * right);
  if (expr.op === "/") return Math.abs(right) <= EPS ? null : finite(left / right);
  if (expr.op === "^") {
    // Avoid complex-valued or explosive local guesses.
    if (left < 0 && Math.abs(right - Math.round(right)) > EPS) return null;
    return finite(Math.pow(left, right));
  }
  return null;
}

function polyAdd(a: Poly, b: Poly, sign = 1): Poly {
  return [a[0] + sign * b[0], a[1] + sign * b[1], a[2] + sign * b[2]];
}
function polyScale(a: Poly, scale: number): Poly { return [a[0] * scale, a[1] * scale, a[2] * scale]; }
function polyDegree(poly: Poly): number {
  if (Math.abs(poly[2]) > EPS) return 2;
  if (Math.abs(poly[1]) > EPS) return 1;
  return 0;
}
function polyMultiply(a: Poly, b: Poly): Poly | null {
  const c0 = a[0] * b[0];
  const c1 = a[0] * b[1] + a[1] * b[0];
  const c2 = a[0] * b[2] + a[1] * b[1] + a[2] * b[0];
  const cubic = a[1] * b[2] + a[2] * b[1];
  const quartic = a[2] * b[2];
  if (Math.abs(cubic) > EPS || Math.abs(quartic) > EPS) return null;
  return [c0, c1, c2];
}

function toPolynomial(expr: Expr, variable: string): Poly | null {
  if (expr.kind === "number") return [expr.value, 0, 0];
  if (expr.kind === "symbol") return expr.name === variable ? [0, 1, 0] : null;
  if (expr.kind === "unary") {
    const value = toPolynomial(expr.value, variable);
    return value ? polyScale(value, expr.op === "-" ? -1 : 1) : null;
  }
  if (expr.kind === "function") {
    if (symbols(expr).size) return null;
    const value = evaluate(expr);
    return value === null ? null : [value, 0, 0];
  }
  const left = toPolynomial(expr.left, variable);
  if (expr.op === "^") {
    if (!left) return null;
    const exponent = evaluate(expr.right);
    if (exponent === null || Math.abs(exponent - Math.round(exponent)) > EPS) return null;
    const power = Math.round(exponent);
    if (power < 0 || power > 2) return null;
    if (power === 0) return [1, 0, 0];
    if (power === 1) return left;
    return polyMultiply(left, left);
  }
  const right = toPolynomial(expr.right, variable);
  if (!left || !right) return null;
  if (expr.op === "+") return polyAdd(left, right);
  if (expr.op === "-") return polyAdd(left, right, -1);
  if (expr.op === "*") return polyMultiply(left, right);
  if (expr.op === "/") {
    if (polyDegree(right) !== 0 || Math.abs(right[0]) <= EPS) return null;
    return polyScale(left, 1 / right[0]);
  }
  return null;
}

function isSimpleSolvedSide(expr: Expr, variable: string): boolean {
  if (expr.kind === "number") return true;
  if (expr.kind === "unary" && expr.op === "-" && expr.value.kind === "number") return true;
  if (expr.kind === "symbol" && expr.name === variable) return true;
  return false;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y) { const next = x % y; x = y; y = next; }
  return x || 1;
}

function rationalApprox(value: number): { numerator: number; denominator: number } | null {
  const sign = value < 0 ? -1 : 1;
  const target = Math.abs(value);
  for (let denominator = 1; denominator <= 1000; denominator += 1) {
    const numerator = Math.round(target * denominator);
    if (Math.abs(target - numerator / denominator) <= 1e-11) {
      const divisor = gcd(numerator, denominator);
      return { numerator: sign * (numerator / divisor), denominator: denominator / divisor };
    }
  }
  return null;
}

export function formatLocalNumberLatex(value: number): string {
  const normalized = Math.abs(value) <= EPS ? 0 : value;
  if (Math.abs(normalized - Math.round(normalized)) <= 1e-11) return String(Math.round(normalized));
  const rational = rationalApprox(normalized);
  if (rational && rational.denominator !== 1) {
    const sign = rational.numerator < 0 ? "-" : "";
    return `${sign}\\frac{${Math.abs(rational.numerator)}}{${rational.denominator}}`;
  }
  return Number(normalized.toPrecision(10)).toString();
}

function appendArithmeticResult(source: string, result: string): string {
  return `${source}${result}`;
}

function appendVariableResult(source: string, variable: string, values: number[]): string {
  const unique = [...values]
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
    .filter((value, index, list) => index === 0 || Math.abs(value - list[index - 1]) > 1e-9);
  const answer = unique.map(value => `${variable}=${formatLocalNumberLatex(value)}`).join(String.raw`,\;`);
  return `${source}\\quad\\Rightarrow\\quad ${answer}`;
}

/**
 * Returns a solution only when the local parser can safely understand the
 * equation. The UI uses this both to decide whether "Solve" is visible and to
 * produce the replacement LaTeX, so unsupported/random input never gets a
 * speculative button.
 */
export function solveLatexEquationLocally(latex: string): LocalEquationSolution | null {
  const equation = splitEquation(latex);
  if (!equation || !equation.left) return null;
  const left = parseExpression(equation.left);
  if (!left) return null;

  // Calculator-style question: `1+1=`. A blank RHS is intentionally required;
  // completed numeric equalities such as `1+1=2` are already answers.
  if (!equation.right) {
    if (symbols(left).size !== 0) return null;
    const value = evaluate(left);
    if (value === null) return null;
    return {
      kind: "arithmetic",
      originalLatex: equation.source,
      solvedLatex: appendArithmeticResult(equation.source, formatLocalNumberLatex(value)),
      values: [value],
    };
  }

  const right = parseExpression(equation.right);
  if (!right) return null;
  const names = new Set([...symbols(left), ...symbols(right)]);
  if (names.size !== 1) return null;
  const variable = [...names][0];

  // `x=2` / `2=x` is already solved. `x=1+1` is still useful to simplify.
  if (left.kind === "symbol" && left.name === variable && isSimpleSolvedSide(right, variable)) return null;
  if (right.kind === "symbol" && right.name === variable && isSimpleSolvedSide(left, variable)) return null;

  const leftPoly = toPolynomial(left, variable);
  const rightPoly = toPolynomial(right, variable);
  if (!leftPoly || !rightPoly) return null;
  const equationPoly = polyAdd(leftPoly, rightPoly, -1);
  const degree = polyDegree(equationPoly);
  if (degree === 0) return null; // identity/contradiction, not a single-answer solve action

  if (degree === 1) {
    const [constant, linear] = equationPoly;
    if (Math.abs(linear) <= EPS) return null;
    const value = finite(-constant / linear);
    if (value === null) return null;
    return {
      kind: "linear",
      originalLatex: equation.source,
      solvedLatex: appendVariableResult(equation.source, variable, [value]),
      variable,
      values: [value],
    };
  }

  const [constant, linear, quadratic] = equationPoly;
  if (Math.abs(quadratic) <= EPS) return null;
  const discriminant = linear * linear - 4 * quadratic * constant;
  if (discriminant < -EPS) return null; // first version is deliberately real-number only
  const root = Math.sqrt(Math.max(0, discriminant));
  const denominator = 2 * quadratic;
  const first = finite((-linear - root) / denominator);
  const second = finite((-linear + root) / denominator);
  if (first === null || second === null) return null;
  return {
    kind: "quadratic",
    originalLatex: equation.source,
    solvedLatex: appendVariableResult(equation.source, variable, [first, second]),
    variable,
    values: [first, second],
  };
}

export function canSolveLatexEquationLocally(latex: string): boolean {
  return solveLatexEquationLocally(latex) !== null;
}


export interface MathSolveCandidate {
  originalLatex: string;
  localSolution: LocalEquationSolution | null;
  mode: "local" | "cloud";
}

const ADVANCED_MATH_COMMAND = /\\(?:int|iint|iiint|oint|sum|prod|lim|partial|nabla|frac|dfrac|tfrac|sqrt|sin|cos|tan|sec|csc|cot|arcsin|arccos|arctan|ln|log|exp|begin|det|left|right)\b/;
const MATH_OPERATOR = /[+\-−–*/×÷^_<>≤≥±∓]/;
const SINGLE_SYMBOL_RELATION = /^\s*[A-Za-z]\s*=\s*[A-Za-z]\s*$/;
const TRIVIALLY_SOLVED = /^\s*[A-Za-z]\s*=\s*(?:-?\d+(?:\.\d+)?|\\(?:pi|infty)|[A-Za-z])\s*$/;

function looksLikeAdvancedMathQuestion(source: string): boolean {
  if (!source.includes("=") || source.length > 12_000) return false;
  const withoutCommands = source.replace(/\\[A-Za-z]+/g, " ");
  const letters = withoutCommands.match(/[A-Za-z]+/g) ?? [];
  const hasKnownCommand = ADVANCED_MATH_COMMAND.test(source);
  const hasOperator = MATH_OPERATOR.test(source);
  const hasNumber = /\d/.test(source);
  const hasStructure = /[{}()[\]]/.test(source);
  // Ordinary prose such as hello=world must not turn into a Solve action. Math
  // words are accepted only when LaTeX structure/commands/operators make the
  // intent unambiguous. Single-letter symbols remain valid multivariable math.
  const suspiciousWord = letters.some(word => word.length > 2);
  if (suspiciousWord && !hasKnownCommand) return false;
  if (hasKnownCommand || hasOperator || hasNumber || hasStructure) return true;
  return SINGLE_SYMBOL_RELATION.test(source);
}

/**
 * Decides whether a LaTeX node deserves a Solve button. Basic arithmetic and
 * polynomial work stays deterministic/local. Broader symbolic math is marked
 * for the Cloud Math fallback instead of being incorrectly rejected.
 */
export function analyzeLatexSolveCandidate(latex: string): MathSolveCandidate | null {
  const source = stripMathDelimiters(latex);
  if (!source || !source.includes("=")) return null;
  const localSolution = solveLatexEquationLocally(source);
  if (localSolution) return { originalLatex: source, localSolution, mode: "local" };
  if (TRIVIALLY_SOLVED.test(source)) return null;
  if (!looksLikeAdvancedMathQuestion(source)) return null;
  return { originalLatex: source, localSolution: null, mode: "cloud" };
}

/** Evaluate a supported LaTeX expression at concrete variable values. */
export function evaluateLatexExpressionAt(source: string, variables: Record<string, number>): number | null {
  const expression = parseExpression(stripMathDelimiters(source));
  return expression ? evaluate(expression, variables) : null;
}

/**
 * Evaluate left-right for one x/y relation. A zero result lies on the curve.
 * This powers the local graph renderer; unsupported graph syntax returns null
 * instead of running arbitrary JavaScript.
 */
export function compileLatexRelation(latex: string): ((variables: Record<string, number>) => number | null) | null {
  const equation = splitEquation(latex);
  if (!equation || !equation.left || !equation.right) return null;
  const left = parseExpression(equation.left);
  const right = parseExpression(equation.right);
  if (!left || !right) return null;
  return (variables: Record<string, number>) => {
    const l = evaluate(left, variables), r = evaluate(right, variables);
    if (l === null || r === null) return null;
    return finite(l - r);
  };
}

export function evaluateLatexRelationAt(latex: string, variables: Record<string, number>): number | null {
  return compileLatexRelation(latex)?.(variables) ?? null;
}
