(() => {
  const state = {
    live: true,
    selectedId: null,
    selectedSnapshot: null,
    tab: "run",
    knownIds: new Set(),
    unseenCount: 0,
    search: "",
    pollError: null,
  };

  const els = {
    statusLine: document.getElementById("statusLine"),
    liveBtn: document.getElementById("liveBtn"),
    pauseBtn: document.getElementById("pauseBtn"),
    latestBtn: document.getElementById("latestBtn"),
    newBadge: document.getElementById("newBadge"),
    searchInput: document.getElementById("searchInput"),
    roundList: document.getElementById("roundList"),
    detailTitle: document.getElementById("detailTitle"),
    detailBody: document.getElementById("detailBody"),
    copyBtn: document.getElementById("copyBtn"),
    tabs: document.getElementById("tabs"),
  };

  els.liveBtn.addEventListener("click", () => setLive(true));
  els.pauseBtn.addEventListener("click", () => setLive(false));
  els.latestBtn.addEventListener("click", () => {
    void jumpToLatest();
  });
  els.searchInput.addEventListener("input", () => {
    state.search = els.searchInput.value.trim().toLowerCase();
    void refreshList(false);
  });
  els.copyBtn.addEventListener("click", () => {
    void copyCurrent();
  });
  els.tabs.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-tab]");
    if (!button) return;
    state.tab = button.getAttribute("data-tab");
    for (const child of els.tabs.querySelectorAll("button")) {
      child.classList.toggle("active", child === button);
    }
    renderDetailBody();
  });

  void bootstrap();
  setInterval(() => {
    void refreshList(true);
  }, 1000);

  async function bootstrap() {
    await refreshStatus();
    await refreshList(true);
  }

  function setLive(enabled) {
    state.live = enabled;
    els.liveBtn.classList.toggle("active", enabled);
    els.pauseBtn.classList.toggle("active", !enabled);
    if (enabled) {
      state.unseenCount = 0;
      updateBadge();
      void jumpToLatest();
    }
  }

  async function jumpToLatest() {
    const rounds = await fetchRounds();
    if (!rounds.length) return;
    const latest = rounds[rounds.length - 1];
    state.live = true;
    els.liveBtn.classList.add("active");
    els.pauseBtn.classList.remove("active");
    state.unseenCount = 0;
    updateBadge();
    await selectRound(latest.id, false);
  }

  async function refreshStatus() {
    try {
      const status = await fetchJson("/api/status");
      const agent = status.agent
        ? ` mode=${status.agent.mode}${status.agent.run ? ` run=${status.agent.run.id}` : ""}`
        : "";
      els.statusLine.textContent =
        `session ${status.sessionId} · ${status.finalizedCount}/${status.maxRounds} rounds` +
        (status.inProgressCount
          ? ` · ${status.inProgressCount} in progress`
          : "") +
        agent;
      state.pollError = null;
    } catch (error) {
      state.pollError = error instanceof Error ? error.message : String(error);
      els.statusLine.textContent = `Inspector offline: ${state.pollError}`;
    }
  }

  async function refreshList(fromPoll) {
    await refreshStatus();
    const scrollTop = els.roundList.scrollTop;
    let rounds;
    try {
      rounds = await fetchRounds();
    } catch {
      return;
    }

    const previousKnown = state.knownIds;
    const nextKnown = new Set(rounds.map((round) => round.id));
    let added = 0;
    for (const id of nextKnown) {
      if (!previousKnown.has(id)) added += 1;
    }
    state.knownIds = nextKnown;

    if (fromPoll && added > 0) {
      if (state.live) {
        const latest = rounds[rounds.length - 1];
        if (latest && latest.id !== state.selectedId) {
          await selectRound(latest.id, false);
        }
      } else {
        state.unseenCount += added;
        updateBadge();
      }
    }

    const filtered = rounds.filter((round) => matchesSearch(round));
    els.roundList.innerHTML = "";
    if (!filtered.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "Aucun round pour l’instant.";
      els.roundList.appendChild(empty);
    } else {
      for (const round of [...filtered].reverse()) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.id = round.id;
        button.className =
          "round-item" + (round.id === state.selectedId ? " selected" : "");
        button.innerHTML =
          `<div><strong>${escapeHtml(formatRoundLabel(round))}</strong></div>` +
          `<div class="meta">${escapeHtml(round.phase)} · ${escapeHtml(round.status)}${round.attempt ? ` · retry ${round.attempt}` : ""}</div>` +
          `<div class="preview">${escapeHtml(round.preview)}</div>`;
        button.addEventListener("click", () => {
          void selectRound(round.id, true);
        });
        els.roundList.appendChild(button);
      }
    }
    els.roundList.scrollTop = scrollTop;
  }

  function matchesSearch(round) {
    if (!state.search) return true;
    const haystack = [
      round.id,
      String(round.generationId),
      round.phase,
      String(round.round),
      String(round.attempt ?? 0),
      round.wakeType,
      round.permission,
      round.status,
      round.preview,
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(state.search);
  }

  async function selectRound(id, manual) {
    if (manual) {
      state.live = false;
      els.liveBtn.classList.remove("active");
      els.pauseBtn.classList.add("active");
    }
    if (state.selectedId === id && state.selectedSnapshot) {
      renderDetailShell();
      return;
    }
    const detailScroll = els.detailBody.scrollTop;
    const round = await fetchJson(`/api/rounds/${encodeURIComponent(id)}`);
    state.selectedId = id;
    state.selectedSnapshot = round;
    if (!manual) {
      state.unseenCount = 0;
      updateBadge();
    }
    renderDetailShell();
    els.detailBody.scrollTop = detailScroll;
    for (const button of els.roundList.querySelectorAll(".round-item")) {
      button.classList.toggle("selected", button.dataset.id === id);
    }
  }

  function renderDetailShell() {
    const round = state.selectedSnapshot;
    if (!round) {
      els.detailTitle.textContent = "Aucun round sélectionné";
      els.copyBtn.disabled = true;
      els.detailBody.innerHTML =
        '<p class="empty">Sélectionnez un round pour inspecter le contexte exact.</p>';
      return;
    }
    els.detailTitle.textContent =
      `${formatRoundLabel(round)} · ${round.status}`;
    els.copyBtn.disabled = false;
    renderDetailBody();
  }

  function renderDetailBody() {
    const round = state.selectedSnapshot;
    if (!round) return;
    const scrollTop = els.detailBody.scrollTop;
    switch (state.tab) {
      case "run":
        els.detailBody.innerHTML = renderRun(round);
        break;
      case "messages":
        els.detailBody.innerHTML = renderMessages(round);
        break;
      case "tools":
        els.detailBody.innerHTML = renderTools(round);
        break;
      case "raw":
        els.detailBody.innerHTML = renderJson(round.requestBody ?? round.request ?? null);
        break;
      case "response":
        els.detailBody.innerHTML = renderResponse(round);
        break;
      case "memory":
        els.detailBody.innerHTML = renderMemory(round);
        break;
      case "executions":
        els.detailBody.innerHTML = renderExecutions(round);
        break;
      case "metadata":
        els.detailBody.innerHTML = renderMetadata(round);
        break;
      default:
        els.detailBody.innerHTML = "";
    }
    els.detailBody.scrollTop = scrollTop;
  }

  function renderRun(round) {
    const snapshot = round.contextSnapshot ?? {};
    return renderJson({
      phase: round.phase,
      status: round.status,
      attempt: round.attempt,
      objective: snapshot.objective ?? null,
      workingMemory: snapshot.workingMemory ?? null,
      memoryBefore: round.memoryBefore ?? null,
      memoryAfter: round.memoryAfter ?? null,
      currentTask: snapshot.currentTask ?? null,
      lastTask: snapshot.lastTask ?? null,
      lastResult: snapshot.lastResult ?? null,
      remainingPlan: snapshot.remainingPlan ?? null,
      decision: round.decision ?? null,
      validationError: round.validationError ?? null,
    });
  }

  function renderMemory(round) {
    if (
      round.memoryBefore === undefined &&
      round.memoryAfter === undefined &&
      !round.contextSnapshot
    ) {
      return '<p class="empty">Aucune mémoire enregistrée pour ce round.</p>';
    }
    return renderJson({
      before: round.memoryBefore ?? round.contextSnapshot?.workingMemory ?? "",
      after: round.memoryAfter ?? null,
      validationError: round.validationError ?? null,
    });
  }

  function renderMessages(round) {
    const messages = round.request?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return '<p class="empty">Aucun message dans la requête.</p>';
    }
    return messages
      .map((message) => {
        const role =
          message && typeof message === "object" && "role" in message
            ? String(message.role)
            : "unknown";
        return (
          `<article class="message ${escapeHtml(role)}">` +
          `<div class="role">${escapeHtml(role)}</div>` +
          `<pre>${escapeHtml(formatValue(message))}</pre>` +
          `</article>`
        );
      })
      .join("");
  }

  function renderTools(round) {
    const tools = round.request?.tools;
    if (!Array.isArray(tools) || tools.length === 0) {
      return '<p class="empty">Aucun schéma d’outil envoyé.</p>';
    }
    return tools
      .map((tool) => {
        const name =
          tool && typeof tool === "object" && tool.function
            ? tool.function.name
            : tool?.name ?? "tool";
        return (
          `<article class="block">` +
          `<div class="role">${escapeHtml(String(name))}</div>` +
          renderFoldableJson(tool) +
          `</article>`
        );
      })
      .join("");
  }

  function renderResponse(round) {
    if (!round.response && !round.rawResponse && !round.error) {
      return '<p class="empty">Pas de réponse enregistrée.</p>';
    }
    const parts = [];
    if (round.error) {
      parts.push(
        `<article class="block"><div class="role status-error">error</div><pre>${escapeHtml(round.error)}</pre></article>`,
      );
    }
    if (round.response) {
      parts.push(
        `<article class="block"><div class="role">normalized</div>${renderFoldableJson(round.response)}</article>`,
      );
    }
    if (round.rawResponse !== undefined) {
      parts.push(
        `<article class="block"><div class="role">raw</div>${renderFoldableJson(round.rawResponse)}</article>`,
      );
    }
    return parts.join("");
  }

  function renderExecutions(round) {
    if (!round.toolExecutions?.length) {
      return '<p class="empty">Aucune exécution d’outil pour ce round.</p>';
    }
    return round.toolExecutions
      .map((execution) => {
        const okClass =
          execution.ok === true
            ? "status-ok"
            : execution.ok === false
              ? "status-error"
              : "";
        return (
          `<article class="block">` +
          `<div class="role ${okClass}">${escapeHtml(execution.name)} · ${escapeHtml(execution.toolCallId)}</div>` +
          `<pre>arguments:\n${escapeHtml(execution.arguments)}</pre>` +
          (execution.result === undefined
            ? ""
            : `<pre>result:\n${escapeHtml(execution.result)}</pre>`) +
          `</article>`
        );
      })
      .join("");
  }

  function renderMetadata(round) {
    return renderJson({
      id: round.id,
      timestamp: round.timestamp,
      generationId: round.generationId,
      phase: round.phase,
      reflection: round.reflection,
      round: round.round,
      attempt: round.attempt,
      wakeType: round.wakeType,
      permission: round.permission,
      decision: round.decision,
      validationError: round.validationError,
      memoryBefore: round.memoryBefore,
      memoryAfter: round.memoryAfter,
      status: round.status,
      metrics: round.metrics,
      usage: round.response?.usage,
      error: round.error,
    });
  }

  function renderJson(value) {
    return `<article class="block">${renderFoldableJson(value)}</article>`;
  }

  function renderFoldableJson(value) {
    const text = formatValue(value);
    if (text.length < 400) {
      return `<pre>${escapeHtml(text)}</pre>`;
    }
    return (
      `<details class="fold" open>` +
      `<summary>JSON (${text.length} chars)</summary>` +
      `<pre>${escapeHtml(text)}</pre>` +
      `</details>`
    );
  }

  async function copyCurrent() {
    if (!state.selectedSnapshot) return;
    const payload =
      state.tab === "run"
        ? {
            context: state.selectedSnapshot.contextSnapshot,
            decision: state.selectedSnapshot.decision,
            memoryBefore: state.selectedSnapshot.memoryBefore,
            memoryAfter: state.selectedSnapshot.memoryAfter,
          }
        : state.tab === "messages"
        ? state.selectedSnapshot.request?.messages
        : state.tab === "tools"
          ? state.selectedSnapshot.request?.tools
          : state.tab === "raw"
            ? state.selectedSnapshot.requestBody ??
              state.selectedSnapshot.request
            : state.tab === "response"
              ? {
                  response: state.selectedSnapshot.response,
                  rawResponse: state.selectedSnapshot.rawResponse,
                  error: state.selectedSnapshot.error,
                }
              : state.tab === "memory"
                ? {
                    before: state.selectedSnapshot.memoryBefore,
                    after: state.selectedSnapshot.memoryAfter,
                  }
              : state.tab === "executions"
                ? state.selectedSnapshot.toolExecutions
                : state.selectedSnapshot;
    await navigator.clipboard.writeText(formatValue(payload));
    els.copyBtn.textContent = "Copied";
    setTimeout(() => {
      els.copyBtn.textContent = "Copy";
    }, 1000);
  }

  function updateBadge() {
    if (state.unseenCount <= 0) {
      els.newBadge.classList.add("hidden");
      return;
    }
    els.newBadge.classList.remove("hidden");
    els.newBadge.textContent =
      state.unseenCount === 1
        ? "1 nouveau round"
        : `${state.unseenCount} nouveaux rounds`;
  }

  async function fetchRounds() {
    const payload = await fetchJson("/api/rounds");
    return Array.isArray(payload.rounds) ? payload.rounds : [];
  }

  async function fetchJson(path) {
    const response = await fetch(path, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return response.json();
  }

  function formatRoundLabel(round) {
    const attempt =
      round.attempt > 0 ? ` · retry ${round.attempt}` : "";
    return `Run ${round.generationId} · ${round.phase}${attempt}`;
  }

  function formatValue(value) {
    if (typeof value === "string") return value;
    return JSON.stringify(value, null, 2);
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }
})();
