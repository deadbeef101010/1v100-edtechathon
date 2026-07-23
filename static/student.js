import { createClockOffsetEstimator } from "./clock-offset.js";
import { createAvatar } from "./avatar.js";
import { createRequestId } from "./request-id.js";

const form = document.querySelector("#join-form");
const code = document.querySelector("#show-code");
const nickname = document.querySelector("#nickname");
const status = document.querySelector("#join-status");
const joinView = document.querySelector("#join-view");
const studentIdentity = document.querySelector("#student-identity");
const socket = window.io({ transports: ["polling", "websocket"] });
const game = document.querySelector("#student-game");
const phase = document.querySelector("#student-phase");
const question = document.querySelector("#student-question");
const countdown = document.querySelector("#student-countdown");
const choices = document.querySelector("#answer-choices");
const answerStatus = document.querySelector("#answer-status");
const result = document.querySelector("#student-result");
const standings = document.querySelector("#student-standings");
const connection = document.querySelector("#student-connection");
const leaveButton = document.querySelector("#leave-game");
const showBoard = document.querySelector("#student-show-board");
const roleBadge = document.querySelector("#student-role");
const points = document.querySelector("#student-points strong");
const streak = document.querySelector("#student-streak strong");
const bank = document.querySelector("#student-bank strong");
const strikes = document.querySelector("#student-strikes strong");
const progress = document.querySelector("#student-progress");
const progressCount = document.querySelector("#student-progress-count");
const progressCopy = document.querySelector("#student-progress-copy");
const progressFill = document.querySelector("#student-progress-fill");
const finalAnswer = document.querySelector("#student-final-answer");
const helps = document.querySelector("#student-helps");
const helpResult = document.querySelector("#student-help-result");
const pauseOverlay = document.querySelector("#student-pause");
const toast = document.querySelector("#student-toast");
const helpButtons = {
  poll: document.querySelector("#help-poll"),
  ask: document.querySelector("#help-ask"),
  trust: document.querySelector("#help-trust"),
};
const clock = createClockOffsetEstimator();
let playerId = null;
let activeQuestion = null;
let selectedChoice = null;
let phaseAChoice = null;
let countdownTimer = null;
let sessionSalt = "show";
let activeSessionId = null;
let gameMode = "generic";
let currentRole = null;
let currentPhase = "LOBBY";
let currentNickname = "Player";
let currentOne = null;
let currentPoints = 0;
let currentStreak = null;
let currentBank = 0;
let currentStrikes = null;
let currentChoices = [];
let helpAvailability = { poll: false, ask: false, trust: false };
const serverSeqBySession = new Map();
const revealHoldMs = 6_000;
let terminalTimers = [];
let nextTerminalMomentAt = 0;
let toastTimer = null;

const CLIENT_KEY = "player:client-instance";
const PENDING_KEY = "player:pending-join";
const TOKEN_PREFIX = "player:session:";

function stableClientId() {
  let id = localStorage.getItem(CLIENT_KEY);
  if (id === null) {
    id = createRequestId();
    localStorage.setItem(CLIENT_KEY, id);
  }
  return id;
}

function tokenKey(sessionId) {
  return `${TOKEN_PREFIX}${sessionId}`;
}

// Stored identity is JSON {token, code, nickname, saved_at_ms}; legacy entries
// are the raw token string.
function readStoredIdentity(sessionId) {
  const raw = localStorage.getItem(tokenKey(sessionId));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.token === "string") return parsed;
  } catch {
    // legacy raw-token entry
  }
  return { token: raw, code: null, nickname: null, saved_at_ms: 0 };
}

function storeIdentity(sessionId, identity) {
  localStorage.setItem(tokenKey(sessionId), JSON.stringify({ ...identity, saved_at_ms: Date.now() }));
}

function showPlayer(snapshot, salt = snapshot.session_id ?? sessionSalt) {
  const nextSessionId = snapshot.session_id ?? salt ?? activeSessionId;
  if (activeSessionId !== null && nextSessionId !== activeSessionId) cancelTerminalSequence();
  playerId = snapshot.player_id ?? playerId;
  sessionSalt = salt;
  activeSessionId = nextSessionId;
  currentNickname = snapshot.nickname ?? currentNickname;
  currentPoints = Number.isFinite(snapshot.points) ? snapshot.points : currentPoints;
  if (snapshot.role) currentRole = snapshot.role;
  form.hidden = true;
  joinView.classList.add("joined");
  studentIdentity.hidden = false;
  studentIdentity.replaceChildren(createAvatar(currentNickname, sessionSalt));
  const roomCode = snapshot.room_code ?? readStoredIdentity(nextSessionId)?.code ?? null;
  const room = roomCode === null ? "" : ` You’re in room ${roomCode}.`;
  status.textContent = `You’re in, ${currentNickname}!${room} You have ${currentPoints} points. Wait here — the game starts on the big screen.`;
  leaveButton.hidden = false;
  if (Array.isArray(snapshot.roster)) updateRoster(snapshot.roster);
  if (snapshot.snapshot) renderSnapshot(snapshot.snapshot);
}

