import { createClockOffsetEstimator } from "./clock-offset.js";
import { createMiniProjector } from "./mini-projector.js";
import { createRequestId } from "./request-id.js";
import { createRequestIdRetainer } from "./request-id-retainer.js";
import { createServerSequenceTracker } from "./server-sequence.js";
import {
  bootstrapDecision,
  deckViewModel,
  LEGACY_CODE_TEXT,
  projectorCredential,
  sessionRowModel,
  uploadErrorModel,
} from "./teacher-client.js";

const loginSection = document.querySelector("#teacher-login");
const loginForm = document.querySelector("#teacher-login-form");
const teacherKey = document.querySelector("#teacher-key");
const consoleView = document.querySelector("#teacher-console");
const status = document.querySelector("#teacher-status");
const signOutButton = document.querySelector("#teacher-sign-out");
const backToListButton = document.querySelector("#back-to-session-list");
const sessionHome = document.querySelector("#session-home");
const sessionRows = document.querySelector("#session-rows");
const sessionList = document.querySelector("#session-list");
const sessionListEmpty = document.querySelector("#session-list-empty");
const showArchived = document.querySelector("#show-archived");
const newSessionButton = document.querySelector("#new-session");
const newSessionPanel = document.querySelector("#new-session-panel");
const backButton = document.querySelector("#back-to-sessions");
const createButton = document.querySelector("#create-session");
const details = document.querySelector("#session-details");
const code = document.querySelector("#teacher-show-code");
const projectorLink = document.querySelector("#projector-link");
const rotateCodeButton = document.querySelector("#rotate-session-code");
const controls = document.querySelector("#teacher-controls");
const phase = document.querySelector("#teacher-phase");
const question = document.querySelector("#teacher-question");
const countdown = document.querySelector("#teacher-countdown");
const lockCount = document.querySelector("#teacher-lock-count");
const rosterList = document.querySelector("#teacher-roster");
const oneStatus = document.querySelector("#teacher-one-status");
const openButton = document.querySelector("#teacher-open-question");
const pauseButton = document.querySelector("#teacher-pause");
const resumeButton = document.querySelector("#teacher-resume");
const revealButton = document.querySelector("#teacher-force-reveal");
const advanceButton = document.querySelector("#teacher-advance");
const endButton = document.querySelector("#teacher-end-session");
const timerSelect = document.querySelector("#teacher-timer-seconds");
const timerValue = document.querySelector("#teacher-timer-value");
const nextPrompt = document.querySelector("#teacher-next-prompt");
const showDeckButton = document.querySelector("#teacher-show-deck");
const deckDialog = document.querySelector("#teacher-deck-dialog");
const deckList = document.querySelector("#teacher-deck-list");
const closeDeckButton = document.querySelector("#teacher-close-deck");
const filterForm = document.querySelector("#question-set-filters");
const subjectFilter = document.querySelector("#question-subject");
const gradeFilter = document.querySelector("#question-grade");
const setPicker = document.querySelector("#question-set-picker");
const setList = document.querySelector("#question-set-list");
const setEmpty = document.querySelector("#question-set-empty");
const uploadForm = document.querySelector("#question-upload-form");
const uploadInput = document.querySelector("#question-upload");
const uploadErrors = document.querySelector("#question-upload-errors");
const clock = createClockOffsetEstimator();
const serverSequences = createServerSequenceTracker();
const uploadRequest = createRequestIdRetainer(createRequestId);
const createSessionRequest = createRequestIdRetainer(createRequestId);
const rotateCodeRequest = createRequestIdRetainer(createRequestId);
const projectorRequest = createRequestIdRetainer(createRequestId);
let socket = null;
let sessionId = null;
let attemptId = null;
let countdownTimer = null;
let selectedQuestionSetId = null;
let miniProjector = null;
let deck = null;
let rosterPlayers = [];
let currentOneId = null;
let showRunning = false;

