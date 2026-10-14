// Stage 2c: a value-flow graph built with the TypeScript compiler API.
// Text search finds the number 900000. It cannot find `const CACHE_TTL = 15 * MINUTE`, where MINUTE lives in
// another file and no line holds 900000. This folds constants (through imports, JSON, enums, env defaults and
// tiny helper functions) and reports the line of the literal a person would edit.
// The compiler is claimcheck's own copy (a runtime dependency), never the target repository's.
// If neither loads, or the repository has no TypeScript or JavaScript, this returns nothing.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve, sep } from 'node:path';
import type * as TS from 'typescript';
import { EXCLUDE } from './excludes';
import { git, isSafeRegularFile } from './gitutil';
import { type Equivalent, type Period, equivalents } from './parse';
import { splitWords } from './terms';

export interface GraphHit {
  file: string;
  line: number;
  text: string;
  why: string;
  score: number;
  usedBy: string[];
}

const ROOT_EXT = /\.(?:[cm]?[jt]sx?|json)$/;
const MAX_ROOTS = 4000;
const MAX_DEPTH = 12;
/** Numbers that convert between units (24 hours, 60 seconds, 1000 ms ...). Rarely the thing a person tunes. */
const UNIT_FACTORS = new Set([1, 7, 24, 60, 1000, 3600, 60000, 86400, 604800, 3600000, 86400000]);

const UNIT_NAME_WORDS = new Set(
  'ms milli millis millisecond milliseconds sec secs second seconds min mins minute minutes hr hrs hour hours day days week weeks month months year years per in a an one the of'.split(' '),
);

/**
 * claimcheck's own copy of the compiler. Never the target repository's: requiring a module from a
 * repository under inspection runs that repository's code, and `prepare` must only read code.
 */
export function loadTypeScript(): typeof TS | null {
  try {
    const mod = createRequire(import.meta.url)('typescript');
    const t = (mod && mod.default && mod.default.createProgram ? mod.default : mod) as typeof TS;
    return t && typeof t.createProgram === 'function' ? t : null;
  } catch {
    return null;
  }
}

interface Leaf { node: TS.Node; value: number }
interface R { v: number | string; leaves: Leaf[]; env: string[] }

const clone = (r: R): R => ({ v: r.v, leaves: [...r.leaves], env: [...r.env] });
const merge = (v: number, ...rs: R[]): R => ({ v, leaves: rs.flatMap((r) => r.leaves), env: [...new Set(rs.flatMap((r) => r.env))] });

class Folder {
  private bindings = new Map<TS.Symbol, R>();
  private seen = new Set<TS.Node>();
  constructor(private ts: typeof TS, private checker: TS.TypeChecker) {}

  sym(node: TS.Node): TS.Symbol | undefined {
    const { ts, checker } = this;
    let s = checker.getSymbolAtLocation(node);
    if (s && s.flags & ts.SymbolFlags.Alias) { try { s = checker.getAliasedSymbol(s); } catch { return undefined; } }
    return s;
  }
  declOf(s: TS.Symbol | undefined): TS.Declaration | undefined {
    return s?.valueDeclaration ?? s?.declarations?.[0];
  }

  private envName(n: TS.Node): string | null {
    const { ts } = this;
    if (ts.isPropertyAccessExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const e = n.expression;
      if (ts.isIdentifier(e.expression) && e.expression.text === 'process' && e.name.text === 'env') return n.name.text;
      if (ts.isMetaProperty(e.expression) && e.name.text === 'env') return n.name.text; // import.meta.env.X
    }
    if (ts.isElementAccessExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isStringLiteralLike(n.argumentExpression)) {
      const e = n.expression;
      if (ts.isIdentifier(e.expression) && e.expression.text === 'process' && e.name.text === 'env') return n.argumentExpression.text;
    }
    return null;
  }
  private envNames(n: TS.Node): string[] {
    const out: string[] = [];
    const walk = (x: TS.Node) => { const e = this.envName(x); if (e) out.push(e); this.ts.forEachChild(x, walk); };
    walk(n);
    return out;
  }

  /** Fold an expression to a number or numeric string. null when it cannot be known statically. */
  fold(node: TS.Node, depth = 0): R | null {
    if (depth > MAX_DEPTH) return null;
    const { ts } = this;
    try {
      return this.foldInner(node, depth, ts);
    } catch { return null; }
  }