function clearIdentity(sessionId) {
  if (sessionId ?? activeSessionId) localStorage.removeItem(tokenKey(sessionId ?? activeSessionId));
  clearInterval(countdownTimer);
  playerId = null;
  activeQuestion = null;
  selectedChoice = null;
  activeSessionId = null;
  gameMode = "generic";
  currentRole = null;
  currentPhase = "LOBBY";
  phaseAChoice = null;
  currentChoices = [];
  currentPoints = 0;
  currentStreak = null;
  currentBank = 0;
  currentStrikes = null;
  if (sessionId ?? activeSessionId) serverSeqBySession.delete(sessionId ?? activeSessionId);
  cancelTerminalSequence();
  hideToast();
  delete document.body.dataset.gameMode;
  showBoard.hidden = true;
  progress.hidden = true;
  helps.hidden = true;
  helpResult.hidden = true;
  finalAnswer.hidden = true;
  pauseOverlay.hidden = true;
  form.hidden = false;
  joinView.hidden = false;
  joinView.classList.remove("joined");
  studentIdentity.hidden = true;
  studentIdentity.replaceChildren();
  leaveButton.hidden = true;
  game.hidden = true;
  status.textContent = "No account needed. We’ll reconnect you on this device.";
}

function observeTime(packet) {
  if (Number.isFinite(packet.server_time_ms)) clock.observe(packet.server_time_ms);
}

function startCountdown(deadlineMs) {
  clearInterval(countdownTimer);
  if (!Number.isFinite(deadlineMs)) {
    countdown.textContent = "Paused";
    return;
  }
  const update = () => {
    countdown.textContent = `${(clock.remainingMs(deadlineMs) / 1_000).toFixed(1)}s`;
  };
  update();
  countdownTimer = setInterval(update, 100);
}

function renderQuestion(packet) {
  if (gameMode !== "generic") {
    gameMode = "generic";
    delete document.body.dataset.gameMode;
    showBoard.hidden = true;
    progress.hidden = true;
    helps.hidden = true;
    helpResult.hidden = true;
    finalAnswer.hidden = true;
    pauseOverlay.hidden = true;
  }
  observeTime(packet);
  activeQuestion = {
    attemptId: packet.attempt_id,
    questionId: packet.question_id,
    deadlineMs: packet.deadline_ms,
  };
  selectedChoice = packet.own_answer ?? null;
  game.hidden = false;
  joinView.hidden = true;
  phase.textContent = packet.phase === "PAUSED" ? "Show paused" : "Everybody Answers";
  question.textContent = packet.prompt;
  result.hidden = true;
  answerStatus.textContent = selectedChoice === null ? "Choose your answer." : "Your answer is in.";
  choices.replaceChildren(
    ...packet.choices.map((label, index) => {
      const button = document.createElement("button");
      const marker = document.createElement("strong");
      const answer = document.createElement("span");
      button.type = "button";
      button.className = "answer-choice";
      marker.textContent = String.fromCharCode(65 + index);
      answer.textContent = label;
      button.append(marker, answer);
      button.disabled = selectedChoice !== null;
      button.classList.toggle("locked", selectedChoice === index);
      button.addEventListener("click", () => submitAnswer(index));
      return button;
    }),
  );
  startCountdown(packet.deadline_ms);
}

function enterOneV100() {
  gameMode = "one_v_100";
  document.body.dataset.gameMode = "one-v-100";
  showBoard.hidden = false;
  renderShowBoard();
}

function serverSeq(packet) {
  return Number.isSafeInteger(packet?.server_seq) ? packet.server_seq : null;
}

function applyOneV100Packet(packet, apply) {
  const sequence = serverSeq(packet);
  const lastSequence = serverSeqBySession.get(activeSessionId) ?? 0;
  if (sequence !== null && sequence <= lastSequence) return false;
  if (sequence !== null && activeSessionId !== null) serverSeqBySession.set(activeSessionId, sequence);
  apply(packet);
  return true;
}

function cancelTerminalSequence() {
  for (const timer of terminalTimers) clearTimeout(timer);
  terminalTimers = [];
  nextTerminalMomentAt = 0;
}

function holdTerminalReveal() {
  cancelTerminalSequence();
  nextTerminalMomentAt = Date.now() + revealHoldMs;
}

function scheduleTerminalMoment(renderMoment, holdMs = 0) {
  const now = Date.now();
  const startsAt = Math.max(now, nextTerminalMomentAt);
  nextTerminalMomentAt = startsAt + holdMs;
  if (startsAt === now) {
    renderMoment();
    return;
  }
  terminalTimers.push(setTimeout(renderMoment, startsAt - now));
}

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(hideToast, 5_000);
}

function hideToast() {
  clearTimeout(toastTimer);
  toastTimer = null;
  toast.hidden = true;
}

function roleLabel(role = currentRole) {
  if (role === "one") return "You’re in the Spotlight";
  if (role === "crowd") return "Comeback Crew";
  return "Challenge Team";
}

function renderShowBoard() {
  roleBadge.textContent = roleLabel();
  roleBadge.dataset.role = currentRole ?? "mob";
  points.textContent = String(currentPoints);
  streak.textContent = currentStreak === null ? "--" : String(currentStreak);
  bank.textContent = String(currentBank);
  strikes.textContent = currentStrikes === null ? "--" : String(currentStrikes);
}

function showOneV100View() {
  game.hidden = false;
  joinView.hidden = true;
  showBoard.hidden = false;
  renderShowBoard();
}

function resetOneV100Attempt() {
  clearInterval(countdownTimer);
  activeQuestion = null;
  selectedChoice = null;
  currentChoices = [];
  choices.replaceChildren();
  choices.hidden = false;
  question.textContent = "";
  result.hidden = true;
  helpResult.hidden = true;
  helpResult.replaceChildren();
  helps.hidden = true;
  finalAnswer.hidden = true;
  finalAnswer.disabled = true;
  progress.hidden = true;
  answerStatus.hidden = false;
  standings.replaceChildren();
}

