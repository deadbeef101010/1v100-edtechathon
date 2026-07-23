import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

// Regression guard for parallel-lane styles.css merges: an unclosed block
// silently disables every rule after it (CSS nesting swallows the rest of
// the sheet), which shipped once as an inert teacher cockpit. Comments are
// stripped so decorative braces cannot skew the count.
describe("styles.css integrity", () => {
  it("has balanced braces so no merged section is swallowed", async () => {
    const source = await readFile(new URL("../static/styles.css", import.meta.url), "utf8");
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
    let depth = 0;
    let line = 1;
    for (const character of withoutComments) {
      if (character === "\n") line += 1;
      if (character === "{") depth += 1;
      if (character === "}") {
        depth -= 1;
        expect(depth, `unexpected '}' near line ${line}`).toBeGreaterThanOrEqual(0);
      }
    }
    expect(depth, "unclosed block: '{' without matching '}'").toBe(0);
  });
});
