(function () {
  "use strict";

  // Deliberately self-contained rather than sharing app.js's MapRoulette
  // helpers - there's no bundler here to import across the two pages
  // cleanly, and this keeps the well-tested desktop tool untouched. Keep the
  // From header and status-code mapping in sync with app.js by hand if
  // MapRoulette's API ever changes.
  const MR_API_BASE = "https://maproulette.org/api/v2";
  const MR_TASKS_PAGE_SIZE = 500;
  const LOCKED_STATUS_CODES = new Set([1, 5]); // Fixed, Already_Fixed - nothing to do with these

  const DELETE_ENABLE_DELAY_MS = 1000; // "give me a second before I can tap Delete"
  const UNDO_BANNER_TIMEOUT_MS = 8000;

  let mrApiKey = localStorage.getItem("block-triage:mrApiKey") || "";
  let mrChallengeId = localStorage.getItem("block-triage:mrChallengeId") || "";

  /** @type {Array<{taskId:number, feature:object, area:number}>} */
  let queue = [];
  let currentIndex = 0;
  /** @type {null | {feature:object, taskId:number}} */
  let lastDeleted = null;
  let undoBannerTimer = null;
  let deleteEnableTimer = null;

  const setupScreen = document.getElementById("setup-screen");
  const triageScreen = document.getElementById("triage-screen");
  const doneScreen = document.getElementById("done-screen");
  const apiKeyInput = document.getElementById("api-key-input");
  const challengeIdInput = document.getElementById("challenge-id-input");
  const loadBtn = document.getElementById("load-btn");
  const setupStatusEl = document.getElementById("setup-status");
  const progressEl = document.getElementById("progress");
  const taskAreaEl = document.getElementById("task-area");
  const taskIdEl = document.getElementById("task-id");
  const actionStatusEl = document.getElementById("action-status");
  const deleteBtn = document.getElementById("delete-btn");
  const nextBtn = document.getElementById("next-btn");
  const undoBanner = document.getElementById("undo-banner");
  const undoText = document.getElementById("undo-text");
  const undoBtn = document.getElementById("undo-btn");
  const undoDismissBtn = document.getElementById("undo-dismiss-btn");

  apiKeyInput.value = mrApiKey;
  challengeIdInput.value = mrChallengeId;

  const map = L.map("map", { preferCanvas: true }).setView([0, 0], 2);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 20,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);
  let currentLayer = null;

  loadBtn.addEventListener("click", loadQueue);
  deleteBtn.addEventListener("click", deleteCurrentTask);
  nextBtn.addEventListener("click", showNextTask);
  undoBtn.addEventListener("click", undoLastDelete);
  undoDismissBtn.addEventListener("click", hideUndoBanner);

  // If this device/browser already has credentials saved (from a prior visit
  // here, or from the full desktop tool sharing the same localStorage), skip
  // straight to loading - the whole point of this view is being quick.
  if (mrApiKey && mrChallengeId) {
    loadQueue();
  }

  async function mrRequest(path, options) {
    const res = await fetch(MR_API_BASE + path, {
      ...options,
      headers: Object.assign(
        { apiKey: mrApiKey, "Content-Type": "application/json", From: "Block Triage - tronnalegacy@pm.me" },
        (options && options.headers) || {}
      ),
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = await res.text();
      } catch (err) {
        // ignore - use status text below
      }
      throw new Error(`MapRoulette API ${res.status}: ${detail || res.statusText}`);
    }
    if (res.status === 204 || res.status === 304) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async function mrDeleteTask(taskId) {
    return mrRequest(`/task/${taskId}`, { method: "DELETE" });
  }

  async function mrCreateTask(feature) {
    const body = {
      name: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      parent: Number(mrChallengeId),
      geometries: {
        type: "FeatureCollection",
        features: [{ type: "Feature", geometry: feature.geometry, properties: {} }],
      },
    };
    return mrRequest("/task", { method: "POST", body: JSON.stringify(body) });
  }

  async function fetchAllChallengeTasks(onProgress) {
    const tasks = [];
    let page = 0;
    for (;;) {
      const batch = await mrRequest(`/challenge/${encodeURIComponent(mrChallengeId)}/tasks?limit=${MR_TASKS_PAGE_SIZE}&page=${page}`);
      const items = Array.isArray(batch) ? batch : [];
      tasks.push(...items);
      if (onProgress) onProgress(tasks.length);
      if (items.length < MR_TASKS_PAGE_SIZE) break;
      page++;
    }
    return tasks;
  }

  async function loadQueue() {
    mrApiKey = apiKeyInput.value.trim();
    mrChallengeId = challengeIdInput.value.trim();
    if (!mrApiKey || !mrChallengeId) {
      setupStatusEl.textContent = "Enter both an API key and a Challenge ID.";
      setupStatusEl.className = "error";
      return;
    }
    localStorage.setItem("block-triage:mrApiKey", mrApiKey);
    localStorage.setItem("block-triage:mrChallengeId", mrChallengeId);

    loadBtn.disabled = true;
    setupStatusEl.className = "muted";
    setupStatusEl.textContent = "Loading tasks…";
    try {
      const tasks = await fetchAllChallengeTasks((n) => {
        setupStatusEl.textContent = `Loading tasks… ${n} so far…`;
      });

      const items = [];
      tasks.forEach((task) => {
        if (LOCKED_STATUS_CODES.has(task.status)) return; // nothing to do with an already-resolved task
        const taskFeatures = task.geometries && Array.isArray(task.geometries.features) ? task.geometries.features : [];
        taskFeatures.forEach((f) => {
          if (!f.geometry) return;
          const feature = { type: "Feature", geometry: f.geometry, properties: {} };
          let area = 0;
          try {
            area = turf.area(feature);
          } catch (err) {
            return; // skip anything turf can't measure rather than crash the whole load
          }
          items.push({ taskId: task.id, feature, area });
        });
      });
      items.sort((a, b) => a.area - b.area);

      queue = items;
      currentIndex = 0;
      setupScreen.hidden = true;
      showCurrentTask();
    } catch (err) {
      setupStatusEl.textContent = "Failed to load: " + err.message;
      setupStatusEl.className = "error";
    } finally {
      loadBtn.disabled = false;
    }
  }

  function showCurrentTask() {
    clearTimeout(deleteEnableTimer);
    actionStatusEl.textContent = "";
    actionStatusEl.className = "muted";

    if (currentIndex >= queue.length) {
      triageScreen.hidden = true;
      doneScreen.hidden = false;
      progressEl.textContent = "";
      return;
    }

    triageScreen.hidden = false;
    doneScreen.hidden = true;

    const item = queue[currentIndex];
    progressEl.textContent = `${currentIndex + 1} of ${queue.length}`;
    taskAreaEl.textContent = `${item.area.toFixed(1)} m²`;
    taskIdEl.textContent = `Task ${item.taskId}`;

    if (currentLayer) map.removeLayer(currentLayer);
    currentLayer = L.geoJSON(item.feature, {
      style: { color: "#e53935", weight: 3, fillColor: "#e53935", fillOpacity: 0.35 },
    }).addTo(map);
    const bounds = currentLayer.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 19 });

    deleteBtn.disabled = true;
    deleteEnableTimer = setTimeout(() => {
      deleteBtn.disabled = false;
    }, DELETE_ENABLE_DELAY_MS);
  }

  function showNextTask() {
    currentIndex++;
    showCurrentTask();
  }

  async function deleteCurrentTask() {
    if (currentIndex >= queue.length) return;
    const item = queue[currentIndex];
    deleteBtn.disabled = true;
    nextBtn.disabled = true;
    actionStatusEl.textContent = "Deleting…";
    actionStatusEl.className = "muted";
    try {
      await mrDeleteTask(item.taskId);
      queue.splice(currentIndex, 1); // the next item now sits at currentIndex
      lastDeleted = { feature: item.feature, taskId: item.taskId };
      showUndoBanner(`Deleted task ${item.taskId}.`);
      showCurrentTask();
    } catch (err) {
      actionStatusEl.textContent = "Delete failed: " + err.message;
      actionStatusEl.className = "error";
      deleteBtn.disabled = false;
    } finally {
      nextBtn.disabled = false;
    }
  }

  function showUndoBanner(message) {
    clearTimeout(undoBannerTimer);
    undoText.textContent = message;
    undoBanner.hidden = false;
    document.body.classList.add("undo-banner-visible"); // reserves space so the banner doesn't cover Delete/Next
    undoBannerTimer = setTimeout(hideUndoBanner, UNDO_BANNER_TIMEOUT_MS);
  }

  function hideUndoBanner() {
    clearTimeout(undoBannerTimer);
    undoBanner.hidden = true;
    document.body.classList.remove("undo-banner-visible");
    lastDeleted = null;
  }

  async function undoLastDelete() {
    if (!lastDeleted) return;
    const toRestore = lastDeleted;
    undoBtn.disabled = true;
    undoText.textContent = "Recreating…";
    try {
      const created = await mrCreateTask(toRestore.feature);
      clearTimeout(undoBannerTimer);
      lastDeleted = null;
      undoText.textContent = `Recreated as task ${created.id}.`;
      undoBannerTimer = setTimeout(hideUndoBanner, UNDO_BANNER_TIMEOUT_MS);
    } catch (err) {
      undoText.textContent = "Undo failed: " + err.message;
    } finally {
      undoBtn.disabled = false;
    }
  }
})();
