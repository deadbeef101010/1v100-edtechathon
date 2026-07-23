import { createAvatar } from "./avatar.js";
import { createClockOffsetEstimator } from "./clock-offset.js";

const sessionId = location.pathname.split("/").filter(Boolean).at(-1);
const fragment = new URLSearchParams(location.hash.slice(1));
const storageKey = `projector:${sessionId}`;
const fromFragment = fragment.get("token");
const codeFromFragment = fragment.get("code");
if (fromFragment && codeFromFragment) {
  localStorage.setItem(storageKey, JSON.stringify({ token: fromFragment, code: codeFromFragment }));
  history.replaceState(null, "", location.pathname);
}

const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
const code = document.querySelector("#show-code");
const joinAddress = document.querySelector("#join-address");
const count = document.querySelector("#player-count");
const roster = document.querySelector("#roster");
const lobby = document.querySelector("#projector-lobby");
const standings = document.querySelector("#standings");
const standingsRows = document.querySelector("#standings-rows");
const live = document.querySelector("#projector-live");
const livePhase = document.querySelector("#projector-phase");
const question = document.querySelector("#projector-question");
const countdown = document.querySelector("#projector-countdown");
const lockCount = document.querySelector("#lock-count");
const choices = document.querySelector("#projector-choices");
const reveal = document.querySelector("#projector-reveal");
const showStage = document.querySelector("#show-stage");
const showGame = document.querySelector("#show-game");
const showOne = document.querySelector("#show-one");
const showMobCount = document.querySelector("#show-mob-count");
const showBank = document.querySelector("#show-bank");
const showStrikes = document.querySelector("#show-strikes");
const showRoll = document.querySelector("#show-roll");
const showRollValue = document.querySelector("#show-roll-value");
const showPhase = document.querySelector("#show-phase");
const showHeadline = document.querySelector("#show-headline");
const showDetail = document.querySelector("#show-detail");
const showProgress = document.querySelector("#show-progress");
const showProgressCount = document.querySelector("#show-progress-count");
const showProgressFill = document.querySelector("#show-progress-fill");
const showQuestionPanel = document.querySelector("#show-question-panel");
const showQuestion = document.querySelector("#show-question");
const showChoices = document.querySelector("#show-choices");
const showHelps = document.querySelector("#show-helps");
const showHelpResult = document.querySelector("#show-help-result");
const showDeltas = document.querySelector("#show-deltas");
const showLeaderboard = document.querySelector("#show-leaderboard");
const showPause = document.querySelector("#show-pause");
const clock = createClockOffsetEstimator();
const revealHoldMs = 6_000;
let countdownTimer = null;
let revealHoldTimer = null;
let revealHoldUntil = 0;
let pendingStandings = null;
let lastCelebration = null;
let lastServerSeq = 0;
let showMode = "generic";
let showState = {
  ordinal: null,
  one: null,
  mobCount: null,
  deckSize: null,
  bank: 0,
  strikes: null,
  choices: [],
  roster: new Map(),
  demoted: new Set(),
  leaderboard: [],
};
let showTimers = [];
let nextShowMomentAt = 0;
let showingHandoff = false;
code.textContent = saved?.code ?? "------";
joinAddress.textContent = `${window.location.origin}/join`;

function render(players) {
  if (showMode === "one_v_100") updateShowRoster(players);
  roster.replaceChildren(
    ...players.map((player) => {
      const item = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = player.connected ? player.nickname : `${player.nickname} / reconnecting`;
      item.append(createAvatar(player.nickname, sessionId), name);
      item.classList.toggle("disconnected", !player.connected);
      if (player.role === "one") {
        item.classList.add("the-one");
        const chip = document.createElement("small");
        chip.className = "one-chip";
        chip.textContent = "★ Spotlight";
        name.append(chip);
      }
      return item;
    }),
  );
  count.textContent = `${players.length} ${players.length === 1 ? "player" : "players"} ready`;
}

function renderStandings({ rows }) {
  standings.hidden = false;
  lobby.hidden = true;
  live.hidden = true;
  roster.hidden = true;
  standingsRows.replaceChildren(
    ...rows.slice(0, 5).map((player) => {
      const item = document.createElement("li");
      const rank = document.createElement("strong");
      const score = document.createElement("span");
      const identity = document.createElement("span");
      identity.className = "standing-identity";
      rank.textContent = `${player.rank}. ${player.nickname}`;
      score.textContent = `${player.points} points`;
      identity.append(createAvatar(player.nickname, sessionId), rank);
      item.append(identity, score);
      item.classList.toggle("disconnected", !player.connected);
      if (player.player_id === showState.one?.id) {
        item.classList.add("the-one");
        const chip = document.createElement("small");
        chip.className = "one-chip";
        chip.textContent = "★ In the Spotlight";
        rank.append(chip);
      }
      return item;
    }),
  );
}