function renderTeacherRoster() {
  if (!rosterList) return;
  if (rosterPlayers.length === 0) {
    const empty = document.createElement("li");
    empty.className = "roster-empty";
    empty.textContent = "No players yet. Share the join code!";
    rosterList.replaceChildren(empty);
    return;
  }
  rosterList.replaceChildren(...rosterPlayers.map((player) => {
    const item = document.createElement("li");
    const name = document.createElement("span");
    const action = document.createElement("button");
    const isOne = player.player_id === currentOneId || player.role === "one";
    name.textContent = player.connected ? player.nickname : `${player.nickname} (away)`;
    if (isOne) {
      const chip = document.createElement("small");
      chip.className = "one-chip";
      chip.textContent = "\u2605 The One";
      name.append(chip);
    }
    action.type = "button";
    action.className = "quiet-button roster-pick";
    action.textContent = showRunning ? "Spotlight next" : "Make the One";
    action.disabled = isOne || !player.connected;
    action.addEventListener("click", () => pickOne(player));
    item.append(name, action);
    item.classList.toggle("the-one", isOne);
    item.classList.toggle("disconnected", !player.connected);
    return item;
  }));
}

let showPhase = "BOUNDARY";
let showPaused = false;
let sessionOver = false;

function setPrimary(main, sub, disabled = false) {
  openButton.replaceChildren();
  openButton.append(main);
  if (sub) {
    const detail = document.createElement("small");
    detail.textContent = sub;
    openButton.append(document.createElement("br"), detail);
  }
  openButton.disabled = disabled;
}

function syncPrimaryButton() {
  openButton.classList.toggle("primary-action", true);
  if (!showRunning) {
    setPrimary("Open question", null);
    return;
  }
  // Single authority for 1v100 control states. Force reveal is the emergency
  // lever, only meaningful once The One has the question; the primary button
  // drives the normal show flow. Advance is folded into the primary.
  revealButton.classList.add("quiet-danger");
  revealButton.disabled = showPhase !== "PHASE_B" || showPaused;
  pauseButton.disabled = showPaused || (showPhase !== "PHASE_A" && showPhase !== "PHASE_B");
  resumeButton.disabled = !showPaused;
  advanceButton.disabled = true;
  if (showPaused) setPrimary("Show paused", "resume to continue", true);
  else if (showPhase === "PHASE_A") setPrimary("Class is answering", "waiting for lock", true);
  else if (showPhase === "PHASE_A_LOCKED") setPrimary("Open question", "for The One");
  else if (showPhase === "PHASE_B") setPrimary("The One is answering", "then reveal", true);
  else setPrimary("Open question", "for the class");
}

function pickOne(player) {
  if (!socket) return;
  const requestId = createRequestId();
  if (!showRunning) {
    oneStatus.textContent = `Starting the show with ${player.nickname} in the Spotlight...`;
    socket.emit("teacher_start_session", {
      request_id: requestId,
      first_one_player_id: player.player_id,
    }, (ack) => {
      if (!ack.ok) {
        oneStatus.textContent = ack.message ?? "Could not start the show. Try again.";
        return;
      }
      showRunning = true;
      syncPrimaryButton();
      currentOneId = player.player_id;
      oneStatus.textContent = `${player.nickname} is in the Spotlight. Open the first question when ready.`;
      renderTeacherRoster();
    });
    return;
  }
  socket.emit("teacher_select_next_one", {
    request_id: requestId,
    player_id: player.player_id,
  }, (ack) => {
    oneStatus.textContent = ack.ok
      ? `${player.nickname} takes the Spotlight next game.`
      : ack.message ?? "Could not set the next Spotlight Player.";
  });
}

const ONE_V_100_EVENTS = [
  "game_start", "next_game", "game_end", "leaderboard", "help_poll_result",
  "help_ask_result", "help_trust_result", "strike",
];

function closeDeck() {
  if (deckDialog.open) deckDialog.close();
}

function showSignedOut(message = "Enter your teacher key.") {
  unmountMiniProjector();
  sessionStorage.removeItem("teacher_token");
  socket?.disconnect();
  loginSection.hidden = false;
  consoleView.hidden = true;
  let loginStatus = loginSection.querySelector("[role=status]");
  if (!loginStatus) {
    loginStatus = document.createElement("p");
    loginStatus.setAttribute("role", "status");
    loginStatus.setAttribute("aria-live", "polite");
    loginSection.append(loginStatus);
  }
  loginStatus.textContent = message;
}