  private num(r: R | null): R | null {
    if (!r) return null;
    if (typeof r.v === 'number') return r;
    const s = r.v.trim();
    if (s === '' || !Number.isFinite(Number(s))) return null;
    return { ...r, v: Number(s) };
  }

  private foldInner(node: TS.Node, depth: number, ts: typeof TS): R | null {
    if (ts.isNumericLiteral(node)) {
      const value = Number(node.text);
      return { v: value, leaves: [{ node, value }], env: [] };
    }
    if (ts.isStringLiteralLike(node)) {
      const n = Number(node.text.trim());
      return { v: node.text, leaves: node.text.trim() !== '' && Number.isFinite(n) ? [{ node, value: n }] : [], env: [] };
    }
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) {
      return this.fold(node.expression, depth + 1);
    }
    if (ts.isPrefixUnaryExpression(node)) {
      const a = this.num(this.fold(node.operand, depth + 1));
      if (!a) return null;
      if (node.operator === ts.SyntaxKind.MinusToken) return { ...a, v: -(a.v as number) };
      if (node.operator === ts.SyntaxKind.PlusToken) return a;
      return null;
    }
    if (ts.isConditionalExpression(node)) {
      if (this.envNames(node.condition).length) {
        const r = this.fold(node.whenFalse, depth + 1);
        return r ? { ...r, env: [...new Set([...r.env, ...this.envNames(node.condition)])] } : null;
      }
      return null;
    }
    if (ts.isBinaryExpression(node)) return this.foldBinary(node, depth, ts);
    if (ts.isIdentifier(node)) {
      const s = this.sym(node);
      if (!s) return null;
      const bound = this.bindings.get(s);
      if (bound) return clone(bound);
      return this.foldDecl(this.declOf(s), depth + 1);
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      if (this.envName(node)) return null; // an env var on its own has no known value
      return this.foldMember(node, depth);
    }
    if (ts.isCallExpression(node)) return this.foldCall(node, depth, ts);
    return null;
  }

  private foldBinary(node: TS.BinaryExpression, depth: number, ts: typeof TS): R | null {
    const op = node.operatorToken.kind;
    const K = ts.SyntaxKind;
    if (op === K.QuestionQuestionToken || op === K.BarBarToken) {
      const envs = this.envNames(node.left);
      if (envs.length) {
        const r = this.fold(node.right, depth + 1);
        return r ? { ...r, env: [...new Set([...r.env, ...envs])] } : null;
      }
      return this.fold(node.left, depth + 1);
    }
    if (op !== K.PlusToken && op !== K.MinusToken && op !== K.AsteriskToken && op !== K.SlashToken && op !== K.AsteriskAsteriskToken && op !== K.PercentToken) return null;
    const a = this.fold(node.left, depth + 1);
    const b = this.fold(node.right, depth + 1);
    if (!a || !b || typeof a.v !== 'number' || typeof b.v !== 'number') return null;
    let v: number;
    switch (op) {
      case K.PlusToken: v = a.v + b.v; break;
      case K.MinusToken: v = a.v - b.v; break;
      case K.AsteriskToken: v = a.v * b.v; break;
      case K.SlashToken: if (b.v === 0) return null; v = a.v / b.v; break;
      case K.AsteriskAsteriskToken: v = a.v ** b.v; break;
      default: if (b.v === 0) return null; v = a.v % b.v;
    }
    return Number.isFinite(v) ? merge(v, a, b) : null;
  }

  /** Follow a reference to the initializer it names. Only const-like declarations count. */
  foldDecl(decl: TS.Declaration | undefined, depth: number): R | null {
    const { ts } = this;
    if (!decl || depth > MAX_DEPTH || this.seen.has(decl)) return null;
    this.seen.add(decl);
    try {
      let init: TS.Expression | undefined;
      if (ts.isVariableDeclaration(decl)) {
        if (!(ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const)) return null;
        init = decl.initializer;
      } else if (ts.isPropertyAssignment(decl) || ts.isPropertyDeclaration(decl)) init = decl.initializer;
      else if (ts.isEnumMember(decl)) {
        if (decl.initializer) init = decl.initializer;
        else {
          const c = this.checker.getConstantValue(decl);
          return typeof c === 'number' ? { v: c, leaves: [], env: [] } : null;
        }
      } else if (ts.isShorthandPropertyAssignment(decl)) {
        return this.foldDecl(this.declOf(this.checker.getShorthandAssignmentValueSymbol(decl)), depth + 1);
      }
      return init ? this.fold(init, depth + 1) : null;
    } finally { this.seen.delete(decl); }
  }

  private objectLiteralOf(expr: TS.Node, depth = 0): TS.ObjectLiteralExpression | null {
    const { ts } = this;
    if (depth > MAX_DEPTH) return null;
    if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr) || ts.isNonNullExpression(expr)) return this.objectLiteralOf(expr.expression, depth + 1);
    if (ts.isObjectLiteralExpression(expr)) return expr;
    if (ts.isIdentifier(expr) || ts.isPropertyAccessExpression(expr)) {
      const d = this.declOf(this.sym(ts.isPropertyAccessExpression(expr) ? expr.name : expr));
      if (!d) return null;
      if ((ts.isVariableDeclaration(d) || ts.isPropertyAssignment(d) || ts.isPropertyDeclaration(d)) && d.initializer) return this.objectLiteralOf(d.initializer, depth + 1);
      if (ts.isSourceFile(d) && d.statements[0] && ts.isExpressionStatement(d.statements[0])) return this.objectLiteralOf(d.statements[0].expression, depth + 1);
    }
    return null;
  }

  private foldMember(node: TS.PropertyAccessExpression | TS.ElementAccessExpression, depth: number): R | null {
    const { ts } = this;
    let name: string | undefined;
    let s: TS.Symbol | undefined;
    if (ts.isPropertyAccessExpression(node)) { name = node.name.text; s = this.sym(node.name); }
    else if (ts.isStringLiteralLike(node.argumentExpression)) {
      name = node.argumentExpression.text;
      s = this.checker.getTypeAtLocation(node.expression).getProperty(name);
    }
    if (!name) return null;
    const viaSymbol = this.foldDecl(this.declOf(s), depth + 1);
    if (viaSymbol) return viaSymbol;
    const obj = this.objectLiteralOf(node.expression);
    if (!obj) return null;
    for (const p of obj.properties) {
      if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) && p.name.text === name) return this.fold(p.initializer, depth + 1);
    }
    return null;
  }

  private foldCall(node: TS.CallExpression, depth: number, ts: typeof TS): R | null {
    const callee = node.expression;
    const calleeName = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? `${callee.expression.getText()}.${callee.name.text}` : '';
    if (/^(Number|parseFloat|Number\.parseFloat)$/.test(calleeName) || /^(parseInt|Number\.parseInt)$/.test(calleeName)) {
      if (!node.arguments[0]) return null;
      const a = this.fold(node.arguments[0], depth + 1);
      if (!a) return null;
      const n = this.num(a);
      if (!n) return null;
      return /parseInt/.test(calleeName) ? { ...n, v: Math.trunc(n.v as number) } : n;
    }
    const math = calleeName.match(/^Math\.(floor|ceil|round|trunc|abs|min|max)$/);
    if (math) {
      const args = node.arguments.map((a) => this.num(this.fold(a, depth + 1)));
      if (args.some((a) => !a) || args.length === 0) return null;
      const vs = (args as R[]).map((a) => a.v as number);
      const fn = (Math as unknown as Record<string, (...x: number[]) => number>)[math[1]];
      return merge(fn(...vs), ...(args as R[]));
    }
    return this.foldHelper(node, depth);
  }

  /** A call to a function whose whole body is `return <expression of its parameters>`. */
  private foldHelper(node: TS.CallExpression, depth: number): R | null {
    const { ts } = this;
    const callee = node.expression;
    const decl = this.declOf(this.sym(ts.isPropertyAccessExpression(callee) ? callee.name : callee));
    if (!decl || this.seen.has(decl)) return null;
    let fn: TS.SignatureDeclaration | undefined;
    if (ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl)) fn = decl;
    else if ((ts.isVariableDeclaration(decl) || ts.isPropertyAssignment(decl) || ts.isPropertyDeclaration(decl)) && decl.initializer) {
      const i = decl.initializer;
      if (ts.isArrowFunction(i) || ts.isFunctionExpression(i)) fn = i;
    }
    if (!fn) return null;
    const body = (fn as TS.FunctionLikeDeclaration).body;
    let ret: TS.Expression | undefined;
    if (body && !ts.isBlock(body)) ret = body;
    else if (body && ts.isBlock(body) && body.statements.length === 1 && ts.isReturnStatement(body.statements[0])) ret = body.statements[0].expression;
    if (!ret) return null;
    const saved = this.bindings;
    const next = new Map(saved);
    const args: (R | null)[] = [];
    for (const a of node.arguments) args.push(this.fold(a, depth + 1));
    for (let i = 0; i < fn.parameters.length; i++) {
      const p = fn.parameters[i];
      if (!ts.isIdentifier(p.name) || p.dotDotDotToken) return null;
      const ps = this.checker.getSymbolAtLocation(p.name);
      if (!ps) return null;
      let r = args[i] ?? null;
      if (!r && p.initializer) r = this.fold(p.initializer, depth + 1);
      if (!r) return null;
      next.set(ps, r);
    }
    this.seen.add(decl);
    this.bindings = next;
    try {
      const r = this.fold(ret, depth + 1);
      return r ? { ...r, leaves: [...r.leaves] } : null;
    } finally { this.bindings = saved; this.seen.delete(decl); }
  }
}

