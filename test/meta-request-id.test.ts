import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("meta request ids", () => {
  it("generates a v4 UUID when randomUUID is unavailable", async () => {
    const source = await readFile(new URL("../static/request-id.js", import.meta.url), "utf8");
    const module = await import(`data:text/javascript,${encodeURIComponent(source)}`) as {
      createRequestId: (cryptoApi: {
        randomUUID?: () => string;
        getRandomValues: (bytes: Uint8Array) => Uint8Array;
      }) => string;
    };
    let next = 0;
    const requestId = module.createRequestId({
      getRandomValues: (bytes) => {
        for (let index = 0; index < bytes.length; index += 1) bytes[index] = next++;
        return bytes;
      },
    });

    expect(requestId).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("retains separate mint, reissue, and revoke request ids across retries", async () => {
    const source = await readFile(
      new URL("../static/request-id-retainer.js", import.meta.url),
      "utf8",
    );
    const module = await import(`data:text/javascript,${encodeURIComponent(source)}`) as {
      createRequestIdRetainer: (
        createRequestId: () => string,
      ) => { current: () => string; reset: () => string; clear: () => void };
    };
    let next = 0;
    const mint = module.createRequestIdRetainer(() => `request-${next++}`);
    const reissue = module.createRequestIdRetainer(() => `request-${next++}`);
    const revoke = module.createRequestIdRetainer(() => `request-${next++}`);

    expect(mint.current()).toBe("request-0");
    expect(mint.current()).toBe("request-0");
    expect(reissue.current()).toBe("request-1");
    expect(reissue.current()).toBe("request-1");
    expect(revoke.current()).toBe("request-2");
    expect(revoke.current()).toBe("request-2");
    mint.clear();
    expect(mint.current()).toBe("request-3");
    expect(reissue.current()).toBe("request-1");
    expect(revoke.current()).toBe("request-2");
    expect(revoke.reset()).toBe("request-4");
    expect(revoke.current()).toBe("request-4");
  });
});