function showConsole() {
  loginSection.hidden = true;
  consoleView.hidden = false;
}

function endSessionTeardown(message) {
  sessionOver = true;
  showRunning = false;
  showPaused = false;
  showPhase = "BOUNDARY";
  currentOneId = null;
  clearInterval(countdownTimer);
  attemptId = null;
  sessionId = null;
  socket?.disconnect();
  unmountMiniProjector();
  showHome();
  status.textContent = message;
  void loadSessions();
}

function showHome() {
  sessionHome.hidden = false;
  newSessionPanel.hidden = true;
  details.hidden = true;
  controls.hidden = true;
  projectorLink.hidden = true;
  projectorLink.removeAttribute("href");
  closeDeck();
}

async function authenticatedFetch(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
  });
  if (response.status === 401) showSignedOut("Your sign-in expired. Enter your teacher key again.");
  return response;
}

function reflectTimer(seconds) {
  if (!Number.isInteger(seconds)) return;
  timerSelect.value = String(seconds);
  timerValue.textContent = `${seconds}s`;
}

function renderDeck() {
  const model = deckViewModel(deck);
  nextPrompt.textContent = model.nextPrompt;
  deckList.replaceChildren(...model.rows.map((entry) => {
    const item = document.createElement("li");
    item.className = "teacher-deck-row";
    if (entry.played) item.classList.add("is-played");
    if (entry.current) item.classList.add("is-current");
    const heading = document.createElement("h3");
    heading.textContent = `${entry.position}. ${entry.prompt}`;
    const choices = document.createElement("ol");
    choices.type = "A";
    for (const [index, choice] of entry.choices.entries()) {
      const answer = document.createElement("li");
      answer.textContent = choice;
      if (index === entry.correct_choice) {
        answer.className = "is-correct";
        answer.textContent = `✓ ${choice}`;
      }
      choices.append(answer);
    }
    item.append(heading, choices);
    return item;
  }));
}

async function refreshDeck() {
  if (sessionId === null) return;
  const requestedSessionId = sessionId;
  try {
    const response = await authenticatedFetch(
      `/api/teacher/sessions/${encodeURIComponent(requestedSessionId)}/deck`,
    );
    if (!response.ok || requestedSessionId !== sessionId) {
      if (response.status !== 401) nextPrompt.textContent = "Preview unavailable";
      return;
    }
    deck = await response.json();
    renderDeck();
    showDeckButton.disabled = false;
  } catch {
    nextPrompt.textContent = "Preview unavailable";
  }
}

async function loadSessions() {
  const response = await authenticatedFetch(
    `/api/teacher/sessions${showArchived.checked ? "?archived=1" : ""}`,
  );
  if (!response.ok) {
    if (response.status !== 401) status.textContent = "Could not load your sessions. Try again.";
    return false;
  }
  const body = await response.json();
  renderSessions(body.sessions);
  return true;
}

