const DESIGN_WIDTH = 1280;
const DESIGN_HEIGHT = 720;
const SESSION_ID_PATTERN = /^[0-9a-f-]{36}$/;

export function computeMiniProjectorLayout(containerWidth, designWidth = DESIGN_WIDTH, designHeight = DESIGN_HEIGHT) {
  const width = Number.isFinite(containerWidth) && containerWidth > 0 ? containerWidth : 0;
  const validDesignWidth = Number.isFinite(designWidth) && designWidth > 0;
  const height = Number.isFinite(designHeight) && designHeight > 0 ? designHeight : 0;
  const scale = validDesignWidth ? width / designWidth : 0;

  return Object.freeze({
    scale,
    width,
    height: validDesignWidth ? width * height / designWidth : 0,
  });
}

export function credentialWaitDecision(storedValue, elapsedMs, timeoutMs) {
  if (storedValue !== null) return "mount";
  return elapsedMs >= timeoutMs ? "give_up" : "wait";
}

export function startCredentialWait({
  read,
  onMount,
  onTimeout,
  schedule,
  clear,
  now = Date.now,
  pollMs,
  timeoutMs,
}) {
  const startedAt = now();
  let stopped = false;
  let pollTimer = null;

  const clearPollTimer = () => {
    if (pollTimer === null) return;
    clear(pollTimer);
    pollTimer = null;
  };

  const checkCredential = () => {
    if (stopped) return;
    let storedValue = null;
    try {
      storedValue = read();
    } catch {
      // Treat an unavailable credential source like a credential that never arrived.
    }
    const elapsedMs = Math.max(0, now() - startedAt);
    const decision = credentialWaitDecision(storedValue, elapsedMs, timeoutMs);
    if (decision === "mount") {
      clearPollTimer();
      stopped = true;
      onMount();
      return;
    }
    if (decision === "give_up") {
      clearPollTimer();
      stopped = true;
      onTimeout();
      return;
    }
    clearPollTimer();
    pollTimer = schedule(checkCredential, Math.min(pollMs, timeoutMs - elapsedMs));
  };

  checkCredential();

  return Object.freeze({
    stop() {
      if (stopped) return;
      stopped = true;
      clearPollTimer();
    },
  });
}

export function createMiniProjector({
  container,
  sessionId,
  credentialPollMs = 500,
  credentialTimeoutMs = 15000,
}) {
  if (!container || typeof container.append !== "function") {
    throw new TypeError("A mini-projector container is required.");
  }
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new TypeError("A valid session ID is required.");
  }

  const pollMs = Number.isFinite(credentialPollMs) && credentialPollMs >= 0
    ? credentialPollMs
    : 500;
  const timeoutMs = Number.isFinite(credentialTimeoutMs) && credentialTimeoutMs >= 0
    ? credentialTimeoutMs
    : 15000;
  const projectorPath = `/projector/${sessionId}`;
  const frame = document.createElement("div");
  const header = document.createElement("header");
  const label = document.createElement("strong");
  const link = document.createElement("a");
  const stage = document.createElement("div");
  const placeholder = document.createElement("p");

  frame.className = "mini-projector";
  header.className = "mini-projector-header";
  label.textContent = "Projector preview";
  link.href = projectorPath;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = "Open full projector";
  stage.className = "mini-projector-stage";
  placeholder.className = "mini-projector-placeholder";
  placeholder.textContent = "Preparing preview…";
  header.append(label, link);
  stage.append(placeholder);
  frame.append(header, stage);
  container.append(frame);

  let destroyed = false;
  let iframe = null;
  let resizeObserver = null;

  const updateLayout = (observedWidth) => {
    const measuredWidth = Number.isFinite(observedWidth)
      ? observedWidth
      : container.getBoundingClientRect().width;
    const layout = computeMiniProjectorLayout(measuredWidth);
    stage.style.height = `${layout.height}px`;
    if (iframe !== null) iframe.style.transform = `scale(${layout.scale})`;
  };

  const handleWindowResize = () => updateLayout();
  if (typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver((entries) => {
      updateLayout(entries[0]?.contentRect.width);
    });
    resizeObserver.observe(container);
  } else {
    window.addEventListener("resize", handleWindowResize);
  }
  updateLayout();

  const mountIframe = () => {
    iframe = document.createElement("iframe");
    iframe.src = projectorPath;
    iframe.title = "Projector preview";
    iframe.width = String(DESIGN_WIDTH);
    iframe.height = String(DESIGN_HEIGHT);
    iframe.tabIndex = -1;
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.pointerEvents = "none";
    iframe.style.transformOrigin = "top left";
    stage.replaceChildren(iframe);
    updateLayout();
  };

  const credentialWait = startCredentialWait({
    read: () => localStorage.getItem(`projector:${sessionId}`),
    onMount: mountIframe,
    onTimeout: () => {
      placeholder.textContent = "Preview unavailable — open the projector link instead.";
    },
    schedule: (callback, delay) => window.setTimeout(callback, delay),
    clear: (timer) => window.clearTimeout(timer),
    pollMs,
    timeoutMs,
  });

  return Object.freeze({
    destroy() {
      if (destroyed) return;
      destroyed = true;
      credentialWait.stop();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", handleWindowResize);
      frame.remove();
    },
  });
}