function setProgress(packet, copy = "Classmates answered") {
  const locked = Number.isFinite(packet.locked_count) ? packet.locked_count : 0;
  const eligible = Number.isFinite(packet.eligible_count) ? packet.eligible_count : 0;
  progress.hidden = false;
  progressCount.textContent = `${locked} / ${eligible}`;
  progressCopy.textContent = copy;
  progressFill.style.transform = `scaleX(${eligible > 0 ? Math.min(1, locked / eligible) : 0})`;
}

function renderPhaseAWaiting(packet, lateJoin = false) {
  cancelTerminalSequence();
  enterOneV100();
  currentPhase = "PHASE_A";
  resetOneV100Attempt();
  showOneV100View();
  phase.textContent = "Everybody Answers";
  countdown.textContent = "Get ready";
  question.textContent = lateJoin
    ? "You’ll jump in on the next question"
    : "The class is answering. Your turn is coming.";
  answerStatus.textContent = lateJoin
    ? "You’re still playing with the Comeback Crew. Your answers will help the class next round."
    : "Your question is coming next. Take a breath. You’ve got this.";
  setProgress(packet);
  if (Number.isFinite(packet.deadline_ms)) startCountdown(packet.deadline_ms);
}

function makeChoice(label, index, interactive, draftOnly = false) {
  const button = document.createElement("button");
  const marker = document.createElement("strong");
  const answer = document.createElement("span");
  button.type = "button";
  button.className = "answer-choice";
  marker.textContent = String.fromCharCode(65 + index);
  answer.textContent = label;
  button.append(marker, answer);
  button.disabled = !interactive || (!draftOnly && selectedChoice !== null);
  button.classList.toggle("locked", selectedChoice === index);
  if (interactive) {
    button.addEventListener("click", () => {
      if (draftOnly) selectOneDraft(index);
      else submitAnswer(index);
    });
  }
  return button;
}

function renderPhaseAQuestion(packet) {
  cancelTerminalSequence();
  enterOneV100();
  currentPhase = "PHASE_A";
  resetOneV100Attempt();
  observeTime(packet);
  activeQuestion = {
    attemptId: packet.attempt_id,
    questionId: packet.question_id,
    deadlineMs: packet.deadline_ms,
  };
  selectedChoice = packet.own_answer ?? null;
  phaseAChoice = selectedChoice;
  currentChoices = Array.isArray(packet.choices) ? packet.choices : [];
  showOneV100View();
  phase.textContent = "Everybody Answers";
  question.textContent = packet.prompt ?? "Choose your answer";
  roleBadge.textContent = currentRole === "crowd" ? "Comeback Crew / You can earn 5+" : "Challenge Team / You can earn 10+";
  choices.replaceChildren(...currentChoices.map((label, index) => makeChoice(label, index, true)));
  answerStatus.textContent = selectedChoice === null
    ? currentRole === "crowd"
      ? "Your answers feed the Lifelines. Choose one and keep earning!"
      : currentStreak > 0
        ? `You’re on a ${currentStreak}-answer streak. Keep it going!`
        : "Choose your answer."
    : "Your answer is in.";
  startCountdown(packet.deadline_ms);
}

function selectOneDraft(choice) {
  if (currentRole !== "one" || currentPhase !== "PHASE_B") return;
  selectedChoice = choice;
  [...choices.children].forEach((button, index) => button.classList.toggle("locked", index === choice));
  finalAnswer.disabled = false;
  answerStatus.textContent = `${String.fromCharCode(65 + choice)} selected. Use a Lifeline or make it your final answer.`;
  updateHelpButtons();
}

function renderPhaseB(packet) {
  const answererChoice = packet.own_answer ?? phaseAChoice;
  enterOneV100();
  cancelTerminalSequence();
  currentPhase = "PHASE_B";
  resetOneV100Attempt();
  observeTime(packet);
  currentBank = Number.isFinite(packet.bank) ? packet.bank : currentBank;
  currentStrikes = Number.isFinite(packet.strikes) ? packet.strikes : currentStrikes;
  currentChoices = Array.isArray(packet.choices) ? packet.choices : [];
  helpAvailability = { ...helpAvailability, ...(packet.helps_available ?? {}) };
  activeQuestion = {
    attemptId: packet.attempt_id,
    questionId: packet.question_id,
    deadlineMs: null,
  };
  selectedChoice = currentRole === "one" ? null : answererChoice;
  showOneV100View();
  renderShowBoard();
  phase.textContent = "Spotlight Round";
  countdown.textContent = currentRole === "one" ? "Your turn" : "Spotlight";
  question.textContent = packet.prompt ?? "Question incoming";
  const isOne = currentRole === "one";
  choices.replaceChildren(...currentChoices.map((label, index) => makeChoice(label, index, isOne, isOne)));
  finalAnswer.hidden = !isOne;
  helps.hidden = !isOne;
  answerStatus.textContent = isOne
    ? "Choose an answer, then make it final. Your Lifelines are here if you want them."
    : currentRole === "crowd"
      ? "Your Comeback Crew answer can power the Spotlight Player’s Lifelines."
      : "Your answer can help the Spotlight Player. Watch for the reveal!";
  updateHelpButtons();
}

function updateHelpButtons() {
  for (const [name, button] of Object.entries(helpButtons)) {
    const needsChoice = name === "poll";
    button.disabled = !helpAvailability[name] || (needsChoice && selectedChoice === null);
    button.classList.toggle("used", !helpAvailability[name]);
    const state = button.querySelector("span");
    if (!helpAvailability[name]) state.textContent = "Used";
    else if (needsChoice && selectedChoice === null) state.textContent = "Choose an answer first";
    else if (name === "poll") state.textContent = "See how the class answered";
    else if (name === "ask") state.textContent = "Hear two classmates explain";
    else state.textContent = "Use the class’s top answer";
  }
}

