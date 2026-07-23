import { createRequestId } from "./request-id.js";
import { createRequestIdRetainer } from "./request-id-retainer.js";

const loginForm = document.querySelector("#dev-login-form");

if (loginForm !== null) {
  const token = document.querySelector("#dev-token");
  const status = document.querySelector("#dev-login-status");
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const response = await fetch("/api/dev/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: token.value.trim() }),
    });
    token.value = "";
    if (!response.ok) {
      status.textContent = "Sign-in didn't work. Check the token and try again.";
      return;
    }
    window.location.reload();
  });
} else {
  const form = document.querySelector("#bot-form");
  const session = document.querySelector("#bot-session");
  const count = document.querySelector("#bot-count");
  const accuracy = document.querySelector("#bot-accuracy");
  const policy = document.querySelector("#bot-policy");
  const status = document.querySelector("#bot-status");
  const runsPanel = document.querySelector("#bot-runs");
  const startRequest = createRequestIdRetainer(createRequestId);

  function runState(run) {
    if (run.state === "running") return "Running";
    if (run.state === "stopping") return "Stopping";
    if (run.state === "stopped") return "Stopped";
    if (run.state === "failed") return "Failed";
    return "Finished";
  }

  function renderRuns(runs) {
    runsPanel.replaceChildren();
    if (runs.length === 0) {
      const empty = document.createElement("p");
      empty.className = "dev-empty";
      empty.textContent = "No bot runs yet.";
      runsPanel.append(empty);
      return;
    }
    for (const run of runs) {
      const article = document.createElement("article");
      article.className = `dev-run dev-run-${run.state}`;
      const heading = document.createElement("div");
      heading.className = "dev-run-heading";
      const title = document.createElement("strong");
      title.textContent = `${run.count} bots · ${run.policy} · ${runState(run)}`;
      const detail = document.createElement("p");
      detail.textContent = `Joined ${run.joined}/${run.count} · Answered ${run.answered} · Errors ${run.errors}`;
      heading.append(title, detail);
      article.append(heading);
      if (run.message !== null) {
        const message = document.createElement("p");
        message.textContent = run.message;
        article.append(message);
      }
      if (run.state === "running") {
        const stop = document.createElement("button");
        stop.type = "button";
        stop.className = "danger";
        stop.textContent = "Stop";
        stop.addEventListener("click", async () => {
          stop.disabled = true;
          const response = await fetch("/api/dev/bots/stop", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ run_id: run.run_id }),
          });
          status.textContent = response.ok ? "Stopping bot run..." : "Could not stop that bot run.";
          await loadRuns();
        });
        article.append(stop);
      }
      runsPanel.append(article);
    }
  }

  async function loadRuns() {
    const response = await fetch("/api/dev/bots/status");
    if (!response.ok) {
      status.textContent = "Could not refresh bot status.";
      return;
    }
    const body = await response.json();
    renderRuns(body.runs);
  }

  for (const input of [session, count, accuracy, policy]) {
    input.addEventListener("input", () => startRequest.reset());
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const start = form.querySelector("button[type=submit]");
    start.disabled = true;
    status.textContent = "Starting bots...";
    const response = await fetch("/api/dev/bots/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: session.value,
        count: Number(count.value),
        accuracy: Number(accuracy.value),
        policy: policy.value,
        request_id: startRequest.current(),
      }),
    });
    const body = await response.json();
    start.disabled = false;
    if (!response.ok) {
      status.textContent = body.message ?? "Could not start bots.";
      if (response.status < 500) startRequest.clear();
      return;
    }
    startRequest.clear();
    status.textContent = "Bot run started.";
    await loadRuns();
  });

  document.querySelector("#refresh-sessions").addEventListener("click", () => window.location.reload());
  await loadRuns();
  setInterval(() => void loadRuns(), 1_000);
}