function cancelRevealHold() {
  clearTimeout(revealHoldTimer);
  revealHoldTimer = null;
  revealHoldUntil = 0;
  pendingStandings = null;
}

function queueStandings(packet) {
  const remainingMs = revealHoldUntil - Date.now();
  if (remainingMs <= 0) {
    renderStandings(packet);
    return;
  }
  pendingStandings = packet;
  clearTimeout(revealHoldTimer);
  revealHoldTimer = setTimeout(() => {
    if (pendingStandings) renderStandings(pendingStandings);
    cancelRevealHold();
  }, remainingMs);
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
  cancelRevealHold();
  observeTime(packet);
  live.hidden = false;
  lobby.hidden = true;
  standings.hidden = true;
  roster.hidden = true;
  livePhase.textContent = "Everybody Answers";
  question.textContent = packet.prompt;
  lockCount.textContent = "0 answers in";
  reveal.hidden = true;
  choices.replaceChildren(...packet.choices.map((label, index) => {
    const item = document.createElement("div");
    const marker = document.createElement("strong");
    const answer = document.createElement("span");
    item.className = "answer-choice";
    marker.textContent = String.fromCharCode(65 + index);
    answer.textContent = label;
    item.append(marker, answer);
    return item;
  }));
  startCountdown(packet.deadline_ms);
}

function renderLockCount(packet) {
  observeTime(packet);
  lockCount.textContent = `${packet.locked_count} of ${packet.eligible_count} answers in`;
}

function renderReveal(packet) {
  observeTime(packet);
  clearInterval(countdownTimer);
  clearTimeout(revealHoldTimer);
  revealHoldUntil = Date.now() + revealHoldMs;
  pendingStandings = null;
  livePhase.textContent = "The Reveal";
  reveal.hidden = false;
  reveal.textContent = `${String.fromCharCode(65 + packet.correct_choice)} is correct.`;
  [...choices.children].forEach((item, index) => {
    const tally = document.createElement("small");
    tally.textContent = `${packet.counts[index] ?? 0} chose this`;
    item.append(tally);
    item.classList.toggle("correct", index === packet.correct_choice);
  });
  celebrateReveal(packet);
}

function celebrateReveal(packet) {
  const correctCount = packet.counts[packet.correct_choice] ?? 0;
  const answerCount = packet.counts.reduce((total, count) => total + count, 0);
  if (correctCount <= answerCount / 2) return;
  const signature = `${packet.attempt_id ?? "question"}:${packet.correct_choice}`;
  if (signature === lastCelebration || typeof window.confetti !== "function") return;
  lastCelebration = signature;
  const shared = {
    particleCount: 28,
    spread: 55,
    ticks: 120,
    colors: ["#ee5d36", "#f1bd48", "#8ed2e5", "#ffffff"],
    disableForReducedMotion: true,
    useWorker: true,
  };
  window.confetti({ ...shared, angle: 58, origin: { x: 0, y: 0.72 } });
  window.confetti({ ...shared, angle: 122, origin: { x: 1, y: 0.72 } });
}

function serverSeq(packet) {
  return Number.isSafeInteger(packet?.server_seq) ? packet.server_seq : null;
}

function applyShowPacket(packet, apply) {
  const sequence = serverSeq(packet);
  if (sequence !== null && sequence <= lastServerSeq) return false;
  if (sequence !== null) lastServerSeq = sequence;
  apply(packet);
  return true;
}

function applyShowSnapshot(snapshot) {
  const sequence = serverSeq(snapshot);
  if (sequence !== null && sequence <= lastServerSeq) return false;
  renderShowSnapshot(snapshot);
  if (sequence !== null) lastServerSeq = sequence;
  return true;
}

function renderSnapshot(snapshot) {
  if (snapshot?.session?.mode === "one_v_100" || snapshot?.game !== undefined || showMode === "one_v_100") {
    applyShowSnapshot(snapshot);
    return;
  }
  if (!snapshot?.attempt_id || !snapshot.question) return;
  renderQuestion({
    ...snapshot.question,
    attempt_id: snapshot.attempt_id,
    deadline_ms: snapshot.deadline_ms,
    server_time_ms: snapshot.server_time_ms
  });
  renderLockCount(snapshot);
  if (snapshot.phase === "LOCKED") {
    livePhase.textContent = "Answers in";
    clearInterval(countdownTimer);
    countdown.textContent = "Ready";
  } else if (snapshot.phase === "PAUSED") {
    livePhase.textContent = "Paused";
    startCountdown(null);
  } else if (snapshot.phase === "REVEALED") {
    livePhase.textContent = "The Reveal";
    clearInterval(countdownTimer);
    countdown.textContent = "Complete";
  }
}