function submitOneAnswer() {
  if (!activeQuestion || selectedChoice === null || currentRole !== "one") return;
  finalAnswer.disabled = true;
  for (const button of choices.children) button.disabled = true;
  answerStatus.textContent = "Sending your final answer...";
  emitWithRetry("one_answer", {
    request_id: createRequestId(),
    attempt_id: activeQuestion.attemptId,
    question_id: activeQuestion.questionId,
    choice: selectedChoice,
  }, handleAnswerAck);
}

function handleAnswerAck(ack) {
  observeTime(ack);
  if (ack.ok === true) {
    answerStatus.textContent = "Your answer is in!";
    return;
  }
  if (currentRole === "one") {
    finalAnswer.disabled = false;
    for (const button of choices.children) button.disabled = false;
  }
  answerStatus.textContent = ack.message ?? "Ask your teacher for help.";
}

function useHelp(name) {
  if (!helpAvailability[name] || currentRole !== "one") return;
  const payload = { request_id: createRequestId() };
  if (name === "poll") {
    if (selectedChoice === null) return;
    payload.choice = selectedChoice;
  }
  helpButtons[name].disabled = true;
  answerStatus.textContent = "Getting your Lifeline...";
  emitWithRetry(`help_${name}`, payload, (ack) => {
    if (ack?.ok === false) {
      updateHelpButtons();
      answerStatus.textContent = "You can still choose your own answer.";
      showToast(ack.message ?? "That Lifeline is not available right now. You can still choose your answer.");
    }
  }, 1);
}

function showHelpResult(type, packet) {
  if (gameMode !== "one_v_100") return;
  hideToast();
  helpResult.hidden = false;
  helpResult.replaceChildren();
  if (type === "poll" && Number.isInteger(packet.choice)) {
    helpAvailability.poll = false;
    helpResult.textContent = `${packet.count ?? 0} of ${packet.total_answers ?? 0} classmates chose ${choiceText(packet.choice)}. It’s still your call.`;
  } else if (type === "ask" && Array.isArray(packet.speakers)) {
    helpAvailability.ask = false;
    const self = packet.speakers.find((speaker) => speaker.player_id === playerId);
    const heading = document.createElement("strong");
    heading.textContent = "Two voices. Two reasons.";
    const cards = document.createElement("div");
    cards.className = "speaker-cards";
    cards.replaceChildren(...packet.speakers.map((speaker) => {
      const card = document.createElement("span");
      card.textContent = `${speaker.nickname}: ${choiceText(speaker.choice)}`;
      return card;
    }));
    helpResult.append(heading, cards);
    if (self) {
      const personal = document.createElement("p");
      personal.textContent = `You’re one of today’s two voices. You earned +${packet.bonus_each ?? 5} for sharing your thinking. You chose ${choiceText(self.choice)}.`;
      helpResult.prepend(personal);
    }
  } else if (type === "trust" && Number.isInteger(packet.plurality_choice)) {
    helpAvailability.trust = false;
    selectedChoice = packet.plurality_choice;
    helpResult.textContent = `The class chose ${choiceText(packet.plurality_choice)}. That’s your final answer.`;
    finalAnswer.disabled = true;
    for (const button of choices.children) button.disabled = true;
  } else {
    helpResult.hidden = true;
  }
  updateHelpButtons();
}

function choiceText(index) {
  const letter = String.fromCharCode(65 + index);
  return currentChoices[index] === undefined ? letter : `${letter}: ${currentChoices[index]}`;
}

function showOneV100Reveal(packet) {
  observeTime(packet);
  clearInterval(countdownTimer);
  currentPhase = "REVEAL";
  holdTerminalReveal();
  currentBank = Number.isFinite(packet.bank) ? packet.bank : currentBank;
  const personalDeltas = Array.isArray(packet.score_deltas)
    ? packet.score_deltas.filter((entry) => entry.player_id === playerId)
    : [];
  const earned = personalDeltas.reduce((total, entry) => total + (Number(entry.points) || 0), 0);
  currentPoints += earned;
  const wasDemoted = Array.isArray(packet.demoted) && packet.demoted.includes(playerId);
  const wasCorrect = currentRole === "one" ? packet.one_correct === true : selectedChoice === packet.correct_choice;
  currentStreak = currentRole === "one" ? currentStreak : wasCorrect ? (currentStreak ?? 0) + 1 : 0;
  phase.textContent = "Here’s the answer";
  countdown.textContent = "Reveal";
  result.hidden = false;
  if (wasDemoted) {
    currentRole = "crowd";
    result.innerHTML = "<strong>You’re with the Comeback Crew now.</strong><br>Your answer reset your streak. Because the Spotlight Player got it right, your role changed, but your points are safe. You’re still playing, and your answers will feed the Lifelines.";
  } else if (wasCorrect) {
    result.textContent = earned > 0 ? `You got it! +${earned} points.` : "You got it!";
  } else {
    result.textContent = `Not this time. ${choiceText(packet.correct_choice)} is correct. You’re still in the game.`;
  }
  [...choices.children].forEach((button, index) => {
    button.classList.toggle("correct", index === packet.correct_choice);
    button.classList.toggle("incorrect", index === selectedChoice && index !== packet.correct_choice);
    button.disabled = true;
  });
  helps.hidden = true;
  finalAnswer.hidden = true;
  answerStatus.textContent = Array.isArray(packet.demoted) && packet.demoted.length > 0
    ? `${packet.demoted.length} ${packet.demoted.length === 1 ? "classmate joins" : "classmates join"} the Comeback Crew. Everyone keeps playing.`
    : `Prize Pot: ${currentBank}.`;
  renderShowBoard();
  pauseOverlay.hidden = true;
}

