/** The framework-free `commskit/engine` entry (used by commskit-web): nothing reachable from it may import react / react-native. */
declare const __dirname: string;
const fs = require("fs");
const path = require("path");

const SRC = path.resolve(__dirname, "..", "src");
const ENTRY = path.join(SRC, "engine", "index.ts");

const specsOf = (file: string): string[] => {
  const code = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const out = new Set<string>();
  const patterns = [
    /\bimport\s+[^'"]*?from\s*["']([^"']+)["']/g,
    /\bexport\s+[^'"]*?from\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) for (const m of code.matchAll(re)) out.add(m[1] as string);
  return Array.from(out);
};

const resolveLocal = (from: string, spec: string): string | null => {
  const base = path.resolve(path.dirname(from), spec);
  for (const c of [base + ".ts", base + ".tsx", path.join(base, "index.ts")]) if (fs.existsSync(c)) return c;
  return null;
};

const reachable = (): string[] => {
  const seen = new Set<string>();
  const stack = [ENTRY];
  while (stack.length) {
    const f = stack.pop() as string;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const s of specsOf(f)) {
      if (!s.startsWith(".")) continue;
      const t = resolveLocal(f, s);
      if (t) stack.push(t);
    }
  }
  return Array.from(seen);
};

describe("commskit/engine entry", () => {
  const files = reachable();
  it("reaches the engine modules", () => {
    expect(files.length).toBeGreaterThan(15);
  });
  it("imports no react, react-native, optional native peer or require()", () => {
    const bad: string[] = [];
    for (const f of files) {
      if (f.endsWith(".tsx")) bad.push(`${path.relative(SRC, f)} is a .tsx file`);
      for (const s of specsOf(f)) if (!s.startsWith(".")) bad.push(`${path.relative(SRC, f)} -> ${s}`);
    }
    expect(bad).toEqual([]);
  });
  it("is exported from package.json", () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(SRC, "..", "package.json"), "utf8"));
    expect(pkg.exports["./engine"].default).toBe("./src/engine/index.ts");
  });
});
export {};