function normalizeOne(snapshotOne) {
  if (!snapshotOne) return null;
  return { id: snapshotOne.player_id ?? snapshotOne.id, nickname: snapshotOne.nickname };
}

function restoreShowPause(paused) {
  const active = paused?.active === true || paused === true;
  showPause.hidden = !active;
  const detail = showPause.querySelector("span");
  if (active && detail && typeof paused?.reason === "string") {
    detail.textContent = paused.reason === "one_disconnected"
      ? "Waiting for the Spotlight Player to reconnect"
      : "The show will continue when the room is ready";
  }
}

function renderShowSnapshot(snapshot) {
  const gameSnapshot = snapshot.game ?? snapshot;
  const questionSnapshot = gameSnapshot.question;
  const phaseName = gameSnapshot.phase === "PAUSED"
    ? (questionSnapshot?.prompt ? "PHASE_B" : "PHASE_A")
    : gameSnapshot.phase;
  enterShowMode();
  cancelShowQueue();
  showingHandoff = false;
  showState.ordinal = gameSnapshot.ordinal ?? showState.ordinal;
  showState.one = normalizeOne(gameSnapshot.one) ?? showState.one;
  showState.mobCount = Number.isFinite(gameSnapshot.mob_count)
    ? gameSnapshot.mob_count
    : Number.isFinite(gameSnapshot.crowd_count)
      ? gameSnapshot.crowd_count
      : showState.mobCount;
  showState.bank = Number.isFinite(gameSnapshot.bank) ? gameSnapshot.bank : showState.bank;
  showState.strikes = Number.isFinite(gameSnapshot.strikes_remaining)
    ? gameSnapshot.strikes_remaining
    : Number.isFinite(gameSnapshot.strikes)
      ? gameSnapshot.strikes
      : showState.strikes;
  showState.choices = Array.isArray(questionSnapshot?.choices) ? questionSnapshot.choices : [];
  showState.leaderboard = Array.isArray(snapshot.leaderboard) ? snapshot.leaderboard : [];
  updateShowBoard();

  const phasePacket = {
    ...gameSnapshot,
    ...(questionSnapshot ?? {}),
    bank: showState.bank,
    strikes: showState.strikes,
    helps_available: gameSnapshot.helps_available,
    deadline_ms: questionSnapshot?.deadline_ms,
    momentum: { enabled: gameSnapshot.momentum_enabled === true },
  };
  if (phaseName === "PHASE_A" || phaseName === "PHASE_A_LOCKED") {
    renderShowPhaseA(phasePacket);
    if (phaseName === "PHASE_A_LOCKED") {
      showHeadline.textContent = "Answers in!";
      showDetail.textContent = `${showState.one?.nickname ?? "The Spotlight Player"}, the Spotlight Round is next.`;
      clearInterval(countdownTimer);
    }
  } else if ((phaseName === "PHASE_B" || phaseName === "REVEAL") && questionSnapshot) {
    renderShowPhaseB(phasePacket);
    if (phaseName === "REVEAL") {
      showPhase.textContent = "The Reveal";
      showHeadline.textContent = "The answer is in";
      showDetail.textContent = "The result is on the board.";
    }
  } else if (phaseName === "LEADERBOARD") {
    if (gameSnapshot.last_result) renderShowGameEndNow(gameSnapshot.last_result);
    renderShowLeaderboardNow(showState.leaderboard, gameSnapshot.last_result !== undefined);
  } else if (phaseName === "SESSION_ENDED") {
    renderShowSessionEndNow(showState.leaderboard);
  } else {
    resetShowMoment();
    showPhase.textContent = gameSnapshot.ordinal ? `Game ${gameSnapshot.ordinal}` : "Today’s show";
    showHeadline.textContent = gameSnapshot.one?.nickname
      ? `${gameSnapshot.one.nickname} is in the Spotlight`
      : "The show is getting ready";
    showDetail.textContent = `${showState.mobCount ?? 0} on the Challenge Team. The next question is on its way.`;
  }
  restoreShowPause(gameSnapshot.paused);
}

function enterShowMode() {
  showMode = "one_v_100";
  document.body.dataset.gameMode = "one-v-100";
  showStage.hidden = false;
  lobby.hidden = true;
  live.hidden = true;
  standings.hidden = true;
  roster.hidden = true;
}