function updateRoster(players) {
  const self = Array.isArray(players) ? players.find((player) => player.player_id === playerId) : null;
  if (self?.role) {
    currentRole = self.role;
    if (gameMode === "one_v_100") renderShowBoard();
  }
}

function renderGameStart(packet) {
  cancelTerminalSequence();
  const handoffVisible = gameMode === "one_v_100" && currentPhase === "BETWEEN_QUESTIONS" && currentRole !== null;
  enterOneV100();
  currentOne = packet.one ?? currentOne;
  currentRole = packet.one?.id === playerId ? "one" : "mob";
  currentBank = 0;
  currentStrikes = Number.isFinite(packet.base_strikes) ? packet.base_strikes : null;
  currentStreak = 0;
  phaseAChoice = null;
  currentPhase = "BETWEEN_QUESTIONS";
  if (handoffVisible) {
    renderShowBoard();
    return;
  }
  resetOneV100Attempt();
  showOneV100View();
  phase.textContent = `Game ${packet.ordinal ?? ""}`.trim();
  countdown.textContent = "Get ready";
  question.textContent = currentRole === "one"
    ? "You’re stepping into the Spotlight"
    : `${packet.one?.nickname ?? "A classmate"} is stepping into the Spotlight`;
  answerStatus.textContent = currentRole === "one"
    ? "The class answers first. Then the Spotlight Round is yours."
    : currentRole === "crowd"
      ? "You’re still playing with the Comeback Crew."
      : "You’re on the Challenge Team. Every answer counts.";
  renderShowBoard();
}

function renderGameEnd(packet, applyPayout = true) {
  if (gameMode !== "one_v_100") return;
  currentPhase = "LEADERBOARD";
  currentBank = Number.isFinite(packet.bank) ? packet.bank : currentBank;
  const payout = Array.isArray(packet.payouts)
    ? packet.payouts.find((entry) => entry.player_id === playerId)
    : null;
  if (applyPayout && payout) currentPoints += Number(payout.points) || 0;
  phase.textContent = "Game complete";
  countdown.textContent = "Final";
  question.textContent = packet.reason === "flameout"
    ? "Challenge Team wins the Prize Pot"
    : packet.reason === "mob_emptied"
      ? "Jackpot! The Challenge Team was cleared"
      : "All questions cleared";
  result.hidden = false;
  result.textContent = payout
    ? `You earned +${payout.points} points in the finish!`
    : currentRole === "one"
      ? `You banked ${packet.banked_by_one ?? 0} points.`
      : "Strong game. Your points are safe.";
  choices.replaceChildren();
  helps.hidden = true;
  finalAnswer.hidden = true;
  answerStatus.textContent = "Your teacher will start the next game when the room is ready.";
  renderShowBoard();
}

function renderNextGame(packet) {
  if (gameMode !== "one_v_100") return;
  cancelTerminalSequence();
  currentOne = packet.one ?? currentOne;
  currentRole = packet.one?.id === playerId ? "one" : "mob";
  currentStreak = 0;
  phaseAChoice = null;
  currentPhase = "BETWEEN_QUESTIONS";
  resetOneV100Attempt();
  showOneV100View();
  phase.textContent = "Next Spotlight Player";
  countdown.textContent = "Next game";
  question.textContent = currentRole === "one"
    ? "You’re stepping into the Spotlight next!"
    : `${packet.one?.nickname ?? "A classmate"} steps into the Spotlight next`;
  answerStatus.textContent = "Everyone rejoins the Challenge Team. New game, new streaks!";
  renderShowBoard();
}

function isOneV100Snapshot(snapshot) {
  return snapshot?.session?.mode === "one_v_100" || snapshot?.game !== undefined || gameMode === "one_v_100";
}

function normalizeOne(snapshotOne) {
  if (!snapshotOne) return null;
  return { id: snapshotOne.player_id ?? snapshotOne.id, nickname: snapshotOne.nickname };
}

function pausedPhase(gameSnapshot) {
  if (gameSnapshot.phase !== "PAUSED") return gameSnapshot.phase;
  if (["PHASE_A", "PHASE_A_LOCKED", "PHASE_B"].includes(currentPhase)) return currentPhase;
  if (currentRole === "one" || gameSnapshot.paused?.reason === "one_disconnected") return "PHASE_B";
  return Number.isFinite(gameSnapshot.question?.deadline_ms) ? "PHASE_A" : "PHASE_B";
}

function restorePause(paused) {
  const active = paused?.active === true || paused === true;
  pauseOverlay.hidden = !active;
  const detail = pauseOverlay.querySelector("span");
  if (active && detail && typeof paused?.reason === "string") {
    detail.textContent = paused.reason === "one_disconnected"
      ? "We’ll keep your place while the Spotlight Player reconnects."
      : "We’ll keep your place until the show resumes.";
  }
}