function renderSessions(sessions) {
  sessionRows.replaceChildren(...sessions.map((entry) => {
    const model = sessionRowModel(entry);
    const row = document.createElement("tr");
    if (model.archived) row.classList.add("session-row-archived");
    const cells = model.cells.map((value) => {
      const cell = document.createElement("td");
      cell.textContent = value;
      return cell;
    });
    row.append(...cells);
    if (model.rejoinable) {
      row.tabIndex = 0;
      row.className = "session-row";
      row.setAttribute("role", "button");
      row.setAttribute("aria-label", model.ariaLabel);
      const rejoin = () => attachTeacher(entry.session_id, entry.code);
      row.addEventListener("click", rejoin);
      row.addEventListener("keydown", (event) => {
        if (event.target === row && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          rejoin();
        }
      });
    }
    const actions = document.createElement("td");
    if (model.archived || model.canArchive) {
      const action = document.createElement("button");
      action.type = "button";
      action.className = "quiet-button session-archive-action";
      action.textContent = model.archived ? "Unarchive" : model.archiveLabel;
      action.addEventListener("click", async (event) => {
        event.stopPropagation();
        const verb = model.archived ? "unarchive" : "archive";
        const prompt = model.archived
          ? "Show this session in your main session list again?"
          : entry.status === "lobby"
            ? "End and archive this waiting-room session? Students will no longer be able to join."
            : "Archive this ended session? You can show archived sessions and restore it later.";
        if (!window.confirm(prompt)) return;
        action.disabled = true;
        let response;
        try {
          response = await authenticatedFetch(
            `/api/teacher/sessions/${encodeURIComponent(entry.session_id)}/${verb}`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ request_id: createRequestId() }),
            },
          );
        } catch {
          status.textContent = `Could not ${verb} this session. Try again.`;
          action.disabled = false;
          return;
        }
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          status.textContent = body.message ?? `Could not ${verb} this session. Try again.`;
          action.disabled = false;
          return;
        }
        status.textContent = model.archived
          ? "Session restored to your main list."
          : "Session archived. Its game history is safely kept.";
        await loadSessions();
      });
      actions.append(action);
    }
    row.append(actions);
    return row;
  }));
  sessionListEmpty.hidden = sessions.length > 0;
  sessionList.hidden = sessions.length === 0;
  status.textContent = sessions.length > 0
    ? "Choose a session to rejoin, or start a new one."
    : showArchived.checked
      ? "No sessions to show. Start a new one when your class is ready."
      : "Start a new session when your class is ready.";
}

