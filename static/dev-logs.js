import { formatRow } from "./dev-log-format.js";

const session = document.body.dataset.session ?? "";
const devToken = document.body.dataset.devToken ?? "";
const list = document.querySelector("#event-log");
const status = document.querySelector("#log-status");
const jump = document.querySelector("#jump-live");
const search = document.querySelector("#log-search");
const filters = [...document.querySelectorAll("[data-log-level]")];
const rows = [];
let pending = [];
let flushScheduled = false;
let paused = false;
let unseen = 0;

function atBottom() {
  return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 40;
}

function matches(row) {
  const query = search.value.trim().toLowerCase();
  const enabled = new Set(filters.filter((input) => input.checked).map((input) => input.dataset.logLevel));
  return enabled.has(row.dataset.level) && (query === "" || row.textContent.toLowerCase().includes(query));
}

function applyFilters() {
  for (const row of rows) row.hidden = !matches(row);
}

function chipElement(chip) {
  const value = document.createElement(chip.truncated ? "button" : "span");
  if (value instanceof HTMLButtonElement) value.type = "button";
  value.className = "dev-log-chip";
  value.textContent = `${chip.key}=${chip.text}`;
  value.title = chip.full;
  if (chip.truncated) {
    value.addEventListener("click", () => {
      const expanded = value.dataset.expanded === "true";
      value.dataset.expanded = String(!expanded);
      value.textContent = `${chip.key}=${expanded ? chip.text : chip.full}`;
    });
  }
  return value;
}

function rowElement(data) {
  const model = formatRow(data);
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
  row.append(time, tag, badge, name, ...model.chips.map(chipElement));
  return row;
}

function flush() {
  flushScheduled = false;
  const shouldScroll = !paused && atBottom();
  const fragment = document.createDocumentFragment();
  for (const data of pending) {
    const row = rowElement(data);
    rows.push(row);
    fragment.append(row);
  }
  const added = pending.length;
  pending = [];
  list.append(fragment);
  while (rows.length > 2_000) rows.shift().remove();
  applyFilters();
  if (shouldScroll) window.scrollTo({ top: document.documentElement.scrollHeight });
  else if (added > 0) {
    paused = true;
    unseen += added;
    jump.hidden = false;
    jump.textContent = `Jump to live (${unseen} new)`;
  }
}

function append(event) {
  try {
    pending.push(JSON.parse(event.data));
    if (!flushScheduled) {
      flushScheduled = true;
      requestAnimationFrame(flush);
    }
  } catch {
    status.textContent = "Received an unreadable stream frame";
  }
}

function filterChanged() {
  applyFilters();
}

search.addEventListener("input", filterChanged);
for (const filter of filters) filter.addEventListener("change", filterChanged);
window.addEventListener("scroll", () => {
  if (atBottom()) {
    paused = false;
    unseen = 0;
    jump.hidden = true;
  } else {
    paused = true;
  }
}, { passive: true });
jump.addEventListener("click", () => {
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
  paused = false;
  unseen = 0;
  jump.hidden = true;
});

const tokenQuery = devToken ? `&dev_token=${encodeURIComponent(devToken)}` : "";
const source = new EventSource(`/dev/logs?session=${encodeURIComponent(session)}&stream=1${tokenQuery}`);
for (const eventName of ["game_event", "server_log", "stream_dropped", "history_truncated"]) {
  source.addEventListener(eventName, append);
}
source.onopen = () => { status.textContent = "Streaming game events and server logs"; };
source.onerror = () => { status.textContent = "Stream reconnecting..."; };
