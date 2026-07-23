import { createRequestId } from "./request-id.js";
import { createRequestIdRetainer } from "./request-id-retainer.js";

const loginSection = document.querySelector("#meta-login");
const loginForm = document.querySelector("#meta-login-form");
const metaKey = document.querySelector("#meta-key");
const loginStatus = document.querySelector("#meta-login-status");
const consolePanel = document.querySelector("#meta-console");
const mintForm = document.querySelector("#mint-form");
const teacherLabel = document.querySelector("#teacher-label");
const mintedPanel = document.querySelector("#minted-key");
const mintedValue = document.querySelector("#minted-key-value");
const copyButton = document.querySelector("#copy-key");
const status = document.querySelector("#meta-status");
const teacherRows = document.querySelector("#teacher-rows");
const mintRequestId = createRequestIdRetainer(createRequestId);

mintRequestId.current();
teacherLabel.addEventListener("input", () => mintRequestId.reset());

function dateText(value) {
  return value === null ? "Never" : new Date(value).toLocaleString();
}

async function loadTeachers() {
  const response = await fetch("/api/meta/teachers");
  if (!response.ok) return false;
  const body = await response.json();
  teacherRows.replaceChildren();
  for (const teacher of body.teachers) {
    const row = document.createElement("tr");
    const values = [
      teacher.label,
      dateText(teacher.created_at_ms),
      dateText(teacher.last_used_at_ms),
      String(teacher.session_count),
      teacher.status,
    ];
    for (const value of values) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    const action = document.createElement("td");
    if (teacher.status === "active") {
      const reissue = document.createElement("button");
      reissue.type = "button";
      reissue.textContent = "Reissue";
      const reissueRequestId = createRequestIdRetainer(createRequestId);
      reissue.addEventListener("click", async () => {
        if (!window.confirm(
          `Reissue the teacher key for ${teacher.label}? Existing sign-ins will stop working.`
        )) return;
        mintedPanel.hidden = true;
        mintedValue.textContent = "";
        const reissueResponse = await fetch(
          `/api/meta/teachers/${teacher.teacher_id}/reissue`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ request_id: reissueRequestId.current(), confirm: true }),
          }
        );
        if (!reissueResponse.ok) {
          status.textContent = "Could not reissue that key.";
          return;
        }
        const reissued = await reissueResponse.json();
        reissueRequestId.clear();
        if (reissued.key === null) {
          status.textContent =
            "That reissue already completed and keys are shown only once. Reissue again for a new key.";
          await loadTeachers();
          return;
        }
        mintedValue.textContent = reissued.key;
        mintedPanel.hidden = false;
        copyButton.textContent = "Copy key";
        status.textContent = "Teacher key reissued.";
        await loadTeachers();
      });
      const revoke = document.createElement("button");
      revoke.type = "button";
      revoke.className = "danger";
      revoke.textContent = "Revoke";
      const revokeRequestId = createRequestIdRetainer(createRequestId);
      revoke.addEventListener("click", async () => {
        if (!window.confirm(
          `Revoke the teacher key for ${teacher.label}? Existing sign-ins will stop working.`
        )) return;
        const revokeResponse = await fetch(`/api/meta/teachers/${teacher.teacher_id}/revoke`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ request_id: revokeRequestId.current(), confirm: true }),
        });
        status.textContent = revokeResponse.ok
          ? "Teacher key revoked."
          : "Could not revoke that key.";
        if (revokeResponse.ok) {
          revokeRequestId.clear();
          await loadTeachers();
        }
      });
      action.append(reissue, revoke);
    }
    row.append(action);
    teacherRows.append(row);
  }
  return true;
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const response = await fetch("/api/meta/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: metaKey.value.trim() }),
  });
  metaKey.value = "";
  if (!response.ok) {
    loginStatus.textContent = "Sign-in didn't work. Check the key and try again.";
    return;
  }
  loginSection.hidden = true;
  consolePanel.hidden = false;
  await loadTeachers();
});

mintForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  mintedPanel.hidden = true;
  mintedValue.textContent = "";
  const response = await fetch("/api/meta/teachers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: teacherLabel.value, request_id: mintRequestId.current() }),
  });
  if (!response.ok) {
    status.textContent = "Could not mint a teacher key.";
    return;
  }
  const body = await response.json();
  mintRequestId.clear();
  teacherLabel.value = "";
  if (body.key === null) {
    status.textContent =
      "That mint already completed and keys are shown only once. Reissue the teacher for a new key.";
    await loadTeachers();
    return;
  }
  mintedValue.textContent = body.key;
  mintedPanel.hidden = false;
  status.textContent = "Teacher key minted.";
  await loadTeachers();
});

copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(mintedValue.textContent);
    copyButton.textContent = "Copied";
  } catch {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(mintedValue);
    selection.removeAllRanges();
    selection.addRange(range);
    status.textContent = "Copy is unavailable here. The key is selected; use your browser's copy command.";
  }
});

if (await loadTeachers()) {
  loginSection.hidden = true;
  consolePanel.hidden = false;
}
