import { formatRow } from "./dev-log-format.js";
import { groupPlayers } from "./dev-graph-model.js";
import { roundRows, sessionRows, storedEventFrame } from "./dev-state-model.js";

const EVENT_LIMIT = 100;
const REFRESH_MS = 3_000;

const status = document.querySelector("#state-status");
const sessionCard = document.querySelector("#state-session");
const roundCard = document.querySelector("#state-round");
const playerRows = document.querySelector("#state-player-rows");
const playerSummary = document.querySelector("#state-player-summary");
const eventRows = document.querySelector("#state-event-rows");
const eventSummary = document.querySelector("#state-event-summary");
const session = document.body.dataset.session ?? "";
const devToken = document.body.dataset.devToken ?? "";

function definitionRows(container, rows) {
  container.replaceChildren(...rows.map((row) => {
    const item = document.createElement("div");
    item.className = "dev-state-row";
    const label = document.createElement("dt");
    label.textContent = row.label;
    const value = document.createElement("dd");
    value.textContent = row.value;
    item.append(label, value);
    return item;
  }));
}

function playerRow(player) {
  const row = document.createElement("tr");
  const led = document.createElement("span");
  led.className = `dev-presence-led ${player.connected ? "is-online" : "is-offline"}`;
  led.title = player.connected ? "Connected" : "Disconnected";
  const cells = [
    [led, player.nickname],
    [player.role ?? "mob"],
    [String(player.points ?? 0)],
    [String(player.streak ?? 0)],
    [String(player.socket_count ?? 0)],
  ];
  row.append(...cells.map((content) => {
    const cell = document.createElement("td");
    cell.append(...content);
    return cell;
  }));
  if (!player.connected) row.className = "is-offline-row";
  return row;
}

function eventRow(frame) {
  const model = formatRow(frame);
  const row = document.createElement("li");
  row.className = `dev-log-row ${model.cssClass}`;
  row.dataset.level = model.level;
  const time = document.createElement("time");
  time.textContent = model.ts;
  const tag = document.createElement("span");
  tag.className = "dev-log-tag";
  tag.textContent = model.tag;
  const badge = document.createElement("span");
  badge.className = "dev-log-badge";
  badge.textContent = model.badge;
  const name = document.createElement("strong");
  name.textContent = model.name;
  row.append(time, tag, badge, name);
  for (const chip of model.chips) {
    const item = document.createElement("span");
    item.className = "dev-log-chip";
    item.textContent = `${chip.key}=${chip.text}`;
    if (chip.truncated) item.title = chip.full;
    row.append(item);
  }
  return row;
}

function render(state) {
  definitionRows(sessionCard, sessionRows(state.session));
  definitionRows(roundCard, roundRows(state.round, state.server_time_ms));
  const groups = groupPlayers(state.players ?? []);
  const listed = [...groups.one, ...groups.mob, ...groups.crowd];
  playerRows.replaceChildren(...listed.map(playerRow));
  const connected = listed.filter((player) => player.connected).length;
  playerSummary.textContent =
    `${listed.length} players (${groups.one.length} one / ${groups.mob.length} mob / ${groups.crowd.length} crowd), ${connected} connected`;
  const events = Array.isArray(state.events) ? state.events : [];
  const recent = events.slice(-EVENT_LIMIT);
  eventRows.replaceChildren(...recent.map((event) => eventRow(storedEventFrame(event))));
  eventSummary.textContent = events.length > recent.length
    ? `Latest ${recent.length} of ${events.length} events`
    : `${events.length} events`;
}

async function refresh() {
  try {
    const response = await fetch(`/api/dev/session/${encodeURIComponent(session)}/state`, {
      credentials: "same-origin",
      ...(devToken ? { headers: { "x-dev-token": devToken } } : {}),
    });
    if (!response.ok) {
      status.textContent = `HTTP ${response.status}`;
      status.className = "dev-live-status is-stale";
      return;
    }
    render(await response.json());
    status.textContent = "LIVE";
    status.className = "dev-live-status is-live";
  } catch {
    status.textContent = "STALE";
    status.className = "dev-live-status is-stale";
  }
}

void refresh();
setInterval(() => void refresh(), REFRESH_MS);