async function loadQuestionSets(preselectId = null) {
  const parameters = new URLSearchParams();
  if (subjectFilter.value.trim()) parameters.set("subject", subjectFilter.value.trim());
  if (gradeFilter.value.trim()) parameters.set("grade", gradeFilter.value.trim());
  const response = await authenticatedFetch(`/api/question-sets?${parameters}`);
  if (!response.ok) {
    if (response.status !== 401) status.textContent = "Could not load question sets. Try again.";
    return;
  }
  const body = await response.json();
  selectedQuestionSetId = null;
  setList.replaceChildren();
  setPicker.disabled = false;
  setEmpty.hidden = body.question_sets.length > 0;
  setEmpty.textContent = "No question sets match these filters.";
  for (const questionSet of body.question_sets) {
    const label = document.createElement("label");
    label.className = "set-option";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "question-set";
    input.value = questionSet.question_set_id;
    input.checked = questionSet.question_set_id === preselectId;
    input.addEventListener("change", () => {
      selectedQuestionSetId = input.value;
      createSessionRequest.reset();
      createButton.disabled = false;
    });
    if (input.checked) selectedQuestionSetId = input.value;
    const description = document.createElement("span");
    description.textContent = `${questionSet.title} · ${questionSet.subject} · Grade ${questionSet.grade} · ${questionSet.question_count} questions`;
    label.append(input, description);
    setList.append(label);
  }
  createButton.disabled = selectedQuestionSetId === null;
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

function setPhase(next) {
  phase.textContent = next;
  if (showRunning) {
    // 1v100: syncPrimaryButton is the single authority over control states;
    // generic-phase gating must not fight it.
    syncPrimaryButton();
    return;
  }
  pauseButton.disabled = next !== "Question open";
  resumeButton.disabled = next !== "Paused";
  revealButton.disabled = next !== "Question open" && next !== "Answers locked";
  advanceButton.disabled = next !== "Reveal";
  openButton.disabled = !["Lobby", "Between questions", "Reveal"].includes(next);
}

function renderSnapshot(snapshot) {
  serverSequences.applySnapshot(sessionId, snapshot);
  if (!snapshot?.attempt_id || !snapshot.question) {
    attemptId = null;
    question.textContent = "Waiting for a question.";
    lockCount.textContent = "0 answers in";
    countdown.textContent = "--";
    setPhase("Lobby");
    return;
  }
  observeTime(snapshot);
  attemptId = snapshot.attempt_id;
  question.textContent = snapshot.question.prompt;
  lockCount.textContent = `${snapshot.locked_count} of ${snapshot.eligible_count} answers in`;
  const labels = {
    QUESTION_OPEN: "Question open",
    LOCKED: "Answers locked",
    REVEALED: "Reveal",
    PAUSED: "Paused",
  };
  setPhase(labels[snapshot.phase] ?? "Lobby");
  if (snapshot.phase === "QUESTION_OPEN") startCountdown(snapshot.deadline_ms);
  else if (snapshot.phase === "PAUSED") startCountdown(null);
  else {
    clearInterval(countdownTimer);
    countdown.textContent = snapshot.phase === "LOCKED" ? "Locked" : "Complete";
  }
}

function storeProjectorCredential(nextSessionId, token, showCode) {
  localStorage.setItem(`projector:${nextSessionId}`, JSON.stringify({ token, code: showCode }));
  projectorLink.href = `/projector/${nextSessionId}`;
  projectorLink.hidden = false;
}

function prepareProjector(nextSessionId, showCode) {
  const stored = projectorCredential(localStorage.getItem(`projector:${nextSessionId}`), nextSessionId);
  if (stored !== null) {
    storeProjectorCredential(nextSessionId, stored.token, showCode ?? stored.code);
    return;
  }
  projectorLink.hidden = true;
  projectorLink.removeAttribute("href");
  socket.emit("teacher_rotate_projector_credential", {
    request_id: projectorRequest.current(),
  }, (ack) => {
    if (!ack.ok) {
      if (ack.code !== "RATE_LIMITED") projectorRequest.clear();
      status.textContent = ack.message ?? "Could not prepare the projector. Try rejoining.";
      return;
    }
    projectorRequest.clear();
    storeProjectorCredential(nextSessionId, ack.projector_token, showCode);
  });
}

function attachTeacher(nextSessionId, showCode = null) {
  sessionId = nextSessionId;
  projectorRequest.clear();
  projectorLink.hidden = true;
  projectorLink.removeAttribute("href");
  deck = null;
  showDeckButton.disabled = true;
  nextPrompt.textContent = "Loading deck...";
  socket?.disconnect();
  socket = window.io({
    withCredentials: true,
    transports: ["polling", "websocket"],
  });
  socket.on("connect", () => {
    socket.emit("teacher_attach", { session_id: sessionId }, (ack) => {
      if (!ack.ok) {
        status.textContent = ack.message ?? "Could not rejoin that session.";
        return;
      }
      const finish = () => {
        sessionHome.hidden = true;
        newSessionPanel.hidden = true;
        controls.hidden = false;
        details.hidden = false;
        code.textContent = showCode ?? LEGACY_CODE_TEXT;
        rotateCodeButton.hidden = false;
        prepareProjector(nextSessionId, showCode);
        renderSnapshot(ack.snapshot);
        reflectTimer(ack.phase_a_seconds);
        void refreshDeck();
        sessionOver = false;
        rosterPlayers = Array.isArray(ack.roster) ? ack.roster.map((entry) => ({ ...entry })) : [];
        const snapshotOne = ack.snapshot?.game?.one;
        if (snapshotOne?.player_id ?? snapshotOne?.id) {
          currentOneId = snapshotOne.player_id ?? snapshotOne.id;
          showRunning = true;
        }
        syncPrimaryButton();
        renderTeacherRoster();
        status.textContent = ack.snapshot ? "Rejoined the live session." : "Session ready in the lobby.";
        mountMiniProjector(nextSessionId);
      };
      finish();
    });
  });
  socket.on("connect_error", () => {
    status.textContent = "Could not connect to the session. Try again.";
  });
  function onSequenced(event, handler) {
    socket.on(event, (packet) => {
      if (serverSequences.accept(sessionId, packet)) handler(packet);
    });
  }
  socket.on("roster_update", (packet) => {
    if (Array.isArray(packet)) rosterPlayers = packet.map((entry) => ({ ...entry }));
    else if (Array.isArray(packet?.roster)) rosterPlayers = packet.roster.map((entry) => ({ ...entry }));
    renderTeacherRoster();
  });
  socket.on("presence", (packet) => {
    const row = rosterPlayers.find((player) => player.player_id === packet.player_id);
    if (row) {
      row.connected = packet.connected;
      if (packet.role) row.role = packet.role;
    } else if (packet.player_id) {
      rosterPlayers.push({ ...packet });
    }
    renderTeacherRoster();
  });
  onSequenced("game_end", () => {
    showPhase = "BOUNDARY";
    syncPrimaryButton();
  });
  onSequenced("game_start", (packet) => {
    showRunning = true;
    showPhase = "BOUNDARY";
    showPaused = false;
    syncPrimaryButton();
    currentOneId = packet.one?.player_id ?? packet.one?.id ?? currentOneId;
    oneStatus.textContent = packet.one?.nickname
      ? `${packet.one.nickname} is in the Spotlight.`
      : "The show is running.";
    renderTeacherRoster();
  });
  onSequenced("next_game", (packet) => {
    currentOneId = packet.one?.player_id ?? packet.one?.id ?? currentOneId;
    renderTeacherRoster();
  });
  onSequenced("session_end", () => {
    oneStatus.textContent = "The show has ended.";
    renderTeacherRoster();
    endSessionTeardown("The show has ended. Choose or start another session.");
  });
  onSequenced("question_open", (packet) => {
    observeTime(packet);
    attemptId = packet.attempt_id;
    question.textContent = packet.prompt;
    lockCount.textContent = "0 answers in";
    setPhase("Question open");
    startCountdown(packet.deadline_ms);
  });
  onSequenced("phase_a_start", (packet) => {
    observeTime(packet);
    attemptId = packet.attempt_id;
    question.textContent = packet.prompt;
    lockCount.textContent = "0 answers in";
    setPhase("Question open");
    startCountdown(packet.deadline_ms);
  });
  onSequenced("phase_b_start", (packet) => {
    observeTime(packet);
    showPhase = "PHASE_B";
    syncPrimaryButton();
    attemptId = packet.attempt_id;
    question.textContent = packet.prompt;
    setPhase("Question open");
    startCountdown(null);
  });
  onSequenced("lock_counts", (packet) => {
    observeTime(packet);
    lockCount.textContent = `${packet.locked_count} of ${packet.eligible_count} answers in`;
  });
  onSequenced("phase_a_status", (packet) => {
    observeTime(packet);
    if (showRunning && showPhase === "BOUNDARY") {
      showPhase = "PHASE_A";
      syncPrimaryButton();
    }
    lockCount.textContent = `${packet.locked_count} of ${packet.eligible_count} answers in`;
  });
  onSequenced("phase_a_locked", (packet) => {
    observeTime(packet);
    showPhase = "PHASE_A_LOCKED";
    syncPrimaryButton();
    lockCount.textContent = `${packet.locked_count} of ${packet.eligible_count} answers locked`;
    setPhase("Answers locked");
    clearInterval(countdownTimer);
  });
  onSequenced("phase_state", (packet) => {
    if (sessionOver) return;
    observeTime(packet);
    if (packet.phase === "PAUSED") {
      setPhase("Paused");
      startCountdown(null);
    } else if (packet.phase === "QUESTION_OPEN") {
      setPhase("Question open");
      startCountdown(packet.deadline_ms);
    } else if (packet.phase === "LOBBY") setPhase("Between questions");
  });
  onSequenced("pause_state", (packet) => {
    if (sessionOver) return;
    observeTime(packet);
    if (showRunning) {
      showPaused = packet.paused === true;
      syncPrimaryButton();
    }
    if (packet.paused) {
      setPhase("Paused");
      startCountdown(null);
    } else if (Number.isFinite(packet.deadline_ms)) {
      setPhase("Question open");
      startCountdown(packet.deadline_ms);
    }
  });
  onSequenced("reveal", (packet) => {
    observeTime(packet);
    if (showRunning) {
      showPhase = "BOUNDARY";
      syncPrimaryButton();
    }
    setPhase("Reveal");
    question.textContent = `${String.fromCharCode(65 + packet.correct_choice)} is correct`;
    clearInterval(countdownTimer);
    void refreshDeck();
  });
  for (const event of ONE_V_100_EVENTS) onSequenced(event, observeTime);
  onSequenced("session_ended", () => {
    endSessionTeardown("Session ended. Choose or start another session.");
  });
}

function emitControl(event) {
  if (!socket) return;
  // 1v100 controls route by session state server-side; only generic-round
  // controls need a live attempt id.
  if (!showRunning && !attemptId && event !== "teacher_advance") return;
  const payload = { request_id: createRequestId() };
  if (attemptId) payload.attempt_id = attemptId;
  socket.emit(event, payload, (ack) => {
    observeTime(ack);
    if (Number.isFinite(ack.deadline_ms)) startCountdown(ack.deadline_ms);
    if (!ack.ok) status.textContent = ack.message ?? "That control is not available right now.";
    else if (event === "teacher_force_reveal" || event === "teacher_advance") void refreshDeck();
  });
}

function openQuestion() {
  if (!socket) return;
  socket.emit("teacher_open_question", { request_id: createRequestId() }, (ack) => {
    observeTime(ack);
    if (!ack.ok) status.textContent = ack.message ?? "No question is ready yet.";
    else void refreshDeck();
  });
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const loginStatus = loginSection.querySelector("[role=status]");
  if (loginStatus) loginStatus.textContent = "Signing in...";
  try {
    const response = await fetch("/api/teacher/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: teacherKey.value }),
    });
    if (!response.ok) {
      showSignedOut("That teacher key was not accepted.");
      return;
    }
    await response.json();
    teacherKey.value = "";
    showConsole();
    showHome();
    await loadSessions();
  } catch {
    showSignedOut("Could not sign in right now. Try again.");
  }
});

