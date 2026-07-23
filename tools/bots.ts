import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { io, type Socket } from "socket.io-client";

export type RandomSource = () => number;

export type BotQuestion = Readonly<{
  attempt_id: string;
  question_id: string;
  prompt: string;
  choices: readonly string[];
  server_time_ms: number;
  deadline_ms: number;
}>;

export type PolicyContext = Readonly<{
  question: BotQuestion;
  sessionId: string;
  random: RandomSource;
  signal: AbortSignal;
}>;

export type AnswerPolicy = Readonly<{
  name: "random" | "llm";
  choose: (context: PolicyContext) => Promise<number>;
}>;

export type BotStats = Readonly<{
  nickname: string;
  playerId: string | null;
  joined: boolean;
  answered: number;
  correct: number;
  reconnects: number;
  errors: number;
  dropSnapshot: Readonly<{
    playerId: string;
    phase: string;
    questionId: string | null;
    ownAnswer: number | null;
  }> | null;
}>;

export type BotHarnessOptions = Readonly<{
  url: string;
  code: string;
  count: number;
  accuracy: number;
  policy?: "random" | "llm";
  model?: string;
  seed?: number;
  oracleToken?: string;
  dropTest?: boolean;
  gatewayBaseUrl?: string;
  openAiApiKey?: string;
  logger?: (line: string) => void;
  latencySampler?: (random: RandomSource, maximumMs: number) => number;
  fetchImpl?: typeof fetch;
}>;

type JoinAck = Readonly<{
  ok?: boolean;
  code?: string;
  message?: string;
  suggestion?: string;
  player_id?: string;
  token?: string;
  session_id?: string;
}>;

type RoundSnapshot = Readonly<{
  phase: string;
  attempt_id: string | null;
  question: Readonly<{
    question_id: string;
    prompt: string;
    choices: readonly string[];
  }> | null;
  own_answer: number | null;
  server_time_ms: number;
  deadline_ms: number | null;
}>;

type ResumeAck = Readonly<{
  ok?: boolean;
  code?: string;
  player_id?: string;
  session_id?: string;
  snapshot?: RoundSnapshot;
}>;

type AnswerAck = Readonly<{
  ok?: boolean;
  code?: string;
  message?: string;
  server_time_ms?: number;
  deadline_ms?: number | null;
}>;

type PhasePacket = Readonly<{
  phase: string;
  server_time_ms: number;
  deadline_ms: number | null;
}>;

type RevealPacket = Readonly<{
  attempt_id: string;
  question_id: string;
  correct_choice: number;
  outcomes: readonly Readonly<{ player_id: string; correct: boolean }>[];
}>;

type OracleResult = Readonly<{ question_id: string; correct_choice: number }>;

const DEFAULT_GATEWAY_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4.1-mini";
const ANSWER_DEADLINE_MARGIN_MS = 150;
const ACK_TIMEOUT_MS = 5_000;
const ORACLE_TIMEOUT_MS = 3_000;
const RECONNECT_DELAYS_MS = [0, 250, 750, 1_500, 3_000, 5_000, 7_000, 10_000] as const;

export function createSeededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function sampleHumanLatencyMs(
  random: RandomSource,
  maximumMs = Number.POSITIVE_INFINITY,
): number {
  const first = Math.max(Number.EPSILON, random());
  const second = random();
  const normal = Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
  const logNormal = Math.exp(Math.log(4_000) + 0.45 * normal);
  if (maximumMs <= 0) return 0;
  return Math.max(1, Math.min(Math.max(2_000, Math.round(logNormal)), 8_000, maximumMs));
}

export function chooseRandomAnswer(
  choiceCount: number,
  accuracy: number,
  correctChoice: number | null,
  random: RandomSource,
): number {
  if (!Number.isInteger(choiceCount) || choiceCount < 1) {
    throw new Error("A question must have at least one choice");
  }
  if (correctChoice === null) {
    return Math.min(choiceCount - 1, Math.floor(random() * choiceCount));
  }
  if (random() < accuracy || choiceCount === 1) {
    return correctChoice;
  }
  const wrong = Math.min(choiceCount - 2, Math.floor(random() * (choiceCount - 1)));
  return wrong >= correctChoice ? wrong + 1 : wrong;
}

export function createRandomPolicy(options: Readonly<{
  accuracy: number;
  oracle?: (sessionId: string, questionId: string, signal: AbortSignal) => Promise<number | null>;
  onFallback?: () => void;
}>): AnswerPolicy {
  return Object.freeze({
    name: "random" as const,
    choose: async (context: PolicyContext): Promise<number> => {
      const correctChoice = options.oracle === undefined
        ? null
        : await options.oracle(context.sessionId, context.question.question_id, context.signal);
      if (correctChoice === null) {
        options.onFallback?.();
      }
      return chooseRandomAnswer(
        context.question.choices.length,
        options.accuracy,
        correctChoice,
        context.random,
      );
    },
  });
}

function chatCompletionUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

function completionContent(value: unknown): string {
  if (typeof value !== "object" || value === null || !("choices" in value)) {
    throw new Error("LLM response did not contain choices");
  }
  const choices = (value as { choices: unknown }).choices;
  if (!Array.isArray(choices)) {
    throw new Error("LLM response choices were invalid");
  }
  const first = choices[0];
  if (typeof first !== "object" || first === null || !("message" in first)) {
    throw new Error("LLM response did not contain a message");
  }
  const message = (first as { message: unknown }).message;
  if (typeof message !== "object" || message === null || !("content" in message)) {
    throw new Error("LLM response did not contain message content");
  }
  const content = (message as { content: unknown }).content;
  if (typeof content !== "string") {
    throw new Error("LLM response content was not text");
  }
  return content;
}

export function parseLlmChoice(content: string, choiceCount: number): number {
  const numeric = /(?:^|\D)(\d+)(?:\D|$)/.exec(content)?.[1];
  if (numeric !== undefined) {
    const choice = Number(numeric);
    if (Number.isInteger(choice) && choice >= 0 && choice < choiceCount) {
      return choice;
    }
  }
  const letter = /(?:^|\W)([A-Z])(?:\W|$)/i.exec(content)?.[1];
  if (letter !== undefined) {
    const choice = letter.toUpperCase().charCodeAt(0) - 65;
    if (choice >= 0 && choice < choiceCount) {
      return choice;
    }
  }
  throw new Error(`LLM returned no valid choice: ${content.slice(0, 80)}`);
}

export function createLlmPolicy(options: Readonly<{
  model: string;
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}>): AnswerPolicy {
  const fetchImpl = options.fetchImpl ?? fetch;
  return Object.freeze({
    name: "llm" as const,
    choose: async ({ question, signal }: PolicyContext): Promise<number> => {
      const response = await fetchImpl(chatCompletionUrl(options.baseUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: options.model,
          messages: [
            {
              role: "system",
              content: "Answer the multiple-choice question. Return only the zero-based choice number.",
            },
            {
              role: "user",
              content: `${question.prompt}\n${question.choices.map((choice, index) => `${index}: ${choice}`).join("\n")}`,
            },
          ],
        }),
        signal,
      });
      if (!response.ok) {
        throw new Error(`LLM gateway returned HTTP ${response.status}`);
      }
      return parseLlmChoice(completionContent(await response.json()), question.choices.length);
    },
  });
}

class OracleClient {
  readonly #url: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  available = true;

  constructor(url: string, token: string, fetchImpl: typeof fetch) {
    this.#url = url;
    this.#token = token;
    this.#fetch = fetchImpl;
  }

  async answer(sessionId: string, questionId: string, signal: AbortSignal): Promise<number | null> {
    try {
      const endpoint = new URL(`/api/dev/session/${sessionId}/oracle`, this.#url);
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(ORACLE_TIMEOUT_MS)]);
      const response = await this.#fetch(endpoint, {
        headers: { "x-dev-token": this.#token },
        signal: requestSignal,
      });
      if (!response.ok) {
        this.available = false;
        return null;
      }
      const result = await response.json() as OracleResult;
      if (
        result.question_id !== questionId ||
        !Number.isInteger(result.correct_choice)
      ) {
        this.available = false;
        return null;
      }
      return result.correct_choice;
    } catch {
      this.available = false;
      return null;
    }
  }
}

function isQuestionPacket(value: unknown): value is BotQuestion {
  if (typeof value !== "object" || value === null) return false;
  const packet = value as Record<string, unknown>;
  return (
    typeof packet.attempt_id === "string" &&
    typeof packet.question_id === "string" &&
    typeof packet.prompt === "string" &&
    Array.isArray(packet.choices) &&
    packet.choices.every((choice) => typeof choice === "string") &&
    typeof packet.server_time_ms === "number" &&
    typeof packet.deadline_ms === "number"
  );
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

async function emitAck<T>(socket: Socket, event: string, payload: unknown): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    socket.timeout(ACK_TIMEOUT_MS).emit(event, payload, (error: Error | null, response: T) => {
      if (error !== null) reject(error);
      else resolve(response);
    });
  });
}

