const elements = {
  status: document.getElementById("status"),
  scenario: document.getElementById("scenario"),
  reset: document.getElementById("reset"),
  replies: document.getElementById("replies"),
  messageForm: document.getElementById("message-form"),
  message: document.getElementById("message"),
  send: document.getElementById("send"),
  stop: document.getElementById("stop"),
  resume: document.getElementById("resume"),
  pending: document.getElementById("pending"),
  approve: document.getElementById("approve"),
  reject: document.getElementById("reject"),
  failureCode: document.getElementById("failure-code"),
  failureMessage: document.getElementById("failure-message"),
  world: document.getElementById("world"),
  error: document.getElementById("error"),
};

let loadedScenario = false;
let activeSessionId = null;
let refreshInProgress = false;

async function request(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const payload = await response.json();
  if (!response.ok) {
    const detail = typeof payload.error === "string"
      ? payload.error
      : JSON.stringify(payload.error ?? payload);
    throw new Error(`${response.status}: ${detail}`);
  }
  return payload;
}

async function refresh() {
  if (refreshInProgress) return;
  refreshInProgress = true;
  try {
    const state = await request("/api/lab/state");
    if (!loadedScenario || activeSessionId !== state.sessionId) {
      elements.scenario.value = JSON.stringify(state.scenario, null, 2);
      loadedScenario = true;
      activeSessionId = state.sessionId;
    }
    render(state);
  } catch (error) {
    showError(error);
  } finally {
    refreshInProgress = false;
  }
}

function render(state) {
  const mode = state.agent?.mode ?? "unknown";
  elements.status.textContent = `${mode} · ${state.rounds?.length ?? 0} LLM rounds`;
  elements.status.dataset.mode = mode;
  elements.send.disabled = mode !== "idle";
  elements.stop.disabled = mode === "idle";
  elements.resume.disabled = mode !== "stopped";

  const pending = state.pendingTask;
  elements.pending.textContent = pending ? JSON.stringify(pending, null, 2) : "No action waiting.";
  elements.approve.disabled = !pending;
  elements.reject.disabled = !pending;
  elements.failureCode.disabled = !pending;
  elements.failureMessage.disabled = !pending;

  const world = state.world ?? {};
  const compact = {
    position: world.self?.position,
    facing: world.self?.facing,
    inventory: world.inventory?.items?.map(({ name, count }) => ({ name, count })) ?? [],
    equipped: world.inventory?.selectedItem?.name ?? null,
    blocks: world.blocks ?? [],
    drops: world.drops ?? [],
    workingMemory: state.memory ?? "",
  };
  elements.world.textContent = JSON.stringify(compact, null, 2);

  elements.replies.replaceChildren();
  for (const message of state.conversation ?? []) {
    const paragraph = document.createElement("p");
    paragraph.className = message.role;
    paragraph.textContent = `${message.role === "user" ? "You" : "Bot"}: ${message.text}`;
    elements.replies.append(paragraph);
  }
  if (!state.conversation?.length) {
    const hint = document.createElement("p");
    hint.className = "muted";
    hint.textContent = "No replies yet. Send a message to begin.";
    elements.replies.append(hint);
  }
}

function showError(error) {
  elements.error.textContent = error instanceof Error ? error.message : String(error);
}

async function run(action) {
  elements.error.textContent = "";
  try {
    await action();
    await refresh();
  } catch (error) {
    showError(error);
  }
}

elements.messageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = elements.message.value.trim();
  if (!text) return;
  void run(async () => {
    await request("/api/lab/message", { text });
    elements.message.value = "";
  });
});

elements.reset.addEventListener("click", () => {
  void run(async () => {
    const scenario = JSON.parse(elements.scenario.value);
    await request("/api/lab/reset", { scenario });
    loadedScenario = false;
    document.querySelector("iframe").src = "/inspector";
  });
});

elements.approve.addEventListener("click", () => {
  void run(() => request("/api/lab/resolve", { outcome: "success" }));
});

elements.reject.addEventListener("click", () => {
  void run(() => request("/api/lab/resolve", {
    outcome: "failure",
    code: elements.failureCode.value,
    message: elements.failureMessage.value.trim() || "Simulated failure for testing.",
  }));
});

elements.stop.addEventListener("click", () => {
  void run(() => request("/api/lab/stop", {}));
});

elements.resume.addEventListener("click", () => {
  void run(() => request("/api/lab/resume", {}));
});

void refresh();
setInterval(() => void refresh(), 1000);