function trackedRoots(repo: string): string[] {
  const r = git(repo, ['ls-files', '-z', '--', '.', ...EXCLUDE], { maxBuffer: 64 * 1024 * 1024 });
  const out: string[] = [];
  for (const f of (r.stdout || '').split('\0')) {
    if (!f || !ROOT_EXT.test(f) || !isSafeRegularFile(repo, f)) continue;
    try { if (statSync(join(repo, f)).size > 512 * 1024) continue; } catch { continue; }
    out.push(f);
    if (out.length >= MAX_ROOTS) break;
  }
  return out;
}

const clip = (s: string, n = 90) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

export function graphCandidates(repo: string, periods: Period[]): GraphHit[] {
  const ts = loadTypeScript();
  if (!ts || periods.length === 0) return [];
  const roots = trackedRoots(repo);
  if (!roots.some((f) => !f.endsWith('.json'))) return [];
  try {
    return run(ts, resolve(repo), roots, periods);
  } catch {
    return [];
  }
}

function run(ts: typeof TS, repo: string, roots: string[], periods: Period[]): GraphHit[] {
  const options: TS.CompilerOptions = {
    allowJs: true, checkJs: false, resolveJsonModule: true,
    moduleResolution: ts.ModuleResolutionKind.Bundler ?? ts.ModuleResolutionKind.NodeJs,
    module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, noEmit: true, skipLibCheck: true,
    noLib: true, types: [], esModuleInterop: true, allowSyntheticDefaultImports: true, jsx: ts.JsxEmit.Preserve,
    allowImportingTsExtensions: true,
  };
  const cfg = join(repo, 'tsconfig.json');
  if (existsSync(cfg)) {
    try {
      const co = ts.readConfigFile(cfg, ts.sys.readFile).config?.compilerOptions;
      if (co?.paths) { options.paths = co.paths; options.baseUrl = resolve(repo, co.baseUrl ?? '.'); }
      else if (co?.baseUrl) options.baseUrl = resolve(repo, co.baseUrl);
    } catch { /* ignore a broken tsconfig */ }
  }
  const program = ts.createProgram(roots.map((f) => join(repo, f)), options);
  const checker = program.getTypeChecker();
  const folder = new Folder(ts, checker);
  const rootSet = new Set(roots.map((f) => resolve(repo, f)));
  const rel = (sf: TS.SourceFile) => relative(repo, sf.fileName).split(sep).join('/');

  // value -> (period, equivalent) pairs it counts for
  const wanted = new Map<number, { p: Period; eq: Equivalent }[]>();
  const key = (v: number) => Math.round(v * 1e6) / 1e6;
  for (const p of periods) {
    for (const eq of equivalents(p)) {
      const list = wanted.get(key(eq.value)) ?? [];
      list.push({ p, eq });
      wanted.set(key(eq.value), list);
    }
  }

  const hits = new Map<string, GraphHit>();
  const lineOf = (n: TS.Node) => {
    const sf = n.getSourceFile();
    return { sf, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 };
  };
  const lineText = (sf: TS.SourceFile, line: number) => (sf.text.split('\n')[line - 1] ?? '').trim().slice(0, 240);
  const emit = (n: TS.Node, why: string, score: number, anchor: TS.Node) => {
    const { sf, line } = lineOf(n);
    if (!rootSet.has(resolve(sf.fileName))) return;
    const k = `${rel(sf)}:${line}`;
    const prev = hits.get(k);
    if (prev) { if (score > prev.score) { prev.score = score; prev.why = why; } return; }
    hits.set(k, { file: rel(sf), line, text: lineText(sf, line), why, score, usedBy: usesFor(anchor) });
  };

  // ---- where is a declaration used? ----
  const usedCache = new Map<TS.Node, string[]>();
  const declKinds = (n: TS.Node): n is TS.VariableDeclaration | TS.PropertyAssignment | TS.PropertyDeclaration | TS.EnumMember | TS.ParameterDeclaration =>
    ts.isVariableDeclaration(n) || ts.isPropertyAssignment(n) || ts.isPropertyDeclaration(n) || ts.isEnumMember(n) || ts.isParameter(n);
  const fnName = (f: TS.Node): string => {
    if ((ts.isFunctionDeclaration(f) || ts.isMethodDeclaration(f)) && f.name) {
      const cls = ts.isMethodDeclaration(f) && ts.isClassLike(f.parent) && f.parent.name ? `${f.parent.name.text}.` : '';
      return `${cls}${f.name.getText()}`;
    }
    const p = f.parent;
    if (p && (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) && p.name) return p.name.getText();
    return '(anonymous function)';
  };
  const at = (n: TS.Node) => { const { sf, line } = lineOf(n); return `${rel(sf)}:${line}`; };
  /** nearest enclosing function (returns its name) or, at module level, the nearest enclosing declaration */
  const enclosing = (n: TS.Node): { fn?: string; decl?: TS.Node } => {
    for (let c: TS.Node | undefined = n.parent; c; c = c.parent) {
      if (ts.isFunctionDeclaration(c) || ts.isMethodDeclaration(c) || ts.isArrowFunction(c) || ts.isFunctionExpression(c) || ts.isConstructorDeclaration(c)) {
        return { fn: ts.isConstructorDeclaration(c) ? 'constructor' : fnName(c) };
      }
      if (declKinds(c) && c !== n) return { decl: c };
    }
    return {};
  };
  function usesFor(anchor: TS.Node): string[] {
    const cached = usedCache.get(anchor);
    if (cached) return cached;
    const out: string[] = [];
    const startDecl = (() => {
      for (let c: TS.Node | undefined = anchor; c; c = c.parent) {
        if (declKinds(c)) return c;
        if (ts.isFunctionDeclaration(c) || ts.isMethodDeclaration(c) || ts.isArrowFunction(c) || ts.isFunctionExpression(c)) return null;
      }
      return undefined;
    })();
    if (startDecl === null) {
      // the literal sits inside a function body: that function is the user
      const e = enclosing(anchor);
      if (e.fn) out.push(`${e.fn} (${at(anchor)})`);
    } else if (startDecl) collectUses(startDecl, out, 0, new Set());
    usedCache.set(anchor, out);
    return out;
  }
  function collectUses(decl: TS.Node, out: string[], hop: number, done: Set<TS.Node>) {
    if (out.length >= 5 || hop > 3 || done.has(decl)) return;
    done.add(decl);
    const nameNode = (decl as TS.NamedDeclaration).name;
    if (!nameNode || !ts.isIdentifier(nameNode)) return;
    const target = folder.sym(nameNode) ?? checker.getSymbolAtLocation(nameNode);
    if (!target) return;
    const name = nameNode.text;
    for (const sf of program.getSourceFiles()) {
      if (out.length >= 5) return;
      if (!rootSet.has(resolve(sf.fileName)) || !sf.text.includes(name)) continue;
      const walk = (n: TS.Node) => {
        if (out.length >= 5) return;
        if (ts.isIdentifier(n) && n.text === name && n !== nameNode && !ts.isJsxClosingElement(n.parent)) {
          const s = folder.sym(n);
          if (s === target || (s && s.declarations?.[0] === decl)) {
            const e = enclosing(n);
            if (e.fn) { const entry = `${e.fn} (${at(n)})`; if (!out.includes(entry)) out.push(entry); }
            else if (e.decl) {
              const before = out.length;
              collectUses(e.decl, out, hop + 1, done);
              if (out.length === before) { const entry = `${(e.decl as TS.NamedDeclaration).name?.getText() ?? 'declaration'} (${at(n)})`; if (!out.includes(entry)) out.push(entry); }
            }
            else { const entry = `module scope (${at(n)})`; if (!out.includes(entry)) out.push(entry); }
          }
        }
        ts.forEachChild(n, walk);
      };
      walk(sf);
    }
  }

  // ---- report a folded value that matches the claim ----
  const describe = (v: number, m: { p: Period; eq: Equivalent }) => {
    const u = m.eq.unit === 'ms' ? 'ms' : `${m.eq.unit}${v === 1 ? '' : 's'}`;
    return `${v} ${u} = ${m.p.text}`;
  };
  const consider = (site: TS.Node, via: string, init: TS.Node, isDecl: boolean) => {
    const r = folder.fold(init);
    if (!r || typeof r.v !== 'number') return;
    const ms = wanted.get(key(r.v));
    if (!ms) return;
    // a bare literal is the text search's job; the graph is for values that are computed or inherited
    if (ts.isNumericLiteral(init) || ts.isStringLiteralLike(init)) return;
    const m = ms[0];
    const conv = r.leaves.some((l) => UNIT_FACTORS.has(l.value) && l.value > 1);
    const strong = conv || r.v >= 3600 || r.env.length > 0 || r.leaves.length > 1;
    if (!strong) return;
    const base = `evaluates to ${describe(r.v, m)} via ${clip(via)}${r.env.length ? ` (default; env ${r.env.join(', ')})` : ''}`;
    // `const MINUTE = 60 * SECOND`: the name is only unit words, so this defines a unit and is not a setting
    const declName = isDecl && (site as TS.NamedDeclaration).name ? (site as TS.NamedDeclaration).name?.getText() ?? '' : '';
    if (declName && splitWords(declName).every((w) => UNIT_NAME_WORDS.has(w))) {
      emit(site, `${base}; but its name says it only defines a unit`, 2, site);
      return;
    }
    const tunable = r.leaves.filter((l) => !UNIT_FACTORS.has(l.value));
    const pool = tunable.length ? tunable : r.leaves.filter((l) => l.value === m.p.value);
    const leaf = pool.find((l) => l.value === m.p.value) ?? pool.find((l) => wanted.has(key(l.value))) ?? pool[0];
    const siteLine = lineOf(site);
    if (leaf) {
      const ll = lineOf(leaf.node);
      const sameLine = ll.sf === siteLine.sf && ll.line === siteLine.line;
      emit(leaf.node, sameLine ? base : `${base}; the literal ${leaf.value} is what you edit`, sameLine ? 10 : 9, sameLine && isDecl ? site : leaf.node);
      if (!sameLine) emit(site, `${base}; declaration that uses it`, 4, site);
    } else {
      // Every number is a unit factor. If the site writes its own numbers (`MINUTE = 60 * SECOND`) it defines a unit
      // and says nothing about the claim's subject. A pure reference (`SWEEP = MINUTE`, `setInterval(f, MINUTE)`) is
      // the place where somebody chose that duration.
      const defines = /\d/.test(init.getText());
      emit(site, defines ? `${base}; but it only defines a unit` : base, defines ? 2 : 7, site);
    }
  };

  const isFn = (n: TS.Node) => ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n);
  const arith = new Set([ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.SlashToken, ts.SyntaxKind.AsteriskAsteriskToken]);
  const visit = (node: TS.Node, covered: boolean) => {
    let init: TS.Node | undefined;
    let via = '';
    let isDecl = false;
    if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node) || ts.isEnumMember(node) || ts.isParameter(node)) && node.initializer) {
      init = node.initializer;
      via = `${node.name.getText()} = ${init.getText()}`;
      isDecl = true;
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      init = node.right;
      via = node.getText();
      isDecl = true;
    } else if (!covered && ((ts.isBinaryExpression(node) && arith.has(node.operatorToken.kind)) || ts.isCallExpression(node)) && /\d/.test(node.getText())) {
      init = node;
      via = node.getText();
    }
    let nowCovered = covered;
    if (!covered && (ts.isCallExpression(node) || ts.isNewExpression(node)) && !(ts.isCallExpression(node) && folder.fold(node))) {
      // a duration handed to a call: `setInterval(sweep, MINUTE)`
      for (const a of node.arguments ?? []) {
        if (ts.isIdentifier(a) || ts.isPropertyAccessExpression(a)) consider(node, `${node.expression.getText()}(… ${a.getText()} …)`, a, false);
      }
    }
    if (init) {
      consider(isDecl ? node : init, via, init, isDecl);
      if (isDecl) nowCovered = true;
      else if (folder.fold(init)) nowCovered = true;
    }
    ts.forEachChild(node, (c) => visit(c, isFn(c) ? false : nowCovered));
  };

  for (const f of roots) {
    const sf = program.getSourceFile(join(repo, f));
    if (sf) visit(sf, false);
  }
  return [...hits.values()];
}