class BotStudent {
  readonly #url: string;
  readonly #code: string;
  #nickname: string;
  readonly #random: RandomSource;
  readonly #policy: AnswerPolicy;
  readonly #dropTest: boolean;
  readonly #logger: (line: string) => void;
  readonly #latencySampler: (random: RandomSource, maximumMs: number) => number;
  readonly #signal: AbortSignal;
  readonly #onSessionEnded: () => void;
  readonly #answeredAttempts = new Set<string>();
  readonly #questionControllers = new Map<string, AbortController>();
  readonly #revealedQuestions = new Set<string>();
  #socket: Socket | null = null;
  #token: string | null = null;
  #sessionId: string | null = null;
  #playerId: string | null = null;
  #ready = false;
  #readyWaiters = new Set<() => void>();
  #phaseWaiters = new Set<() => void>();
  #phase = "LOBBY";
  #activeQuestion: BotQuestion | null = null;
  #questionTask: Promise<void> | null = null;
  #pendingQuestion: BotQuestion | null = null;
  #clockOffsetMs = 0;
  #dropPerformed = false;
  #joined = false;
  #answered = 0;
  #correct = 0;
  #reconnects = 0;
  #errors = 0;
  #dropSnapshot: BotStats["dropSnapshot"] = null;
  #lastResume: ResumeAck | null = null;
  #resumeWaiters = new Set<(acknowledgement: ResumeAck) => void>();
  #reconnectTask: Promise<void> | null = null;
  #resuming = false;
  #starting = false;

  constructor(options: Readonly<{
    url: string;
    code: string;
    nickname: string;
    random: RandomSource;
    policy: AnswerPolicy;
    dropTest: boolean;
    logger: (line: string) => void;
    latencySampler: (random: RandomSource, maximumMs: number) => number;
    signal: AbortSignal;
    onSessionEnded: () => void;
  }>) {
    this.#url = options.url;
    this.#code = options.code;
    this.#nickname = options.nickname;
    this.#random = options.random;
    this.#policy = options.policy;
    this.#dropTest = options.dropTest;
    this.#logger = options.logger;
    this.#latencySampler = options.latencySampler;
    this.#signal = options.signal;
    this.#onSessionEnded = options.onSessionEnded;
  }

  stats(): BotStats {
    return Object.freeze({
      nickname: this.#nickname,
      playerId: this.#playerId,
      joined: this.#joined,
      answered: this.#answered,
      correct: this.#correct,
      reconnects: this.#reconnects,
      errors: this.#errors,
      dropSnapshot: this.#dropSnapshot,
    });
  }