function cancelShowQueue() {
  for (const timer of showTimers) clearTimeout(timer);
  showTimers = [];
  nextShowMomentAt = 0;
}

function scheduleShowMoment(renderMoment, holdMs = 0) {
  const now = Date.now();
  const startsAt = Math.max(now, nextShowMomentAt);
  nextShowMomentAt = startsAt + holdMs;
  if (startsAt === now) {
    renderMoment();
    return;
  }
  const timer = setTimeout(renderMoment, startsAt - now);
  showTimers.push(timer);
}

function resetShowMoment() {
  clearInterval(countdownTimer);
  showProgress.hidden = true;
  showQuestionPanel.hidden = true;
  showQuestion.textContent = "";
  showChoices.replaceChildren();
  showHelps.hidden = true;
  showHelps.replaceChildren();
  showHelpResult.hidden = true;
  showHelpResult.replaceChildren();
  showDeltas.hidden = true;
  showDeltas.replaceChildren();
  showLeaderboard.hidden = true;
  showLeaderboard.replaceChildren();
}

function updateShowBoard() {
  showGame.textContent = showState.ordinal ?? "--";
  showOne.textContent = showState.one?.nickname ?? "Getting ready";
  showMobCount.textContent = showState.mobCount ?? "--";
  showBank.textContent = showState.bank ?? 0;
  showStrikes.textContent = showState.strikes ?? "--";
}

function updateShowRoster(players) {
  if (!Array.isArray(players)) return;
  showState.roster = new Map(players.map((player) => [player.player_id, player]));
  const one = players.find((player) => player.role === "one");
  if (one) showState.one = { id: one.player_id, nickname: one.nickname };
  const mobCount = players.filter((player) => player.role === "mob").length;
  if (mobCount > 0 || players.some((player) => player.role === "crowd")) showState.mobCount = mobCount;
  updateShowBoard();
}

function renderGameStart(packet) {
  enterShowMode();
  cancelShowQueue();
  showState.ordinal = packet.ordinal;
  showState.one = packet.one;
  showState.mobCount = packet.mob_count;
  showState.deckSize = packet.deck_size;
  showState.bank = 0;
  showState.strikes = packet.base_strikes;
  showState.choices = [];
  showState.demoted = new Set();
  updateShowBoard();
  if (showingHandoff) return;
  resetShowMoment();
  showPhase.textContent = `Game ${packet.ordinal ?? ""}`.trim();
  showHeadline.textContent = `${packet.one?.nickname ?? "A classmate"} steps into the Spotlight`;
  showDetail.textContent = `${packet.mob_count ?? 0} on the Challenge Team. ${packet.deck_size ?? 0} questions stand between them and the finish.`;
}

function setShowProgress(packet) {
  const locked = Number.isFinite(packet.locked_count) ? packet.locked_count : 0;
  const eligible = Number.isFinite(packet.eligible_count) ? packet.eligible_count : 0;
  showProgress.hidden = false;
  showProgressCount.textContent = `${locked} / ${eligible}`;
  showProgressFill.style.transform = `scaleX(${eligible > 0 ? Math.min(1, locked / eligible) : 0})`;
}

function renderShowPhaseA(packet) {
  enterShowMode();
  cancelShowQueue();
  showingHandoff = false;
  resetShowMoment();
  observeTime(packet);
  // Phase A is status-only on this surface. Clear all question-bearing nodes.
  showQuestion.textContent = "";
  showChoices.replaceChildren();
  showQuestionPanel.hidden = true;
  showPhase.textContent = "Everybody Answers";
  showHeadline.textContent = "Answers in!";
  showDetail.textContent = `${showState.one?.nickname ?? "The Spotlight Player"} is ready. Get your answer in!`;
  setShowProgress(packet);
  updateShowRoll(packet.momentum);
  if (Number.isFinite(packet.deadline_ms)) startShowCountdown(packet.deadline_ms);
}

function startShowCountdown(deadlineMs) {
  clearInterval(countdownTimer);
  if (!Number.isFinite(deadlineMs)) return;
  const update = () => {
    const remaining = clock.remainingMs(deadlineMs);
    showDetail.textContent = `${showState.one?.nickname ?? "The Spotlight Player"} is ready. ${Math.ceil(remaining / 1_000)} seconds to answer.`;
    if (remaining <= 0) clearInterval(countdownTimer);
  };
  update();
  countdownTimer = setInterval(update, 250);
}

