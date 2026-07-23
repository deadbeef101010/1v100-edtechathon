import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ESLint } from "eslint";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("emitter lint boundary", () => {
  it("rejects a direct emit fixture outside emitter.ts", async () => {
    const directory = await mkdtemp(join(new URL(".", import.meta.url).pathname, "emitter-lint-"));
    directories.push(directory);
    const fixture = join(directory, "direct-emit.ts");
    await writeFile(fixture, "export function leak(socket: { emit(name: string): void }) { socket.emit('leak'); }\n");
    const eslint = new ESLint({ cwd: new URL("..", import.meta.url).pathname });
    const [result] = await eslint.lintFiles([fixture]);

    expect(result?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "Route outbound application packets through src/emitter.ts" }),
    ]));
  });
});