newSessionButton.addEventListener("click", async () => {
  sessionHome.hidden = true;
  newSessionPanel.hidden = false;
  status.textContent = "Choose a question set for the new session.";
  await loadQuestionSets();
});

backButton.addEventListener("click", () => {
  showHome();
  void loadSessions();
});

filterForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void loadQuestionSets();
});

window.addEventListener("storage", (event) => {
  if (event.key === "teacher_signed_out") showSignedOut("Signed out in another tab.");
});

backToListButton?.addEventListener("click", () => {
  endSessionTeardown("Back at your sessions. The class can keep playing; rejoin any time.");
});

signOutButton.addEventListener("click", async () => {
  try {
    await fetch("/api/teacher/logout", { method: "POST", credentials: "same-origin" });
  } finally {
    localStorage.setItem("teacher_signed_out", String(Date.now()));
    showSignedOut("Signed out.");
  }
});

uploadInput.addEventListener("change", () => uploadRequest.reset());
showArchived.addEventListener("change", () => void loadSessions());

uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  uploadErrors.replaceChildren();
  const file = uploadInput.files?.[0];
  if (!file) return;
  status.textContent = "Checking your question file...";
  let response;
  try {
    response = await authenticatedFetch("/api/question-sets/import", {
      method: "POST",
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "x-file-name": file.name,
        "x-request-id": uploadRequest.current(),
      },
      body: file,
    });
  } catch {
    status.textContent = "Upload interrupted. Retry to safely continue the same upload.";
    return;
  }
  const body = await response.json();
  if (!response.ok) {
    const model = uploadErrorModel(response.status, body);
    for (const message of model.items) {
      const item = document.createElement("li");
      item.textContent = message;
      uploadErrors.append(item);
    }
    status.textContent = model.statusText;
    if (response.status < 500) uploadRequest.clear();
    return;
  }
  uploadRequest.clear();
  uploadForm.reset();
  subjectFilter.value = "";
  gradeFilter.value = "";
  await loadQuestionSets();
  status.textContent = `${body.questions_imported} questions uploaded. Choose the new set below.`;
});

