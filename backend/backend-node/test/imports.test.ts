/** Dependency rule: core imports nothing from chat/call/moderation; chat (and call, moderation) only core. */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "../src");

function filesIn(dir: string): string[] {
  return readdirSync(path.join(SRC, dir)).filter((f) => f.endsWith(".ts")).map((f) => path.join(SRC, dir, f));
}

/** Top-level source folders (or files) imported by relative paths. */
function importedModules(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const found: string[] = [];
  for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']*)["']/g)) {
    const target = path.resolve(path.dirname(file), m[1]!);
    const rel = path.relative(SRC, target).split(path.sep);
    found.push(rel.length > 1 ? rel[0]! : "(root)");
  }
  return found;
}

describe("import boundaries", () => {
  it("core imports only core", () => {
    for (const f of filesIn("core")) {
      for (const dep of importedModules(f)) expect(["core"], `${f} imports ${dep}`).toContain(dep);
    }
  });

  for (const feature of ["chat", "call", "moderation"]) {
    it(`${feature} imports only core and itself`, () => {
      for (const f of filesIn(feature)) {
        for (const dep of importedModules(f)) expect(["core", feature], `${f} imports ${dep}`).toContain(dep);
      }
    });
  }

  it("call never imports chat; integration may import core, chat, call", () => {
    for (const f of filesIn("call")) expect(importedModules(f), f).not.toContain("chat");
    for (const f of filesIn("integration")) {
      for (const dep of importedModules(f)) expect(["core", "chat", "call", "moderation", "integration"], `${f} imports ${dep}`).toContain(dep);
    }
  });

  it("adapters import only core (and their framework)", () => {
    for (const dir of ["fastify", "express"]) {
      for (const f of filesIn(dir)) {
        for (const dep of importedModules(f)) expect(["core", dir], `${f} imports ${dep}`).toContain(dep);
      }
    }
  });

  it("core never loads fastify/express", () => {
    for (const f of filesIn("core")) expect(readFileSync(f, "utf8")).not.toMatch(/from ["'](fastify|express)["']/);
  });
});
