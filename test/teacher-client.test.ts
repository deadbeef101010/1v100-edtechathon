import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";

type TeacherClientModule = {
  bootstrapDecision: (status: number) => { state: string; message?: string };
  projectorCredential: (
    storageValue: string | null,
    sessionId: string,
    now?: number,
  ) => { token: string; code: string | null; path: string } | null;
  sessionRowModel: (
    entry: Record<string, unknown>,
    formatDate: (value: number) => string,
  ) => {
    cells: readonly string[];
    rejoinable: boolean;
    canRotateCode: boolean;
    archived: boolean;
    canArchive: boolean;
    archiveLabel: string;
    projectorPath: string;
  };
  uploadErrorModel: (
    status: number,
    body: Record<string, unknown>,
  ) => { items: readonly string[]; statusText: string };
  deckViewModel: (deck: Record<string, unknown>) => {
    cursor: number;
    nextPrompt: string;
    rows: ReadonlyArray<Record<string, unknown>>;
  };
};

let client: TeacherClientModule;

beforeAll(async () => {
  const source = await readFile(new URL("../static/teacher-client.js", import.meta.url), "utf8");
  client = await import(`data:text/javascript,${encodeURIComponent(source)}`) as TeacherClientModule;
});

describe("teacher console client decisions", () => {
  it("uses the cookie bootstrap response as the authentication decision", () => {
    expect(client.bootstrapDecision(200)).toEqual({ state: "signed-in" });
    expect(client.bootstrapDecision(401)).toEqual({ state: "signed-out" });
    expect(client.bootstrapDecision(500)).toEqual({
      state: "error",
      message: "Could not restore your sign-in. Try again.",
    });
  });

  it("keeps legacy active sessions rejoinable and offers code rotation", () => {
    const model = client.sessionRowModel({
      session_id: "session-1",
      code: null,
      created_at_ms: 1,
      status: "live",
      player_count: 4,
    }, () => "created");

    expect(model.cells).toEqual([
      "Code unavailable (created before display-code recovery)",
      "created",
      "live",
      "4",
    ]);
    expect(model.rejoinable).toBe(true);
    expect(model.canRotateCode).toBe(true);
    expect(model.projectorPath).toBe("/projector/session-1");
  });

  it("makes ended sessions inert", () => {
    const model = client.sessionRowModel({
      session_id: "session-2",
      code: "ABC234",
      created_at_ms: 1,
      status: "ended",
      player_count: 0,
    }, () => "created");

    expect(model.rejoinable).toBe(false);
    expect(model.canRotateCode).toBe(false);
    expect(model.canArchive).toBe(true);
    expect(model.archiveLabel).toBe("Archive");
  });

  it("offers end and archive for lobbies and unarchive for hidden rows", () => {
    const lobby = client.sessionRowModel({
      session_id: "session-3",
      code: "ABC235",
      created_at_ms: 1,
      status: "lobby",
      player_count: 0,
      archived_at_ms: null,
    }, () => "created");
    const archived = client.sessionRowModel({
      session_id: "session-4",
      code: "ABC236",
      created_at_ms: 1,
      status: "ended",
      player_count: 2,
      archived_at_ms: 2,
    }, () => "created");

    expect(lobby.canArchive).toBe(true);
    expect(lobby.archiveLabel).toBe("End & archive");
    expect(archived.archived).toBe(true);
    expect(archived.rejoinable).toBe(false);
    expect(archived.canArchive).toBe(false);
  });

  it("renders row errors, generic errors, and the upload limit", () => {
    expect(client.uploadErrorModel(422, {
      errors: [{ row: 3, reason: "duplicate position" }, { row: 4, reason: "bad answer" }],
    }).items).toEqual(["Row 3: duplicate position", "Row 4: bad answer"]);
    expect(client.uploadErrorModel(400, { message: "Invalid CSV" }).items).toEqual(["Invalid CSV"]);
    expect(client.uploadErrorModel(413, {}).statusText).toBe(
      "That file is too large. Choose a CSV smaller than 256 KiB.",
    );
  });

  it("reconstructs only a valid session-scoped projector credential", () => {
    const token = "prj1.session-3.2000.nonce.signature";
    expect(client.projectorCredential(JSON.stringify({ token, code: "ABC234" }), "session-3", 1000))
      .toEqual({ token, code: "ABC234", path: "/projector/session-3" });
    expect(client.projectorCredential("broken", "session-3")).toBeNull();
    expect(client.projectorCredential('{"code":"ABC234"}', "session-3")).toBeNull();
    expect(client.projectorCredential(JSON.stringify({ token }), "another-session", 1000)).toBeNull();
    expect(client.projectorCredential(JSON.stringify({ token }), "session-3", 2000)).toBeNull();
  });

  it("models the next deck prompt and played/current rows", () => {
    expect(client.deckViewModel({
      cursor_position: 2,
      questions: [
        { position: 1, prompt: "First", played: false },
        { position: 2, prompt: "Second", played: false },
      ],
    })).toEqual({
      cursor: 2,
      nextPrompt: "Second",
      rows: [
        { position: 1, prompt: "First", played: true, current: false },
        { position: 2, prompt: "Second", played: false, current: true },
      ],
    });
    expect(client.deckViewModel({ cursor_position: 3, questions: [] }).nextPrompt).toBe("Deck finished");
  });
});
