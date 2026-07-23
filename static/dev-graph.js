import { answerChip, groupPlayers, roundSummary } from "./dev-graph-model.js";

const root = document.querySelector("#dev-graph");
const status = document.querySelector("#graph-status");
const summary = document.querySelector("#graph-summary");
const session = document.body.dataset.session ?? "";
const devToken = document.body.dataset.devToken ?? "";
const tokenQuery = devToken ? `&dev_token=${encodeURIComponent(devToken)}` : "";
let refreshTimer;

function detailLine(label, value) {
  const row = document.createElement("span");
  row.textContent = `${label}: ${value}`;
  return row;
}

function playerBox(player, round) {
  const chip = answerChip(round, player.player_id);
  const box = document.createElement("button");
  box.type = "button";
  box.className = `dev-player-node${player.role === "one" ? " is-one" : ""}`;
  box.setAttribute("aria-expanded", "false");
  const heading = document.createElement("span");
  heading.className = "dev-node-heading";
  const led = document.createElement("span");
  led.className = `dev-presence-led ${player.connected ? "is-online" : "is-offline"}`;
  led.title = player.connected ? "Connected" : "Disconnected";
  const nickname = document.createElement("strong");
  nickname.textContent = player.nickname;
  const answer = document.createElement("span");
  answer.className = `dev-answer-chip${chip.visible ? " has-answer" : " is-empty"}${chip.correct === true ? " is-correct" : chip.correct === false ? " is-wrong" : ""}`;
  answer.textContent = chip.visible ? `${chip.time}${chip.correct === true ? " ✓" : chip.correct === false ? " ✗" : ""}` : "—";
  heading.append(led, nickname, answer);
  const detail = document.createElement("span");
  detail.className = "dev-node-detail";
  detail.hidden = true;
  detail.append(
    detailLine("Points", player.points ?? 0),
    detailLine("Streak", player.streak ?? 0),
    detailLine("Role", player.role ?? "mob"),
    detailLine("Sockets", player.socket_count ?? 0),
    detailLine("Last answer", chip.visible ? chip.time : "none"),
  );
  box.append(heading, detail);
  box.addEventListener("click", () => {
    detail.hidden = !detail.hidden;
    box.setAttribute("aria-expanded", String(!detail.hidden));
  });
  return box;
}

function renderColumn(title, players, round, className) {
  const section = document.createElement("section");
  section.className = `dev-role-column ${className}`;
  const heading = document.createElement("h2");
  heading.textContent = `${title} (${players.length})`;
  const grid = document.createElement("div");
  grid.className = "dev-node-grid";
  grid.append(...players.map((player) => playerBox(player, round)));
  section.append(heading, grid);
  return section;
}

function render(state) {
  const groups = groupPlayers(Array.isArray(state.players) ? state.players : []);
  const current = roundSummary(state.round);
  summary.textContent = `${current.phase} · ${current.answered}/${current.eligible} locked/eligible · ${groups.one.length} one · ${groups.mob.length} mob · ${groups.crowd.length} crowd`;
  root.replaceChildren(
    renderColumn("THE ONE", groups.one, state.round, "role-one"),
    renderColumn("MOB", groups.mob, state.round, "role-mob"),
    renderColumn("CROWD", groups.crowd, state.round, "role-crowd"),
  );
}

async function refresh() {
  try {
    const response = await fetch(`/api/dev/session/${encodeURIComponent(session)}/state`, {
      headers: devToken ? { "x-dev-token": devToken } : {},
    });
    if (!response.ok) throw new Error(`State request failed (${response.status})`);
    render(await response.json());
    status.textContent = "LIVE";
    status.className = "dev-live-status is-live";
  } catch {
    status.textContent = "STALE";
    status.className = "dev-live-status is-stale";
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 300);
}

const source = new EventSource(`/dev/logs?session=${encodeURIComponent(session)}&stream=1${tokenQuery}`);
source.addEventListener("game_event", scheduleRefresh);
source.addEventListener("server_log", scheduleRefresh);
source.onerror = () => {
  status.textContent = "STALE";
  status.className = "dev-live-status is-stale";
};
setInterval(refresh, 5_000);
void refresh();
