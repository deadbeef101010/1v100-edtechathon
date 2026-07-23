import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type AppDatabase } from "../src/db.js";
import { GameEventStore } from "../src/game-event-store.js";
import { QuestionRound } from "../src/question-round.js";
import { createAppServer } from "../src/server.js";
import { createClassroomSession, type CreatedClassroomSession } from "../src/sessions.js";
import { attachSocketGateway } from "../src/socket-gateway.js";
import { mintTeacherKey, type MintedTeacherKey } from "../src/teachers.js";
import { BotHarness } from "../tools/bots.js";

const TOKEN_SECRET = "bot-integration-secret-at-least-32-characters";
const DEV_TOKEN = "bot-integration-dev-token";

let directory: string;
let database: AppDatabase;
let teacher: MintedTeacherKey;
let classroom: CreatedClassroomSession;
let round: QuestionRound;
let rounds: Map<string, QuestionRound>;
let server: ReturnType<typeof createAppServer>;
let gateway: ReturnType<typeof attachSocketGateway>;
let harness: BotHarness | undefined;
let url: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "game-bots-"));
  database = openDatabase(join(directory, "game.db"));
  teacher = mintTeacherKey(database, "Bot Teacher");
  classroom = createClassroomSession(database, teacher.teacherId, TOKEN_SECRET, {
    codeGenerator: () => "ABC234",
  });
  round = new QuestionRound({
    sessionId: classroom.sessionId,
    store: new GameEventStore(database),
    database,
    monotonicNow: () => performance.now(),
    wallNow: () => Date.now(),
    emit: () => undefined,
  });
  rounds = new Map([[classroom.sessionId, round]]);
  server = createAppServer({
    database,
    tokenSecret: TOKEN_SECRET,
    rounds,
    devViews: true,
    devToken: DEV_TOKEN,
  });
  gateway = attachSocketGateway(server, { database, tokenSecret: TOKEN_SECRET, rounds });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP address");
  url = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  harness?.stop();
  await gateway.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  database.close();
  await rm(directory, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Bot integration condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("bot student harness", () => {
  it("joins and answers one oracle-backed real-server round with all five bots correct", async () => {
    harness = new BotHarness({
      url,
      code: classroom.code,
      count: 5,
      accuracy: 1,
      policy: "random",
      seed: 42,
      oracleToken: DEV_TOKEN,
      dropTest: true,
      latencySampler: () => 0,
      logger: () => undefined,
    });
    await harness.start();
    const joined = harness.stats();
    const playerIds = joined.map((bot) => bot.playerId).filter((id): id is string => id !== null);
    expect(playerIds).toHaveLength(5);
    expect(new Set(playerIds).size).toBe(5);

    expect(round.openQuestion({
      actorId: teacher.teacherId,
      requestId: "open-bot-round",
      attemptId: "bot-attempt",
      question: {
        id: "bot-question",
        prompt: "Which number is even?",
        choices: ["3", "4", "5", "7"],
        correctChoice: 1,
      },
      durationMs: 10_000,
      eligiblePlayerIds: playerIds,
    })).toMatchObject({ ok: true });

    expect(round.pause({
      actorId: teacher.teacherId,
      requestId: "pause-bot-round",
      attemptId: "bot-attempt",
    })).toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(harness.stats().every((bot) => bot.answered === 0)).toBe(true);
    expect(round.resume({
      actorId: teacher.teacherId,
      requestId: "resume-bot-round",
      attemptId: "bot-attempt",
    })).toMatchObject({ ok: true });

    await waitFor(() => harness?.stats().every((bot) => bot.reconnects === 1) === true);
    const restored = harness.stats();
    for (const bot of restored) {
      // The drop races the teacher's pause: a resume that lands mid-pause is
      // still a valid restore, so either open phase is acceptable here.
      expect(bot.dropSnapshot).toEqual({
        playerId: bot.playerId,
        phase: expect.stringMatching(/^(QUESTION_OPEN|PAUSED)$/),
        questionId: "bot-question",
        ownAnswer: null,
      });
    }
    await waitFor(() => harness?.stats().every((bot) => bot.answered === 1) === true);
    expect(round.phase).toBe("LOCKED");
    expect(round.reveal({
      actorId: teacher.teacherId,
      requestId: "reveal-bot-round",
      attemptId: "bot-attempt",
    })).toMatchObject({ ok: true });
    await waitFor(() => harness?.stats().every((bot) => bot.correct === 1) === true);

    const summary = harness.stats();
    expect(summary).toEqual(expect.arrayContaining(
      Array.from({ length: 5 }, (_, index) => expect.objectContaining({
        nickname: `Bot0${index + 1}`,
        joined: true,
        answered: 1,
        correct: 1,
        reconnects: 1,
        errors: 0,
      })),
    ));
    expect((await fetch(`${url}/health`)).status).toBe(200);
  });
});