function renderOneV100Snapshot(snapshot) {
  const gameSnapshot = snapshot.game ?? snapshot;
  const self = snapshot.self ?? {};
  const leaderboard = Array.isArray(snapshot.leaderboard) ? snapshot.leaderboard : [];
  const snapshotPhase = pausedPhase(gameSnapshot);
  const gameQuestion = gameSnapshot.question;
  const packet = {
    ...gameSnapshot,
    ...(gameQuestion ?? {}),
    one: normalizeOne(gameSnapshot.one),
    bank: gameSnapshot.bank,
    strikes: gameSnapshot.strikes_remaining ?? gameSnapshot.strikes,
    base_strikes: gameSnapshot.base_strikes,
    helps_available: gameSnapshot.helps_available,
    own_answer: self.choice,
    deadline_ms: gameQuestion?.deadline_ms,
  };
  if (self.player_id) playerId = self.player_id;
  if (self.role) currentRole = self.role;
  if (Number.isFinite(self.points)) currentPoints = self.points;
  if (Number.isFinite(self.streak)) currentStreak = self.streak;
  currentBank = Number.isFinite(packet.bank) ? packet.bank : currentBank;
  currentStrikes = Number.isFinite(packet.strikes) ? packet.strikes : currentStrikes;
  helpAvailability = { poll: false, ask: false, trust: false, ...(gameSnapshot.helps_available ?? {}) };
  currentPhase = snapshotPhase ?? currentPhase;
  enterOneV100();

  if (snapshotPhase === "PHASE_A" || snapshotPhase === "PHASE_A_LOCKED") {
    if (gameQuestion?.prompt && Array.isArray(gameQuestion.choices) && currentRole !== "one") {
      renderPhaseAQuestion(packet);
      if (snapshotPhase === "PHASE_A_LOCKED") {
        currentPhase = "PHASE_A_LOCKED";
        phase.textContent = "Answers in";
        countdown.textContent = "Ready";
        clearInterval(countdownTimer);
        for (const button of choices.children) button.disabled = true;
      }
    } else {
      renderPhaseAWaiting(packet, currentRole === "crowd");
    }
  } else if (snapshotPhase === "PHASE_B" && gameQuestion) {
    renderPhaseB(packet);
  } else if (snapshotPhase === "LEADERBOARD") {
    cancelTerminalSequence();
    showOneV100View();
    if (gameSnapshot.last_result) renderGameEnd(gameSnapshot.last_result, false);
    else {
      resetOneV100Attempt();
      phase.textContent = "Game complete";
      countdown.textContent = "Final";
      question.textContent = "Today’s standings";
      answerStatus.textContent = "Your teacher will start the next game when the room is ready.";
    }
    renderStudentStandings({ rows: leaderboard }, true);
  } else if (snapshotPhase === "SESSION_ENDED") {
    renderSessionEnd({ final_leaderboard: leaderboard });
  } else {
    cancelTerminalSequence();
    resetOneV100Attempt();
    showOneV100View();
    phase.textContent = gameSnapshot.ordinal ? `Game ${gameSnapshot.ordinal}` : "Today’s show";
    countdown.textContent = "Get ready";
    question.textContent = gameSnapshot.one?.nickname
      ? `${gameSnapshot.one.nickname} is in the Spotlight`
      : "Waiting for the next game moment";
    answerStatus.textContent = "You’re connected. Your role and points are safe.";
  }
  renderShowBoard();
  restorePause(gameSnapshot.paused);
}

function renderSnapshot(snapshot) {
  if (!snapshot) return;
  if (isOneV100Snapshot(snapshot)) {
    applyOneV100Packet(snapshot, renderOneV100Snapshot);
    return;
  }
  if (snapshot.question) renderQuestion({ ...snapshot.question, ...snapshot });
}

function renderSessionEnd(packet) {
  if (gameMode !== "one_v_100") {
    clearIdentity(packet.session_id);
    return;
  }
  currentPhase = "SESSION_ENDED";
  cancelTerminalSequence();
  pauseOverlay.hidden = true;
  clearInterval(countdownTimer);
  showOneV100View();
  resetOneV100Attempt();
  phase.textContent = "Today’s show is over";
  countdown.textContent = "Complete";
  question.textContent = "Strong finish!";
  answerStatus.textContent = "Thanks for bringing your thinking to today’s show.";
  if (Array.isArray(packet.final_leaderboard)) renderStudentStandings({ rows: packet.final_leaderboard }, true);
}

function submitAnswer(choice) {
  if (!activeQuestion || selectedChoice !== null) return;
  selectedChoice = choice;
  if (gameMode === "one_v_100") phaseAChoice = choice;
  for (const button of choices.children) button.disabled = true;
  choices.children[choice]?.classList.add("locked");
  answerStatus.textContent = "Sending your answer...";
  emitWithRetry("answer_submit", {
    request_id: createRequestId(),
    attempt_id: activeQuestion.attemptId,
    question_id: activeQuestion.questionId,
    choice,
  }, (ack) => {
    if (ack.ok === true) return handleAnswerAck(ack);
    observeTime(ack);
    selectedChoice = null;
    for (const button of choices.children) button.disabled = false;
    answerStatus.textContent = ack.message ?? "Ask your teacher for help.";
  });
}

function showReveal(packet) {
  if (gameMode === "one_v_100" || !Array.isArray(packet.outcomes)) {
    showOneV100Reveal(packet);
    return;
  }
  observeTime(packet);
  clearInterval(countdownTimer);
  phase.textContent = "Here’s the answer";
  const outcome = packet.outcomes.find((entry) => entry.player_id === playerId);
  result.hidden = false;
  result.textContent = outcome?.correct
    ? `You got it! +${outcome.delta} points.`
    : `Not this time. The correct answer is ${String.fromCharCode(65 + packet.correct_choice)}.`;
  [...choices.children].forEach((button, index) => {
    button.classList.toggle("correct", index === packet.correct_choice);
    button.classList.toggle("incorrect", index === selectedChoice && index !== packet.correct_choice);
    button.disabled = true;
  });
}

