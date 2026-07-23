import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type AppDatabase } from "../src/db.js";
import { buildLeaderboard } from "../src/leaderboard.js";
import { GameEventStore } from "../src/game-event-store.js";
import { QuestionRound, type LeaderboardBroadcast } from "../src/question-round.js";
import { createClassroomSession } from "../src/sessions.js";
import { mintTeacherKey } from "../src/teachers.js";

const SECRET = "leaderboard-secret-at-least-32-characters";
let directory: string;
let database: AppDatabase;
let sessionId: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "game-leaderboard-"));
  database = openDatabase(join(directory, "game.db"));
  const teacher = mintTeacherKey(database, "Leaderboard Teacher");
  sessionId = createClassroomSession(database, teacher.teacherId, SECRET).sessionId;
});

afterEach(async () => {
  database.close();
  await rm(directory, { recursive: true, force: true });
});

function player(id: string, nickname: string, points: number, joined: number): void {
  database
    .prepare(
      `INSERT INTO session_players
        (player_id, session_id, nickname, nickname_norm, token_hash,
         token_expires_at_ms, role, points, joined_at_ms, last_seen_at_ms)
       VALUES (?, ?, ?, ?, ?, 99999, 'mob', ?, ?, ?)`,
    )
    .run(id, sessionId, nickname, nickname.toLowerCase(), Buffer.from(id), points, joined, joined);
}

describe("session leaderboard", () => {
  it("uses join order to break point ties into deterministic competition positions", () => {
    player("p-late", "Blake", 30, 2);
    player("p-early", "Avery", 30, 1);
    player("p-third", "Casey", 10, 3);

    expect(buildLeaderboard(database, sessionId, new Set(["p-third"]))).toEqual({
      scope: "session",
      rows: [
        { rank: 1, player_id: "p-early", nickname: "Avery", points: 30, connected: false },
        { rank: 2, player_id: "p-late", nickname: "Blake", points: 30, connected: false },
        { rank: 3, player_id: "p-third", nickname: "Casey", points: 10, connected: true },
      ],
    });
  });

  it("does not change order or rank when a player reconnects", () => {
    player("p-1", "Avery", 20, 1);
    player("p-2", "Blake", 10, 2);
    const disconnected = buildLeaderboard(database, sessionId, new Set());

    const reconnected = buildLeaderboard(database, sessionId, new Set(["p-2"]));

    expect(reconnected.rows.map((row) => ({ ...row, connected: false }))).toEqual(
      disconnected.rows,
    );
    expect(reconnected.rows[1]?.connected).toBe(true);
  });

  it("emits the leaderboard immediately after reveal", () => {
    player("p-1", "Avery", 20, 1);
    const emitted: LeaderboardBroadcast[] = [];
    let now = 0;
    const round = new QuestionRound({
      sessionId,
      store: new GameEventStore(database),
      database,
      monotonicNow: () => now,
      wallNow: () => now,
      connectedPlayerIds: () => new Set(["p-1"]),
      emit: (event) => {
        if (event.type === "leaderboard") emitted.push(event);
      },
    });
    round.openQuestion({
      actorId: "teacher",
      requestId: "open",
      attemptId: "attempt",
      question: { id: "q", prompt: "Q", choices: ["A", "B", "C"], correctChoice: 0 },
      durationMs: 10,
      eligiblePlayerIds: ["p-1"],
    });
    round.answer({
      actorId: "p-1",
      requestId: "answer",
      attemptId: "attempt",
      questionId: "q",
      choice: 0,
    });
    now = 11;

    round.reveal({ actorId: "teacher", requestId: "reveal", attemptId: "attempt" });

    expect(emitted).toEqual([
      {
        type: "leaderboard",
        serverSeq: 4,
        payload: {
          scope: "session",
          rows: [
            { rank: 1, player_id: "p-1", nickname: "Avery", points: 30, connected: true },
          ],
          server_time_ms: 11,
          deadline_ms: null,
        },
      },
    ]);
  });
});
