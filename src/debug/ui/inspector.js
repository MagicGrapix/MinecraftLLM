(() => {
  const state = {
    live: true,
    selectedId: null,
    selectedSnapshot: null,
    tab: "request",
    knownIds: new Set(),
    clearing: false,
    sessionId: null,
    rounds: [],
    unseenCount: 0,
    search: "",
    pollError: null,
  };

  const els = {
    statusLine: document.getElementById("statusLine"),
    liveBtn: document.getElementById("liveBtn"),
    pauseBtn: document.getElementById("pauseBtn"),
    latestBtn: document.getElementById("latestBtn"),
    clearBtn: document.getElementById("clearBtn"),
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
  els.clearBtn.addEventListener("click", () => {
    void clearView();
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
      if (state.sessionId !== status.sessionId) {
        state.sessionId = status.sessionId;
        state.knownIds.clear();
        state.rounds = [];
        state.selectedId = null;
        state.selectedSnapshot = null;
        state.unseenCount = 0;
        updateBadge();
        updateClearControls();
        renderDetailShell();
      }
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
    state.rounds = rounds;
    updateClearControls();

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
        state.unseenCount += rounds.filter((round) => !previousKnown.has(round.id)).length;
        updateBadge();
      }
    }

    const filtered = rounds.filter(matchesSearch);
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

  async function clearView() {
    state.clearing = true;
    updateClearControls();
    try {
      const response = await fetch("/api/rounds/clear", { method: "POST" });
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      state.rounds = [];
      state.knownIds.clear();
      state.selectedId = null;
      state.selectedSnapshot = null;
      state.unseenCount = 0;
      updateBadge();
      renderDetailShell();
      await refreshList(false);
    } catch (error) {
      els.statusLine.textContent =
        `Clear impossible: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      state.clearing = false;
      updateClearControls();
    }
  }

  function updateClearControls() {
    els.clearBtn.disabled = state.clearing || state.rounds.length === 0;
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
        '<p class="empty">Sélectionnez un round pour voir la requête LLM exacte.</p>';
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
      case "request":
        els.detailBody.innerHTML = renderRequest(round);
        break;
      case "response":
        els.detailBody.innerHTML = renderResponse(round);
        break;
      case "debug":
        els.detailBody.innerHTML = renderDebug(round);
        break;
      default:
        els.detailBody.innerHTML = "";
    }
    els.detailBody.scrollTop = scrollTop;
  }

  function renderRequest(round) {
    if (!round.requestBody) {
      return '<p class="empty">Aucune requête LLM enregistrée pour ce round.</p>';
    }
    return '<p class="empty">Corps de la requête envoyée au modèle. Les éventuels secrets sont masqués.</p>' +
      renderJson(round.requestBody);
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
    if (!round.toolExecutions?.length) return "";
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

  function renderDebug(round) {
    const metadata = {
      id: round.id,
      timestamp: round.timestamp,
      generationId: round.generationId,
      phase: round.phase,
      reflection: round.reflection,
      round: round.round,
      attempt: round.attempt,
      wakeType: round.wakeType,
      permission: round.permission,
      status: round.status,
      metrics: round.metrics,
      usage: round.response?.usage,
      error: round.error,
    };
    const parts = [
      '<p class="empty">Données locales de l’inspecteur : elles ne sont pas envoyées séparément au LLM. La source exacte est dans « LLM request ».</p>',
      `<article class="block"><div class="role">Metadata</div>${renderFoldableJson(metadata)}</article>`,
    ];
    if (round.decision !== undefined) {
      parts.push(`<article class="block"><div class="role">Validated decision</div>${renderFoldableJson(round.decision)}</article>`);
    }
    if (round.validationError !== undefined) {
      parts.push(`<article class="block"><div class="role status-error">Validation error</div><pre>${escapeHtml(round.validationError)}</pre></article>`);
    }
    if (round.memoryBefore !== undefined || round.memoryAfter !== undefined) {
      parts.push(`<article class="block"><div class="role">Working memory</div>${renderFoldableJson({ before: round.memoryBefore ?? null, after: round.memoryAfter ?? null })}</article>`);
    }
    if (round.toolExecutions?.length) {
      parts.push(`<article class="block"><div class="role">Tool executions</div>${renderExecutions(round)}</article>`);
    }
    return parts.join("");
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
      state.tab === "request"
        ? state.selectedSnapshot.requestBody ?? null
        : state.tab === "response"
          ? {
              response: state.selectedSnapshot.response,
              rawResponse: state.selectedSnapshot.rawResponse,
              error: state.selectedSnapshot.error,
            }
          : {
              metadata: {
                id: state.selectedSnapshot.id,
                generationId: state.selectedSnapshot.generationId,
                phase: state.selectedSnapshot.phase,
                status: state.selectedSnapshot.status,
                metrics: state.selectedSnapshot.metrics,
              },
              decision: state.selectedSnapshot.decision,
              validationError: state.selectedSnapshot.validationError,
              memoryBefore: state.selectedSnapshot.memoryBefore,
              memoryAfter: state.selectedSnapshot.memoryAfter,
              toolExecutions: state.selectedSnapshot.toolExecutions,
            };
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