  async start(): Promise<void> {
    this.#starting = true;
    try {
      const payload = {
        code: this.#code,
        nickname: this.#nickname,
        request_id: randomUUID(),
        client_instance_id: randomUUID(),
      };
      let joined: JoinAck | null = null;
      for (let attempt = 0; attempt < 3 && joined === null; attempt += 1) {
        const socket = this.#socket?.connected === true ? this.#socket : this.#replaceSocket();
        try {
          await this.#waitForConnect(socket);
          joined = await emitAck<JoinAck>(socket, "join_session", payload);
        } catch (error) {
          if (attempt === 2) throw error;
          if (!socket.connected && this.#socket === socket) socket.disconnect();
          await this.#waitWithDeadline(200 * 2 ** attempt);
        }
      }
      if (joined === null) throw new Error("join acknowledgement timed out");
      if (joined.ok === false && joined.code === "NICKNAME_TAKEN" && typeof joined.suggestion === "string") {
        // Leftover identities from earlier runs hold the default names; adopt
        // the server's suggested free nickname and retry once.
        this.#nickname = joined.suggestion;
        const retryPayload = { ...payload, nickname: joined.suggestion, request_id: randomUUID() };
        const socket = this.#socket?.connected === true ? this.#socket : this.#replaceSocket();
        await this.#waitForConnect(socket);
        joined = await emitAck<JoinAck>(socket, "join_session", retryPayload);
      }
      if (joined.ok === false || joined.player_id === undefined || joined.token === undefined || joined.session_id === undefined) {
        throw new Error(joined.message ?? joined.code ?? "join failed");
      }
      this.#playerId = joined.player_id;
      this.#token = joined.token;
      this.#sessionId = joined.session_id;
      this.#joined = true;
      this.#markReady();
      this.#log(`joined player=${joined.player_id.slice(0, 8)}`);
      const pending = this.#pendingQuestion;
      this.#pendingQuestion = null;
      if (pending !== null) this.#receiveQuestion(pending);
    } catch (error) {
      this.#recordError(`start ${errorMessage(error)}`);
      throw error;
    } finally {
      this.#starting = false;
    }
  }

  stop(): void {
    for (const controller of this.#questionControllers.values()) controller.abort();
    this.#questionControllers.clear();
    this.#socket?.disconnect();
    this.#socket = null;
    this.#ready = false;
    this.#resolveReadyWaiters();
    this.#resolvePhaseWaiters();
  }

  #replaceSocket(): Socket {
    const socket = io(this.#url, {
      autoConnect: false,
      forceNew: true,
      reconnection: false,
      transports: ["polling", "websocket"],
    });
    this.#socket = socket;
    socket.on("connect", () => {
      if (this.#token !== null) void this.#resume(socket);
    });
    socket.on("disconnect", (reason) => {
      if (this.#socket !== socket) return;
      this.#ready = false;
      if (this.#token !== null && reason !== "io client disconnect" && !this.#signal.aborted) {
        this.#scheduleReconnect();
      }
    });
    socket.on("connect_error", (error) => {
      if (this.#socket !== socket || this.#signal.aborted) return;
      this.#log(`connect retry=${error.message}`);
      if (this.#starting) return;
      socket.disconnect();
      this.#scheduleReconnect();
    });
    socket.on("question_open", (packet: unknown) => this.#receiveQuestion(packet));
    socket.on("phase_state", (packet: unknown) => this.#receivePhase(packet));
    socket.on("phase_a_locked", (packet: unknown) => this.#receiveLocked(packet));
    socket.on("reveal", (packet: RevealPacket) => this.#receiveReveal(packet));
    socket.on("session_ended", () => {
      this.#log("session ended");
      this.#onSessionEnded();
    });
    socket.connect();
    return socket;
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTask !== null || this.#signal.aborted) return;
    this.#reconnectTask = this.#reconnect().finally(() => {
      this.#reconnectTask = null;
    });
  }

  async #reconnect(): Promise<void> {
    try {
      for (const waitMs of RECONNECT_DELAYS_MS) {
        if (this.#signal.aborted || this.#ready) return;
        if (waitMs > 0) await delay(waitMs, undefined, { signal: this.#signal });
        const socket = this.#replaceSocket();
        try {
          await this.#waitForConnect(socket);
          await this.#waitUntilReady(ACK_TIMEOUT_MS + 500);
          return;
        } catch (error) {
          if (this.#socket === socket) socket.disconnect();
          if (!this.#signal.aborted) this.#log(`reconnect retry=${errorMessage(error)}`);
        }
      }
      if (!this.#signal.aborted) this.#recordError("reconnect attempts exhausted");
    } catch (error) {
      if (!this.#signal.aborted) this.#recordError(`reconnect ${errorMessage(error)}`);
    }
  }

  async #waitForConnect(socket: Socket): Promise<void> {
    if (socket.connected) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("connection timed out"));
      }, 10_000);
      const cleanup = (): void => {
        clearTimeout(timeout);
        socket.off("connect", connected);
        socket.off("connect_error", failed);
      };
      const connected = (): void => {
        cleanup();
        resolve();
      };
      const failed = (error: Error): void => {
        cleanup();
        reject(error);
      };
      socket.once("connect", connected);
      socket.once("connect_error", failed);
    });
  }

  async #resume(socket: Socket): Promise<void> {
    const token = this.#token;
    const sessionId = this.#sessionId;
    if (token === null || sessionId === null || socket !== this.#socket || this.#resuming) return;
    this.#resuming = true;
    try {
      const resumed = await emitAck<ResumeAck>(socket, "resume", {
        token,
        session_id: sessionId,
        request_id: randomUUID(),
        client_instance_id: randomUUID(),
      });
      if (resumed.ok !== true || resumed.player_id !== this.#playerId) {
        throw new Error(resumed.code ?? "resume identity mismatch");
      }
      this.#lastResume = resumed;
      for (const resolve of this.#resumeWaiters) resolve(resumed);
      this.#resumeWaiters.clear();
      this.#reconnects += 1;
      this.#log(`resumed phase=${resumed.snapshot?.phase ?? "unknown"}`);
      if (resumed.snapshot !== undefined) this.#receiveSnapshot(resumed.snapshot);
      this.#markReady();
    } catch (error) {
      if (this.#socket === socket) socket.disconnect();
      if (!this.#signal.aborted) {
        this.#log(`resume retry=${errorMessage(error)}`);
      }
    } finally {
      this.#resuming = false;
      if (!this.#signal.aborted && !this.#ready) this.#scheduleReconnect();
    }
  }

  #receiveSnapshot(snapshot: RoundSnapshot): void {
    this.#observeTime(snapshot.server_time_ms);
    this.#phase = snapshot.phase;
    this.#resolvePhaseWaiters();
    if (
      snapshot.phase !== "QUESTION_OPEN" ||
      snapshot.question === null ||
      snapshot.attempt_id === null ||
      snapshot.deadline_ms === null ||
      snapshot.own_answer !== null
    ) {
      if (snapshot.attempt_id !== null && snapshot.own_answer !== null) {
        this.#answeredAttempts.add(snapshot.attempt_id);
      }
      return;
    }
    const question = {
      ...snapshot.question,
      attempt_id: snapshot.attempt_id,
      server_time_ms: snapshot.server_time_ms,
      deadline_ms: snapshot.deadline_ms,
    };
    this.#activeQuestion = question;
    this.#receiveQuestion(question);
  }

  #receiveQuestion(value: unknown): void {
    if (!isQuestionPacket(value) || this.#answeredAttempts.has(value.attempt_id)) return;
    this.#observeTime(value.server_time_ms);
    this.#phase = "QUESTION_OPEN";
    this.#activeQuestion = value;
    this.#resolvePhaseWaiters();
    if (this.#sessionId === null) {
      this.#pendingQuestion = value;
      return;
    }
    this.#startQuestionTask();
  }

  #receivePhase(value: unknown): void {
    if (typeof value !== "object" || value === null) return;
    const packet = value as Partial<PhasePacket>;
    if (typeof packet.phase !== "string" || typeof packet.server_time_ms !== "number") return;
    this.#observeTime(packet.server_time_ms);
    this.#phase = packet.phase;
    if (packet.phase === "QUESTION_OPEN" && typeof packet.deadline_ms === "number" && this.#activeQuestion !== null) {
      this.#activeQuestion = { ...this.#activeQuestion, server_time_ms: packet.server_time_ms, deadline_ms: packet.deadline_ms };
    }
    this.#resolvePhaseWaiters();
    if (packet.phase === "QUESTION_OPEN") this.#startQuestionTask();
  }

  #receiveLocked(value: unknown): void {
    if (typeof value === "object" && value !== null) {
      const packet = value as Record<string, unknown>;
      if (typeof packet.server_time_ms === "number") this.#observeTime(packet.server_time_ms);
    }
    this.#phase = "LOCKED";
    this.#resolvePhaseWaiters();
  }

  #startQuestionTask(): void {
    if (this.#questionTask !== null || this.#activeQuestion === null) return;
    const question = this.#activeQuestion;
    const controller = new AbortController();
    this.#questionControllers.set(question.attempt_id, controller);
    this.#questionTask = this.#answerQuestion(question, controller.signal)
      .catch((error: unknown) => {
        if (!this.#signal.aborted && !controller.signal.aborted && this.#phase !== "PAUSED") {
          this.#recordError(`question ${errorMessage(error)}`);
        }
      })
      .finally(() => {
        this.#questionControllers.delete(question.attempt_id);
        this.#questionTask = null;
        if (
          !this.#answeredAttempts.has(question.attempt_id) &&
          this.#activeQuestion?.attempt_id === question.attempt_id &&
          this.#phase === "QUESTION_OPEN" &&
          this.#estimatedServerNow() < this.#activeQuestion.deadline_ms - ANSWER_DEADLINE_MARGIN_MS
        ) {
          this.#startQuestionTask();
        }
      });
  }

  async #answerQuestion(initialQuestion: BotQuestion, questionSignal: AbortSignal): Promise<void> {
    const sessionId = this.#sessionId;
    if (sessionId === null) throw new Error("question arrived before join completed");
    const startedAt = Date.now();
    let question = initialQuestion;
    const remainingMs = question.deadline_ms - this.#estimatedServerNow();
    if (remainingMs <= ANSWER_DEADLINE_MARGIN_MS) {
      this.#log(`skipped q=${question.question_id} reason=deadline`);
      return;
    }
    const artificialLatency = this.#policy.name === "random"
      ? this.#latencySampler(this.#random, remainingMs - ANSWER_DEADLINE_MARGIN_MS)
      : 0;
    const policySignal = AbortSignal.any([
      this.#signal,
      questionSignal,
      AbortSignal.timeout(Math.max(1, remainingMs - ANSWER_DEADLINE_MARGIN_MS)),
    ]);
    const choice = await this.#policy.choose({
      question,
      sessionId,
      random: this.#random,
      signal: policySignal,
    });
    const waitMs = artificialLatency - (Date.now() - startedAt);
    if (waitMs > 0) await delay(waitMs, undefined, { signal: policySignal });
    if (this.#dropTest && !this.#dropPerformed) {
      await this.#forceDrop(question.question_id, null);
      if (this.#answeredAttempts.has(question.attempt_id)) return;
    }
    let requestId = randomUUID();
    for (let attempt = 0; !this.#signal.aborted; attempt += 1) {
      question = this.#activeQuestion?.attempt_id === question.attempt_id ? this.#activeQuestion : question;
      if (this.#estimatedServerNow() >= question.deadline_ms - ANSWER_DEADLINE_MARGIN_MS) {
        this.#log(`skipped q=${question.question_id} reason=deadline`);
        return;
      }
      if (this.#phase !== "QUESTION_OPEN") {
        if (this.#phase !== "PAUSED") return;
        // A pause normally ends with a phase_state broadcast, but a socket
        // that dropped mid-pause can miss it entirely, leaving the local
        // phase stale forever. Wait briefly for the broadcast, then fall
        // through and probe the server: answer_submit acknowledges with
        // WRONG_PHASE while the pause is real, which re-enters this wait.
        await this.#waitForPhaseChange();
        if (this.#phase !== "PAUSED") continue;
      }
      await this.#waitUntilReady();
      question = this.#activeQuestion?.attempt_id === question.attempt_id ? this.#activeQuestion : question;
      if (this.#estimatedServerNow() >= question.deadline_ms - ANSWER_DEADLINE_MARGIN_MS) {
        this.#log(`skipped q=${question.question_id} reason=deadline`);
        return;
      }
      const socket = this.#socket;
      if (socket === null) throw new Error("socket stopped");
      let acknowledgement: AnswerAck;
      try {
        acknowledgement = await emitAck<AnswerAck>(socket, "answer_submit", {
          request_id: requestId,
          attempt_id: question.attempt_id,
          question_id: question.question_id,
          choice,
        });
      } catch {
        if (!socket.connected || this.#socket !== socket) {
          await this.#waitUntilReady();
        } else {
          await this.#waitWithDeadline(Math.min(1_000, 150 * 2 ** Math.min(attempt, 3)), question);
        }
        continue;
      }
      if (acknowledgement.server_time_ms !== undefined) this.#observeTime(acknowledgement.server_time_ms);
      if (typeof acknowledgement.deadline_ms === "number") {
        question = { ...question, server_time_ms: acknowledgement.server_time_ms ?? this.#estimatedServerNow(), deadline_ms: acknowledgement.deadline_ms };
        this.#activeQuestion = question;
      }
      if (acknowledgement.ok === true) {
        this.#answeredAttempts.add(question.attempt_id);
        this.#answered += 1;
        this.#log(`answered q=${question.question_id} choice=${choice}`);
        return;
      }
      if (acknowledgement.code === "ALREADY_ANSWERED") {
        this.#answeredAttempts.add(question.attempt_id);
        this.#answered += 1;
        this.#log(`answered q=${question.question_id} choice=restored`);
        return;
      }
      if (acknowledgement.code === "WRONG_PHASE") {
        requestId = randomUUID();
        await this.#waitForPhaseChange();
        continue;
      }
      if (acknowledgement.code === "TOO_LATE" || acknowledgement.code === "STALE_ATTEMPT") return;
      throw new Error(acknowledgement.message ?? acknowledgement.code ?? "answer rejected");
    }
  }

  async #forceDrop(questionId: string, choice: number | null): Promise<void> {
    this.#dropPerformed = true;
    this.#ready = false;
    this.#lastResume = null;
    this.#socket?.io.engine?.close();
    const verification = await this.#waitForResume();
    const snapshot = verification.snapshot;
    // The resume may land while the teacher has the round paused; the restore
    // is still valid as long as identity, question, and answer all came back.
    if (
      verification.ok !== true ||
      verification.player_id !== this.#playerId ||
      snapshot?.question?.question_id !== questionId ||
      (snapshot.phase !== "QUESTION_OPEN" && snapshot.phase !== "PAUSED") ||
      snapshot.own_answer !== choice
    ) {
      throw new Error("drop-test resume snapshot did not restore the answer and player identity");
    }
    this.#dropSnapshot = Object.freeze({
      playerId: verification.player_id,
      phase: snapshot.phase,
      questionId: snapshot.question?.question_id ?? null,
      ownAnswer: snapshot.own_answer,
    });
    this.#log(`drop-test verified q=${questionId}`);
  }

  #receiveReveal(packet: RevealPacket): void {
    if (this.#revealedQuestions.has(packet.attempt_id)) return;
    this.#revealedQuestions.add(packet.attempt_id);
    const outcome = packet.outcomes.find((entry) => entry.player_id === this.#playerId);
    if (outcome?.correct === true) this.#correct += 1;
    this.#log(`reveal q=${packet.question_id} correct=${outcome?.correct === true ? "yes" : "no"}`);
  }

  #observeTime(serverTimeMs: number): void {
    this.#clockOffsetMs = serverTimeMs - Date.now();
  }

  #estimatedServerNow(): number {
    return Date.now() + this.#clockOffsetMs;
  }

  #markReady(): void {
    this.#ready = true;
    this.#resolveReadyWaiters();
  }

  #resolveReadyWaiters(): void {
    for (const resolve of this.#readyWaiters) resolve();
    this.#readyWaiters.clear();
  }

  #resolvePhaseWaiters(): void {
    for (const resolve of this.#phaseWaiters) resolve();
    this.#phaseWaiters.clear();
  }

  async #waitUntilReady(timeoutMs = 30_000): Promise<void> {
    if (this.#ready) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#readyWaiters.delete(ready);
        reject(new Error("resume timed out"));
      }, timeoutMs);
      const ready = (): void => {
        clearTimeout(timeout);
        if (this.#ready) resolve();
        else reject(new Error("socket stopped"));
      };
      this.#readyWaiters.add(ready);
    });
  }

  async #waitForPhaseChange(): Promise<void> {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.#phaseWaiters.delete(changed);
        resolve();
      }, 250);
      const changed = (): void => {
        clearTimeout(timeout);
        resolve();
      };
      this.#phaseWaiters.add(changed);
    });
  }

  async #waitWithDeadline(waitMs: number, question?: BotQuestion): Promise<void> {
    if (question !== undefined) {
      const remaining = question.deadline_ms - ANSWER_DEADLINE_MARGIN_MS - this.#estimatedServerNow();
      if (remaining <= 0) return;
      waitMs = Math.min(waitMs, remaining);
    }
    if (waitMs > 0) await delay(waitMs, undefined, { signal: this.#signal });
  }

  async #waitForResume(): Promise<ResumeAck> {
    if (this.#lastResume !== null) return this.#lastResume;
    return await new Promise<ResumeAck>((resolve, reject) => {
      const timeout = setTimeout(() => {
        finish(() => reject(new Error("drop-test resume timed out")));
      }, 30_000);
      const aborted = (): void => finish(() => reject(this.#signal.reason));
      const finish = (complete: () => void): void => {
        clearTimeout(timeout);
        this.#signal.removeEventListener("abort", aborted);
        this.#resumeWaiters.delete(resumed);
        complete();
      };
      const resumed = (acknowledgement: ResumeAck): void => {
        finish(() => resolve(acknowledgement));
      };
      this.#resumeWaiters.add(resumed);
      this.#signal.addEventListener("abort", aborted, { once: true });
    });
  }

  #recordError(message: string): void {
    this.#errors += 1;
    this.#log(`error=${message}`);
  }

  #log(message: string): void {
    this.#logger(`[${this.#nickname}] ${message}`);
  }
}

