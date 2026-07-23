import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAppServer } from "../src/server.js";

const servers: Array<ReturnType<typeof createAppServer>> = [];
const scratchDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(
    scratchDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function listen(): Promise<{ baseUrl: string }> {
  const server = createAppServer();
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP listener");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}` };
}

describe("HTTP server", () => {
  it("reports versioned process health on an ephemeral port", async () => {
    const { baseUrl } = await listen();

    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      version: expect.any(String),
      uptime_s: expect.any(Number),
    });
  });

  it("serves the static index with an HTML content type", async () => {
    const { baseUrl } = await listen();

    const response = await fetch(`${baseUrl}/static/index.html`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/html/);
    expect(await response.text()).toContain("1 vs 100");
  });

  it("serves the landing page at the root path", async () => {
    const { baseUrl } = await listen();

    const response = await fetch(`${baseUrl}/`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/html/);
    expect(await response.text()).toContain("1 vs 100");
  });

  it("exits cleanly within three seconds on SIGTERM with a keepalive client", async () => {
    const scratchDirectory = await mkdtemp(join(tmpdir(), "1v100-http-"));
    scratchDirectories.push(scratchDirectory);
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/server.ts"],
      {
        cwd: new URL("..", import.meta.url),
        env: {
          ...process.env,
          HOST: "127.0.0.1",
          PORT: "0",
          DB_PATH: join(scratchDirectory, "game.db"),
          TOKEN_SECRET: Buffer.from(
            Array.from({ length: 32 }, (_, index) => index),
          ).toString("hex"),
          META_KEY_HASH: "a".repeat(64),
          BASE_URL: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("server did not start")), 2_000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        const match = /"port":(\d+)/.exec(chunk);
        if (match?.[1] !== undefined) {
          clearTimeout(timeout);
          resolve(Number(match[1]));
        }
      });
      child.once("error", reject);
      child.once("exit", (code) =>
        reject(new Error(`server exited early: ${String(code)} ${stderr}`)),
      );
    });

    const socket = connect(port, "127.0.0.1");
    await once(socket, "connect");
    socket.write("GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n");
    await once(socket, "data");

    const startedAt = performance.now();
    child.kill("SIGTERM");
    const [exitCode, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];

    expect(exitCode).toBe(0);
    expect(signal).toBeNull();
    expect(performance.now() - startedAt).toBeLessThan(3_000);
    socket.destroy();
  }, 5_000);
});