createButton.addEventListener("click", async () => {
  const questionSetId = selectedQuestionSetId;
  if (questionSetId === null) return;
  createButton.disabled = true;
  let response;
  try {
    response = await authenticatedFetch("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: createSessionRequest.current(),
        question_set_id: questionSetId,
      }),
    });
  } catch {
    status.textContent = "Session creation was interrupted. Retry to safely continue.";
    createButton.disabled = false;
    return;
  }
  if (!response.ok) {
    if (response.status !== 401) status.textContent = "Could not create the session. Try again.";
    createButton.disabled = false;
    if (response.status < 500) createSessionRequest.clear();
    return;
  }
  createSessionRequest.clear();
  const session = await response.json();
  storeProjectorCredential(session.session_id, session.projector_token, session.code);
  status.textContent = "Session created. Connecting controls...";
  attachTeacher(session.session_id, session.code);
});

rotateCodeButton.addEventListener("click", () => {
  if (!socket || sessionId === null) return;
  rotateCodeButton.disabled = true;
  socket.emit("teacher_rotate_session_code", {
    request_id: rotateCodeRequest.current(),
  }, (ack) => {
    rotateCodeButton.disabled = false;
    if (!ack.ok) {
      if (ack.code !== "RATE_LIMITED") rotateCodeRequest.clear();
      status.textContent = ack.message ?? "Could not rotate the code. Try again.";
      return;
    }
    rotateCodeRequest.clear();
    code.textContent = ack.code;
    const stored = projectorCredential(localStorage.getItem(`projector:${sessionId}`), sessionId);
    if (stored !== null) storeProjectorCredential(sessionId, stored.token, ack.code);
    status.textContent = "Join code rotated. The old code no longer works.";
    void loadSessions();
  });
});