function createShowChoice(label, index) {
  const item = document.createElement("div");
  const marker = document.createElement("strong");
  const answer = document.createElement("span");
  item.className = "answer-choice";
  marker.textContent = String.fromCharCode(65 + index);
  answer.textContent = label;
  item.append(marker, answer);
  return item;
}

function renderShowPhaseB(packet) {
  enterShowMode();
  cancelShowQueue();
  showingHandoff = false;
  resetShowMoment();
  observeTime(packet);
  showState.bank = Number.isFinite(packet.bank) ? packet.bank : showState.bank;
  showState.strikes = Number.isFinite(packet.strikes) ? packet.strikes : showState.strikes;
  showState.choices = Array.isArray(packet.choices) ? packet.choices : [];
  updateShowBoard();
  updateShowRoll(packet.momentum);
  showPhase.textContent = "Spotlight Round";
  showHeadline.textContent = `${showState.one?.nickname ?? "Spotlight Player"}, it’s your turn`;
  showDetail.textContent = "The class has answered. Lifelines are ready, but the final call belongs to the Spotlight Player.";
  showQuestionPanel.hidden = false;
  showQuestion.textContent = packet.prompt ?? "Question incoming";
  showChoices.replaceChildren(...showState.choices.map(createShowChoice));
  const helpLabels = { poll: "Poll the Class", ask: "Ask Two", trust: "Go with the Class" };
  showHelps.hidden = false;
  showHelps.replaceChildren(...Object.entries(helpLabels).map(([name, label]) => {
    const item = document.createElement("span");
    const ready = packet.helps_available?.[name] === true;
    item.classList.toggle("used", !ready);
    item.textContent = `${label} / ${ready ? "Ready" : "Used"}`;
    return item;
  }));
}

function updateShowRoll(momentum) {
  showRoll.hidden = momentum?.enabled !== true;
  if (momentum?.enabled !== true) return;
  showRollValue.textContent = Number.isFinite(momentum.progress) ? String(momentum.progress) : "Building";
}

function showChoiceText(index) {
  const letter = String.fromCharCode(65 + index);
  return showState.choices[index] === undefined ? letter : `${letter}: ${showState.choices[index]}`;
}

function renderShowHelp(type, packet) {
  if (showMode !== "one_v_100") return;
  showHelpResult.hidden = false;
  showHelpResult.replaceChildren();
  if (type === "poll" && Number.isInteger(packet.choice)) {
    showPhase.textContent = "Poll the Class";
    showHelpResult.innerHTML = `<strong>${packet.count ?? 0} of ${packet.total_answers ?? 0}</strong><span>chose ${escapeText(showChoiceText(packet.choice))}</span><small>The class has spoken. ${escapeText(showState.one?.nickname ?? "Spotlight Player")}, it’s your call.</small>`;
  } else if (type === "ask" && Array.isArray(packet.speakers)) {
    showPhase.textContent = "Ask Two";
    const heading = document.createElement("strong");
    heading.textContent = "Two voices. Two reasons.";
    const speakers = document.createElement("div");
    speakers.className = "show-speakers";
    speakers.replaceChildren(...packet.speakers.map((speaker) => {
      const card = document.createElement("span");
      card.innerHTML = `<b>${escapeText(speaker.nickname)}</b><small>${escapeText(showChoiceText(speaker.choice))}</small><em>+${packet.bonus_each ?? 5} for sharing their thinking</em>`;
      return card;
    }));
    showHelpResult.append(heading, speakers);
  } else if (type === "trust" && Number.isInteger(packet.plurality_choice)) {
    showPhase.textContent = "Go with the Class";
    showHelpResult.innerHTML = `<strong>Answer in</strong><span>The class chose ${escapeText(showChoiceText(packet.plurality_choice))}</span>`;
    [...showChoices.children].forEach((item, index) => item.classList.toggle("locked", index === packet.plurality_choice));
  } else {
    showHelpResult.hidden = true;
  }
}

function escapeText(value) {
  const node = document.createElement("span");
  node.textContent = String(value);
  return node.innerHTML;
}

function rosterName(playerId) {
  return showState.roster.get(playerId)?.nickname ?? "A classmate";
}

function renderShowStrike(packet) {
  if (showMode !== "one_v_100") return;
  showState.strikes = packet.remaining;
  updateShowBoard();
  resetShowMoment();
  showPhase.textContent = "Spotlight result";
  showHeadline.textContent = "Not this time";
  showDetail.textContent = `${packet.remaining} ${packet.remaining === 1 ? "chance" : "chances"} left. The Challenge Team holds strong.`;
  nextShowMomentAt = Date.now() + 1_500;
}