function renderStudentStandings(packet, includeSelf = false) {
  observeTime(packet);
  const rows = Array.isArray(packet.rows) ? packet.rows : [];
  const leaders = rows.slice(0, 5);
  const self = rows.find((entry) => entry.player_id === playerId);
  const visible = includeSelf && self && !leaders.includes(self) ? [...leaders, self] : leaders;
  standings.replaceChildren(...visible.map((entry) => {
    const item = document.createElement("li");
    const identity = document.createElement("span");
    const name = document.createElement("strong");
    const score = document.createElement("span");
    identity.className = "standing-identity";
    identity.append(createAvatar(entry.nickname, sessionSalt), name);
    name.textContent = `${entry.rank}. ${entry.nickname}`;
    score.textContent = `${entry.points} points${entry.has_been_one ? " / Spotlight turn" : ""}`;
    item.append(identity, score);
    item.classList.toggle("is-you", entry.player_id === playerId);
    if (entry.player_id === (currentOne?.id ?? currentOne?.player_id)) {
      item.classList.add("the-one");
      const chip = document.createElement("small");
      chip.className = "one-chip";
      chip.textContent = "★ In the Spotlight";
      name.append(chip);
    }
    if (entry.player_id === playerId) currentPoints = entry.points;
    return item;
  }));
  renderShowBoard();
}

function emitWithRetry(event, payload, onResult, attempts = 3) {
  socket.timeout(5_000).emit(event, payload, (error, ack) => {
    if (error && attempts > 1) {
      emitWithRetry(event, payload, onResult, attempts - 1);
      return;
    }
    onResult(error ? { ok: false, code: "ACK_TIMEOUT" } : ack);
  });
}

function resumeStoredIdentity() {
  // Resume only the NEWEST stored identity: resuming every stored session let
  // any old still-live room hijack the join screen mid-typing.
  const candidates = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith(TOKEN_PREFIX)) continue;
    const sessionId = key.slice(TOKEN_PREFIX.length);
    const identity = readStoredIdentity(sessionId);
    if (identity?.token) candidates.push({ sessionId, identity });
  }
  candidates.sort((left, right) => (right.identity.saved_at_ms ?? 0) - (left.identity.saved_at_ms ?? 0));
  const newest = candidates[0];
  if (newest === undefined) return;
  // Never yank the form out from under someone who is already typing.
  if (!form.hidden && (code.value.trim() !== "" || nickname.value.trim() !== "")) return;
  socket.emit("resume", {
    token: newest.identity.token,
    session_id: newest.sessionId,
    request_id: createRequestId(),
    client_instance_id: stableClientId(),
    last_server_seq: serverSeqBySession.get(newest.sessionId) ?? 0,
  }, (ack) => {
    if (ack.ok === true) {
      socketHasPrincipal = true;
      showPlayer({ ...ack, session_id: ack.session_id ?? newest.sessionId }, newest.sessionId);
    } else if (["KICKED", "RECONNECT_BAD_TOKEN", "SESSION_ENDED"].includes(ack.code)) {
      clearIdentity(newest.sessionId);
    }
  });
}

let joinConnectDeadline = null;
// The server binds one principal per socket. Resume/join attaches one; before
// a NEW join (or after Leave) the socket must be recycled or the server
// rejects with PRINCIPAL_CONFLICT.
let suppressResume = false;
let socketHasPrincipal = false;

function recycleSocket() {
  socketHasPrincipal = false;
  socket.disconnect();
  socket.connect();
}

function sendJoin(payload, normalizedCode, retriedConflict = false) {
  emitWithRetry("join_session", payload, (ack) => {
    if (ack.ok === false) {
      // Mint a fresh request_id next time: replaying a terminally-rejected
      // request_id (e.g. a nickname that WAS taken) replays the rejection
      // forever even after the conflict clears.
      localStorage.removeItem(PENDING_KEY);
      if (ack.code === "PRINCIPAL_CONFLICT" && !retriedConflict) {
        // A resume won a race for this socket; recycle and retry once.
        suppressResume = true;
        recycleSocket();
        const retry = { ...payload, request_id: createRequestId() };
        socket.once("connect", () => sendJoin(retry, normalizedCode, true));
        return;
      }
      suppressResume = false;
      status.textContent = ack.code === "ACK_TIMEOUT"
        ? "Hmm, we couldn't reach the show. Check your wifi and tap Join again."
        : ack.message ?? "Could not join today's show. Ask your teacher for help.";
      return;
    }
    suppressResume = false;
    socketHasPrincipal = true;
    localStorage.removeItem(PENDING_KEY);
    storeIdentity(ack.session_id, { token: ack.token, code: normalizedCode, nickname: ack.nickname ?? nickname.value });
    showPlayer({ ...ack, room_code: normalizedCode, nickname: ack.nickname ?? nickname.value }, ack.session_id);
  });
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const normalizedCode = code.value.toUpperCase().replace(/[\s-]/g, "");
  const prior = JSON.parse(localStorage.getItem(PENDING_KEY) ?? "null");
  const payload =
    prior?.code === normalizedCode && prior?.nickname === nickname.value
      ? prior
      : {
          code: normalizedCode,
          nickname: nickname.value,
          request_id: createRequestId(),
          client_instance_id: stableClientId(),
        };
  localStorage.setItem(PENDING_KEY, JSON.stringify(payload));
  if (socketHasPrincipal) {
    // Replacing an existing identity (auto-resumed or left over): release it
    // server-side by recycling the socket, and keep auto-resume out of the way.
    suppressResume = true;
    clearIdentity(activeSessionId);
    recycleSocket();
  }
  if (socket.connected) {
    status.textContent = "Joining the show...";
    sendJoin(payload, normalizedCode);
    return;
  }
  // Socket is down (redeploy, wifi blip, or just recycled): a buffered emit
  // can hang forever. Wait for connect with a visible status and a deadline.
  status.textContent = "Connecting to the show...";
  clearTimeout(joinConnectDeadline);
  const onConnect = () => {
    clearTimeout(joinConnectDeadline);
    status.textContent = "Joining the show...";
    sendJoin(payload, normalizedCode);
  };
  socket.once("connect", onConnect);
  joinConnectDeadline = setTimeout(() => {
    socket.off("connect", onConnect);
    localStorage.removeItem(PENDING_KEY);
    suppressResume = false;
    status.textContent = "Hmm, we couldn't reach the show. Check your wifi and tap Join again.";
  }, 8_000);
});