openButton.addEventListener("click", () => {
  // 1v100 shows advance via teacher_advance (generic teacher_open_question is
  // rejected by mode isolation); generic sessions keep the deck opener.
  if (showRunning) emitControl("teacher_advance");
  else openQuestion();
});
pauseButton.addEventListener("click", () => emitControl("teacher_pause"));
resumeButton.addEventListener("click", () => emitControl("teacher_resume"));
revealButton.addEventListener("click", () => emitControl("teacher_force_reveal"));
advanceButton.addEventListener("click", () => emitControl("teacher_advance"));
endButton.addEventListener("click", () => {
  if (!socket) return;
  socket.emit("teacher_end_session", { request_id: createRequestId() }, (ack) => {
    if (!ack.ok) status.textContent = ack.message ?? "Could not end the session.";
  });
});
timerSelect.addEventListener("change", () => {
  if (!socket) return;
  const previous = Number(timerValue.textContent.replace("s", ""));
  const seconds = Number(timerSelect.value);
  timerSelect.disabled = true;
  socket.emit("teacher_settings", {
    request_id: createRequestId(),
    phase_a_seconds: seconds,
  }, (ack) => {
    timerSelect.disabled = false;
    if (!ack.ok) {
      reflectTimer(previous);
      status.textContent = ack.message ?? "Choose a timer from 10 to 60 seconds.";
      return;
    }
    reflectTimer(ack.phase_a_seconds);
    status.textContent = `Timer set to ${ack.phase_a_seconds}s for the next question.`;
  });
});
showDeckButton.addEventListener("click", () => {
  renderDeck();
  deckDialog.showModal();
});
closeDeckButton.addEventListener("click", closeDeck);
deckDialog.addEventListener("click", (event) => {
  if (event.target === deckDialog) closeDeck();
});

async function bootstrap() {
  try {
    const response = await fetch("/api/teacher/sessions", { credentials: "same-origin" });
    const decision = bootstrapDecision(response.status);
    if (decision.state === "signed-out") {
      showSignedOut();
      return;
    }
    if (decision.state === "error") {
      showSignedOut(decision.message);
      return;
    }
    const body = await response.json();
    showConsole();
    showHome();
    renderSessions(body.sessions);
  } catch {
    showSignedOut("Could not restore your sign-in. Try again.");
  }
}

void bootstrap();

function mountMiniProjector(nextSessionId) {
  miniProjector?.destroy();
  const slot = document.querySelector("#mini-projector-slot");
  slot.hidden = false;
  document.querySelector("#teacher-cockpit").classList.add("cockpit-live");
  document.body.classList.add("cockpit-live-page");
  miniProjector = createMiniProjector({ container: slot, sessionId: nextSessionId });
}

function unmountMiniProjector() {
  miniProjector?.destroy();
  miniProjector = null;
  document.querySelector("#mini-projector-slot").hidden = true;
  document.querySelector("#teacher-cockpit").classList.remove("cockpit-live");
  document.body.classList.remove("cockpit-live-page");
}