function renderShowReveal(packet) {
  enterShowMode();
  showState.bank = Number.isFinite(packet.bank) ? packet.bank : showState.bank;
  const newDemotions = Array.isArray(packet.demoted)
    ? packet.demoted.filter((id) => !showState.demoted.has(id))
    : [];
  for (const playerId of newDemotions) showState.demoted.add(playerId);
  updateShowBoard();
  const scoreDeltas = Array.isArray(packet.score_deltas) ? packet.score_deltas : [];
  scheduleShowMoment(() => {
    resetShowMoment();
    showPhase.textContent = "The Reveal";
    showHeadline.textContent = `${showChoiceText(packet.correct_choice)} is correct`;
    showDetail.textContent = packet.one_correct
      ? `${showState.one?.nickname ?? "The Spotlight Player"} got it! +${packet.bank_delta ?? 0} to the Prize Pot.`
      : `Not this time. ${showState.strikes ?? 0} ${showState.strikes === 1 ? "chance" : "chances"} left.`;
    showQuestionPanel.hidden = false;
    showQuestion.textContent = "Here’s the answer";
    showChoices.replaceChildren(...showState.choices.map(createShowChoice));
    [...showChoices.children].forEach((item, index) => {
      const tally = document.createElement("small");
      tally.textContent = `${packet.counts?.[index] ?? 0} chose this`;
      item.append(tally);
      item.classList.toggle("correct", index === packet.correct_choice);
    });
    if (newDemotions.length > 0 || scoreDeltas.length > 0) {
      showDeltas.hidden = false;
      const demotion = document.createElement("p");
      if (newDemotions.length > 0) {
        const names = newDemotions.map(rosterName).join(", ");
        demotion.textContent = `${names} ${newDemotions.length === 1 ? "joins" : "join"} the Comeback Crew. They’re still playing!`;
        showDeltas.append(demotion);
      }
      const positive = scoreDeltas.filter((entry) => Number(entry.points) > 0).slice(0, 8);
      showDeltas.append(...positive.map((entry) => {
        const item = document.createElement("span");
        item.textContent = `${rosterName(entry.player_id)} +${entry.points}`;
        return item;
      }));
    }
  }, 3_000);
}

function renderShowGameEnd(packet) {
  if (showMode !== "one_v_100") return;
  showState.bank = Number.isFinite(packet.bank) ? packet.bank : showState.bank;
  updateShowBoard();
  scheduleShowMoment(() => {
    renderShowGameEndNow(packet);
    const payouts = Array.isArray(packet.payouts) ? packet.payouts : [];
    const teamPayouts = payouts.filter((entry) => entry.player_id !== showState.one?.id && Number(entry.points) > 0);
    if ((packet.reason === "flameout" && teamPayouts.length > 0) || packet.reason === "mob_emptied") celebrateGameEnd(packet);
  }, 5_000);
}

function renderShowGameEndNow(packet) {
  resetShowMoment();
  showState.bank = Number.isFinite(packet.bank) ? packet.bank : showState.bank;
  updateShowBoard();
  const payouts = Array.isArray(packet.payouts) ? packet.payouts : [];
  const onePayout = payouts.find((entry) => entry.player_id === showState.one?.id);
  const teamPayouts = payouts.filter((entry) => entry.player_id !== showState.one?.id && Number(entry.points) > 0);
  if (packet.reason === "flameout") {
    showPhase.textContent = "Game over / Challenge Team wins";
    showHeadline.textContent = "Challenge Team payday!";
    showDetail.textContent = teamPayouts.length > 0
      ? `${teamPayouts.length} Challenge Team ${teamPayouts.length === 1 ? "player wins" : "players win"} the Prize Pot. ${showState.one?.nickname ?? "The Spotlight Player"} keeps ${onePayout?.points ?? packet.banked_by_one ?? 0} points.`
      : `The Challenge Team holds the room. ${showState.one?.nickname ?? "The Spotlight Player"} keeps ${onePayout?.points ?? packet.banked_by_one ?? 0} points.`;
  } else if (packet.reason === "mob_emptied") {
    showPhase.textContent = "Game over / Jackpot";
    showHeadline.textContent = `Jackpot! ${showState.one?.nickname ?? "The Spotlight Player"} wins ${packet.banked_by_one ?? 0} points`;
    showDetail.textContent = "Everyone’s still playing with the Comeback Crew.";
  } else {
    showPhase.textContent = "Game over / All questions cleared";
    showHeadline.textContent = `${showState.one?.nickname ?? "The Spotlight Player"} cleared every question!`;
    showDetail.textContent = `${showState.one?.nickname ?? "The Spotlight Player"} wins the full Prize Pot. ${teamPayouts.length} Challenge Team ${teamPayouts.length === 1 ? "player earns" : "players earn"} a finish bonus.`;
  }
  if (payouts.length > 0) {
    showDeltas.hidden = false;
    showDeltas.replaceChildren(...payouts.slice(0, 10).map((entry) => {
      const item = document.createElement("span");
      item.textContent = `${rosterName(entry.player_id)} +${entry.points}`;
      return item;
    }));
  }
}