export class BotHarness {
  readonly #options: BotHarnessOptions;
  readonly #logger: (line: string) => void;
  readonly #abort = new AbortController();
  readonly #bots: BotStudent[] = [];
  readonly #oracle: OracleClient | null;
  readonly #policy: AnswerPolicy;
  #oracleFallback = false;
  #stopped = false;
  #resolveCompletion: (() => void) | null = null;
  readonly #completion: Promise<void>;

  constructor(options: BotHarnessOptions) {
    this.#options = options;
    this.#logger = options.logger ?? ((line) => process.stdout.write(`${line}\n`));
    const fetchImpl = options.fetchImpl ?? fetch;
    this.#oracle = options.policy !== "llm" && options.oracleToken !== undefined
      ? new OracleClient(options.url, options.oracleToken, fetchImpl)
      : null;
    if (options.policy === "llm") {
      const apiKey = options.openAiApiKey;
      if (apiKey === undefined || apiKey.length === 0) {
        throw new Error("OPENAI_API_KEY is required for --policy llm");
      }
      this.#policy = createLlmPolicy({
        model: options.model ?? DEFAULT_MODEL,
        baseUrl: options.gatewayBaseUrl ?? DEFAULT_GATEWAY_BASE_URL,
        apiKey,
        fetchImpl,
      });
    } else {
      if (this.#oracle === null) this.#oracleFallback = true;
      this.#policy = createRandomPolicy({
        accuracy: options.accuracy,
        ...(this.#oracle === null
          ? {}
          : {
              oracle: (sessionId, questionId, signal) =>
                this.#oracle?.answer(sessionId, questionId, signal) ?? Promise.resolve(null),
            }),
        onFallback: () => {
          this.#oracleFallback = true;
        },
      });
    }
    this.#completion = new Promise((resolve) => {
      this.#resolveCompletion = resolve;
    });
  }

  async start(): Promise<void> {
    const width = Math.max(2, String(this.#options.count).length);
    const latencySampler = this.#options.latencySampler ?? sampleHumanLatencyMs;
    // Seeded runs stay deterministic ("Bot01"); unseeded classroom runs get a
    // per-run tag so leftover identities from earlier runs never collide.
    const runTag = this.#options.seed !== undefined ? "" : Math.floor(Math.random() * 1296).toString(36).padStart(2, "0");
    for (let index = 0; index < this.#options.count; index += 1) {
      this.#bots.push(new BotStudent({
        url: this.#options.url,
        code: this.#options.code,
        nickname: `Bot${runTag}${String(index + 1).padStart(width, "0")}`,
        random: createSeededRandom((this.#options.seed ?? Date.now()) + index * 0x9e3779b1),
        policy: this.#policy,
        dropTest: this.#options.dropTest ?? false,
        logger: this.#logger,
        latencySampler,
        signal: this.#abort.signal,
        onSessionEnded: () => this.stop(),
      }));
    }
    await Promise.all(this.#bots.map(async (bot) => {
      try {
        await bot.start();
      } catch {
        // One unavailable nickname or connection must not stop the load run.
      }
    }));
  }

  waitForCompletion(): Promise<void> {
    return this.#completion;
  }

  stats(): readonly BotStats[] {
    return this.#bots.map((bot) => bot.stats());
  }

  oracleSummary(): string | null {
    if (this.#policy.name !== "random") return null;
    return this.#oracleFallback || this.#oracle?.available === false
      ? "oracle unavailable; used uniform-random fallback"
      : "oracle active; target accuracy applied";
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#abort.abort();
    for (const bot of this.#bots) bot.stop();
    this.#resolveCompletion?.();
    this.#resolveCompletion = null;
  }
}

export function formatSummary(stats: readonly BotStats[], oracleSummary: string | null): string {
  const rows = stats.map((entry) => [
    entry.nickname,
    entry.joined ? "yes" : "no",
    String(entry.answered),
    String(entry.correct),
    String(entry.reconnects),
    String(entry.errors),
  ]);
  const totals = stats.reduce(
    (result, entry) => ({
      joined: result.joined + Number(entry.joined),
      answered: result.answered + entry.answered,
      correct: result.correct + entry.correct,
      reconnects: result.reconnects + entry.reconnects,
      errors: result.errors + entry.errors,
    }),
    { joined: 0, answered: 0, correct: 0, reconnects: 0, errors: 0 },
  );
  rows.push([
    "TOTAL",
    `${totals.joined}/${stats.length}`,
    String(totals.answered),
    String(totals.correct),
    String(totals.reconnects),
    String(totals.errors),
  ]);
  const headers = ["bot", "joined", "answered", "correct", "reconnects", "errors"];
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0))
  );
  const render = (row: readonly string[]): string =>
    row.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join("  ").trimEnd();
  return [
    ...(oracleSummary === null ? [] : [`Random policy: ${oracleSummary}`]),
    render(headers),
    render(widths.map((width) => "-".repeat(width))),
    ...rows.map(render),
  ].join("\n");
}

