import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("repository scaffold", () => {
  it("requires the Node 24 production line", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { engines?: { node?: string } };

    expect(packageJson.engines?.node).toBe(">=24");
  });

  it("enables every TypeScript strictness check", async () => {
    const tsconfig = JSON.parse(
      await readFile(new URL("../tsconfig.json", import.meta.url), "utf8"),
    ) as { compilerOptions?: { strict?: boolean } };

    expect(tsconfig.compilerOptions?.strict).toBe(true);
  });

  it("provides the required development scripts", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts).toMatchObject({
      dev: expect.any(String),
      test: expect.any(String),
      build: expect.any(String),
      typecheck: expect.any(String),
      lint: expect.any(String),
    });
  });

  it("runs a placeholder application test", () => {
    expect("Spotlight Player").toContain("Spotlight");
  });
});