function celebrateGameEnd(packet) {
  const signature = `game-end:${packet.server_seq ?? packet.reason}`;
  if (signature === lastCelebration || typeof window.confetti !== "function") return;
  lastCelebration = signature;
  const jackpot = packet.reason === "mob_emptied";
  const shared = {
    particleCount: jackpot ? 52 : 28,
    spread: jackpot ? 72 : 55,
    ticks: jackpot ? 150 : 110,
    colors: ["#ee5d36", "#f1bd48", "#8ed2e5", "#ffffff"],
    disableForReducedMotion: true,
    useWorker: true,
  };
  window.confetti({ ...shared, angle: 58, origin: { x: 0, y: 0.72 } });
  window.confetti({ ...shared, angle: 122, origin: { x: 1, y: 0.72 } });
}

function renderShowLeaderboard(packet) {
  if (showMode !== "one_v_100") return;
  showState.leaderboard = Array.isArray(packet.rows) ? packet.rows : [];
  scheduleShowMoment(() => renderShowLeaderboardNow(showState.leaderboard), 4_000);
}

function renderShowLeaderboardNow(rows, preserveMoment = false) {
  if (!preserveMoment) {
    resetShowMoment();
    showPhase.textContent = "Today’s show";
    showHeadline.textContent = "Leaderboard";
    showDetail.textContent = "Every answer can move the standings. The next Spotlight Player is coming up.";
  }
  showLeaderboard.hidden = false;
  showLeaderboard.replaceChildren(...rows.slice(0, 8).map((player) => {
    const item = document.createElement("li");
    const identity = document.createElement("span");
    const name = document.createElement("strong");
    const score = document.createElement("span");
    identity.className = "standing-identity";
    name.textContent = `${player.rank}. ${player.nickname}`;
    if (player.player_id === showState.one?.id) {
      item.classList.add("the-one");
      const chip = document.createElement("small");
      chip.className = "one-chip";
      chip.textContent = "★ In the Spotlight";
      name.append(chip);
    } else if (player.has_been_one) {
      const marker = document.createElement("small");
      marker.textContent = "Spotlight turn";
      name.append(marker);
    }
    score.textContent = `${player.points} points`;
    identity.append(createAvatar(player.nickname, sessionId), name);
    item.append(identity, score);
    if (player.connected === false) item.classList.add("disconnected");
    return item;
  }));
}

function renderNextGame(packet) {
  if (showMode !== "one_v_100") return;
  cancelShowQueue();
  showingHandoff = true;
  showState.ordinal = packet.ordinal;
  showState.one = packet.one;
  updateShowBoard();
  resetShowMoment();
  showPhase.textContent = "Next Spotlight Player";
  showHeadline.textContent = `${packet.one?.nickname ?? "A classmate"} steps into the Spotlight next!`;
  showDetail.textContent = "Everyone rejoins the Challenge Team. New game, new streaks!";
}

function renderShowSessionEnd(packet) {
  if (showMode !== "one_v_100") {
    livePhase.textContent = "Today's show is over";
    clearInterval(countdownTimer);
    return;
  }
  const rows = Array.isArray(packet.final_leaderboard) ? packet.final_leaderboard : showState.leaderboard;
  scheduleShowMoment(() => renderShowSessionEndNow(rows));
}

function renderShowSessionEndNow(rows) {
  resetShowMoment();
  showPhase.textContent = "Today’s show";
  showHeadline.textContent = "What a finish!";
  const spotlightCount = rows.filter((player) => player.has_been_one).length;
  showDetail.textContent = `${spotlightCount} ${spotlightCount === 1 ? "Spotlight Player" : "Spotlight Players"}. One class show full of strong thinking.`;
  showLeaderboard.hidden = false;
  showLeaderboard.replaceChildren(...rows.slice(0, 8).map((player) => {
    const item = document.createElement("li");
    item.innerHTML = `<strong>${player.rank}. ${escapeText(player.nickname)}${player.has_been_one ? " / Spotlight turn" : ""}</strong><span>${player.points} points</span>`;
    return item;
  }));
}