function usage(): string {
  return "Usage: npm run bots -- --url URL --code CODE [--count 30] [--accuracy 0.7] [--policy random|llm] [--model MODEL] [--seed 42] [--oracle-token TOKEN] [--drop-test]";
}

export function parseBotArguments(arguments_: readonly string[]): BotHarnessOptions {
  const values = new Map<string, string>();
  const valuedOptions = new Set([
    "--url",
    "--code",
    "--count",
    "--accuracy",
    "--policy",
    "--model",
    "--seed",
    "--oracle-token",
  ]);
  let dropTest = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--drop-test") {
      dropTest = true;
      continue;
    }
    if (argument === undefined || !valuedOptions.has(argument)) throw new Error(usage());
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
    values.set(argument, value);
    index += 1;
  }
  const url = values.get("--url");
  const code = values.get("--code");
  if (url === undefined || code === undefined) throw new Error(usage());
  const count = Number(values.get("--count") ?? 30);
  const accuracy = Number(values.get("--accuracy") ?? 0.7);
  const policy = values.get("--policy") ?? "random";
  const seedValue = values.get("--seed");
  if (!Number.isInteger(count) || count < 1) throw new Error("--count must be a positive integer");
  if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 1) {
    throw new Error("--accuracy must be between 0 and 1");
  }
  if (policy !== "random" && policy !== "llm") throw new Error("--policy must be random or llm");
  const seed = seedValue === undefined ? undefined : Number(seedValue);
  if (seed !== undefined && !Number.isInteger(seed)) throw new Error("--seed must be an integer");
  return {
    url,
    code,
    count,
    accuracy,
    policy,
    model: values.get("--model") ?? DEFAULT_MODEL,
    ...(seed === undefined ? {} : { seed }),
    ...(values.get("--oracle-token") === undefined
      ? {}
      : { oracleToken: values.get("--oracle-token") as string }),
    dropTest,
    gatewayBaseUrl: process.env.OPENAI_BASE_URL || DEFAULT_GATEWAY_BASE_URL,
    ...(process.env.OPENAI_API_KEY === undefined ? {} : { openAiApiKey: process.env.OPENAI_API_KEY }),
  };
}

async function runCli(): Promise<void> {
  const harness = new BotHarness(parseBotArguments(process.argv.slice(2)));
  let interrupted = false;
  const interrupt = (): void => {
    interrupted = true;
    harness.stop();
  };
  process.once("SIGINT", interrupt);
  try {
    try {
      await harness.start();
      await harness.waitForCompletion();
    } catch (error) {
      if (!interrupted) throw error;
    }
  } finally {
    process.off("SIGINT", interrupt);
    process.stdout.write(`${formatSummary(harness.stats(), harness.oracleSummary())}\n`);
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  void runCli().catch((error: unknown) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