leaveButton.addEventListener("click", () => {
  // Clear local identity AND release the server-side principal; keep
  // auto-resume suppressed so an older stored game cannot re-grab the screen.
  suppressResume = true;
  clearIdentity(activeSessionId);
  recycleSocket();
  status.textContent = "You left the game. Join again with any name you like!";
  nickname.focus();
});

socket.on("kicked", () => {
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(TOKEN_PREFIX)) localStorage.removeItem(key);
  }
  clearIdentity();
});

finalAnswer.addEventListener("click", submitOneAnswer);
for (const [name, button] of Object.entries(helpButtons)) button.addEventListener("click", () => useHelp(name));

socket.on("session_end", (packet) => {
  if (gameMode === "one_v_100") applyOneV100Packet(packet, renderSessionEnd);
  else renderSessionEnd(packet);
});
socket.on("session_ended", ({ session_id: sessionId }) => clearIdentity(sessionId));
socket.on("question_open", renderQuestion);
socket.on("game_start", (packet) => applyOneV100Packet(packet, renderGameStart));
socket.on("answer_ack", handleAnswerAck);
socket.on("phase_a_start", (packet) => applyOneV100Packet(packet, renderPhaseAQuestion));
socket.on("phase_a_status", (packet) => applyOneV100Packet(packet, (value) => renderPhaseAWaiting(value, currentRole === "crowd")));
socket.on("phase_b_start", (packet) => applyOneV100Packet(packet, renderPhaseB));
socket.on("lock_counts", (packet) => {
  if (gameMode === "one_v_100") applyOneV100Packet(packet, (value) => {
    if (currentPhase === "PHASE_A") setProgress(value);
  });
});
socket.on("phase_a_locked", (packet) => {
  applyOneV100Packet(packet, (value) => {
    observeTime(value);
    phase.textContent = "Answers in";
    answerStatus.textContent = `${value.locked_count} answers are in.`;
    clearInterval(countdownTimer);
    currentPhase = "PHASE_A_LOCKED";
    setProgress(value, "Answers in");
    countdown.textContent = "Ready";
  });
});
socket.on("phase_state", (packet) => {
  if (gameMode === "one_v_100") {
    applyOneV100Packet(packet, (value) => {
      observeTime(value);
      if (value.phase === "PAUSED") startCountdown(null);
      if (value.phase === "PHASE_A") startCountdown(value.deadline_ms);
    });
    return;
  }
  observeTime(packet);
  if (packet.phase === "PAUSED") startCountdown(null);
  if (packet.phase === "QUESTION_OPEN") startCountdown(packet.deadline_ms);
});
socket.on("reveal", (packet) => {
  if (gameMode === "one_v_100" || !Array.isArray(packet.outcomes)) applyOneV100Packet(packet, showOneV100Reveal);
  else showReveal(packet);
});
socket.on("leaderboard", (packet) => {
  if (gameMode === "one_v_100") {
    applyOneV100Packet(packet, (value) => scheduleTerminalMoment(() => renderStudentStandings(value), 0));
  } else renderStudentStandings(packet);
});
socket.on("strike", (packet) => {
  if (gameMode !== "one_v_100") return;
  applyOneV100Packet(packet, (value) => {
    currentStrikes = value.remaining;
    renderShowBoard();
  });
});
socket.on("game_end", (packet) => applyOneV100Packet(packet, (value) => scheduleTerminalMoment(() => renderGameEnd(value), 4_000)));
socket.on("next_game", (packet) => applyOneV100Packet(packet, renderNextGame));
socket.on("state_snapshot", renderSnapshot);
socket.on("roster_update", updateRoster);
socket.on("presence", (packet) => updateRoster([packet]));
socket.on("pause_state", (packet) => {
  if (gameMode !== "one_v_100") return;
  applyOneV100Packet(packet, (value) => {
    restorePause({ active: value.paused === true, reason: value.reason });
    if (value.paused !== true && Number.isFinite(value.deadline_ms) && currentPhase === "PHASE_A") {
      startCountdown(value.deadline_ms);
    }
  });
});
socket.on("help_poll_result", (packet) => applyOneV100Packet(packet, (value) => showHelpResult("poll", value)));
socket.on("help_ask_result", (packet) => applyOneV100Packet(packet, (value) => showHelpResult("ask", value)));
socket.on("help_trust_result", (packet) => applyOneV100Packet(packet, (value) => showHelpResult("trust", value)));
socket.on("command_error", (packet) => {
  if (packet.message) answerStatus.textContent = packet.message;
});
socket.on("disconnect", () => {
  connection.classList.add("offline");
  connection.lastChild.textContent = " Reconnecting…";
});
socket.on("connect", () => {
  connection.classList.remove("offline");
  connection.lastChild.textContent = " Live classroom game";
  if (!suppressResume) resumeStoredIdentity();
});