if (!saved?.token) {
    count.textContent = "This projector link is missing. Ask your teacher to reopen it.";
} else {
  const socket = window.io({ transports: ["polling", "websocket"] });
  socket.on("connect", () => {
    socket.emit("projector_attach", { projector_token: saved.token }, (ack) => {
      if (!ack.ok) {
        cancelShowQueue();
        showStage.hidden = true;
        live.hidden = true;
        standings.hidden = true;
        lobby.hidden = false;
        roster.hidden = false;
        count.textContent = "This projector link has expired. Ask your teacher to reopen it.";
        return;
      }
      render(ack.roster);
      updateShowRoster(ack.roster);
      renderSnapshot(ack.snapshot);
    });
  });
  socket.on("roster_update", (players) => {
    render(players);
    updateShowRoster(players);
  });
  socket.on("presence", (player) => {
    if (!player?.player_id) return;
    const players = [...showState.roster.values()].filter((entry) => entry.player_id !== player.player_id);
    updateShowRoster([...players, player]);
  });
  socket.on("leaderboard", (packet) => {
    if (showMode === "one_v_100") applyShowPacket(packet, renderShowLeaderboard);
    else queueStandings(packet);
  });
  socket.on("question_open", renderQuestion);
  socket.on("game_start", (packet) => applyShowPacket(packet, renderGameStart));
  socket.on("phase_a_status", (packet) => applyShowPacket(packet, renderShowPhaseA));
  socket.on("phase_b_start", (packet) => applyShowPacket(packet, renderShowPhaseB));
  socket.on("lock_counts", (packet) => {
    if (showMode === "one_v_100") applyShowPacket(packet, setShowProgress);
    else renderLockCount(packet);
  });
  socket.on("phase_a_locked", (packet) => {
    if (showMode === "one_v_100") {
      applyShowPacket(packet, (value) => {
        setShowProgress(value);
        const locked = Number.isFinite(value.locked_count) ? value.locked_count : null;
        const eligible = Number.isFinite(value.eligible_count) ? value.eligible_count : null;
        const missed = locked !== null && eligible !== null ? eligible - locked : 0;
        showHeadline.textContent = "All answers are in!";
        showDetail.textContent = locked === null
          ? `${showState.one?.nickname ?? "The Spotlight Player"}, the Spotlight Round is next.`
          : `${locked} of ${eligible} locked in${missed > 0 ? ` (${missed} ran out of time)` : ""}. ${showState.one?.nickname ?? "The Spotlight Player"}, the Spotlight Round is next.`;
        clearInterval(countdownTimer);
      });
      return;
    }
    renderLockCount(packet);
    livePhase.textContent = "Answers in";
    clearInterval(countdownTimer);
  });
  socket.on("phase_state", (packet) => {
    if (showMode === "one_v_100") {
      applyShowPacket(packet, (value) => {
        observeTime(value);
        if (value.phase === "PAUSED") startCountdown(null);
        if (value.phase === "PHASE_A") startShowCountdown(value.deadline_ms);
      });
      return;
    }
    observeTime(packet);
    if (packet.phase === "PAUSED") startCountdown(null);
    if (packet.phase === "QUESTION_OPEN") startCountdown(packet.deadline_ms);
  });
  socket.on("reveal", (packet) => {
    if (showMode === "one_v_100") applyShowPacket(packet, renderShowReveal);
    else renderReveal(packet);
  });
  socket.on("strike", (packet) => applyShowPacket(packet, renderShowStrike));
  socket.on("game_end", (packet) => applyShowPacket(packet, renderShowGameEnd));
  socket.on("next_game", (packet) => applyShowPacket(packet, renderNextGame));
  socket.on("state_snapshot", renderSnapshot);
  socket.on("pause_state", (packet) => {
    if (showMode === "one_v_100") applyShowPacket(packet, (value) => {
      restoreShowPause({ active: value.paused === true, reason: value.reason });
      if (value.paused !== true && Number.isFinite(value.deadline_ms)) startShowCountdown(value.deadline_ms);
    });
  });
  socket.on("help_poll_result", (packet) => applyShowPacket(packet, (value) => renderShowHelp("poll", value)));
  socket.on("help_ask_result", (packet) => applyShowPacket(packet, (value) => renderShowHelp("ask", value)));
  socket.on("help_trust_result", (packet) => applyShowPacket(packet, (value) => renderShowHelp("trust", value)));
  socket.on("session_end", (packet) => showMode === "one_v_100"
    ? applyShowPacket(packet, renderShowSessionEnd)
    : renderShowSessionEnd(packet));
  socket.on("session_ended", (packet) => showMode === "one_v_100"
    ? applyShowPacket(packet, renderShowSessionEnd)
    : renderShowSessionEnd(packet));
}
