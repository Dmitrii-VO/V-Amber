const $ = (id) => document.getElementById(id);

const elements = {
  microphoneSelect: $("microphoneSelect"),
  wsUrlInput: $("wsUrlInput"),
  vkLiveUrlInput: $("vkLiveUrlInput"),
  toggleAdvanced: $("toggleAdvanced"),
  refreshDevicesButton: $("refreshDevicesButton"),
  startButton: $("startButton"),
  stopButton: $("stopButton"),

  sessionPill: $("sessionPill"),
  sessionDot: $("sessionDot"),
  sessionLabel: $("sessionLabel"),
  projectVersion: $("projectVersion"),

  socketDot: $("socketDot"),
  socketState: $("socketState"),
  endpointLabel: $("endpointLabel"),
  uptimeLabel: $("uptimeLabel"),

  lotArticle: $("lotArticle"),
  lotStockPill: $("lotStockPill"),
  lotEmpty: $("lotEmpty"),
  lotCard: $("lotCard"),
  lotPhoto: $("lotPhoto"),
  lotCode: $("lotCode"),
  lotName: $("lotName"),
  lotArticleValue: $("lotArticleValue"),
  lotPrice: $("lotPrice"),
  lotStock: $("lotStock"),

  detectionInset: $("detectionInset"),
  detectionCode: $("detectionCode"),
  detectionSourceLine: $("detectionSourceLine"),
  detectionCandidatesWrap: $("detectionCandidatesWrap"),

  transcriptCount: $("transcriptCount"),
  transcriptStatus: $("transcriptStatus"),
  transcriptOutput: $("transcriptOutput"),

  reservationList: $("reservationList"),
  reservationEmpty: $("reservationEmpty"),
  reservationCount: $("reservationCount"),

  eventLog: $("eventLog"),
  eventCount: $("eventCount"),

  chunksSent: $("chunksSent"),
  bytesSent: $("bytesSent"),
  partialLatency: $("partialLatency"),
  finalLatency: $("finalLatency"),

  safeModeToggle: $("safeModeToggle"),
  safeModeBadge: $("safeModeBadge"),
  digestButton: $("digestButton"),
  digestModal: $("digestModal"),
  digestClose: $("digestClose"),
  digestCancel: $("digestCancel"),
  digestDate: $("digestDate"),
  digestRefresh: $("digestRefresh"),
  digestQuickToday: $("digestQuickToday"),
  digestQuickYesterday: $("digestQuickYesterday"),
  digestList: $("digestList"),
  digestSummary: $("digestSummary"),
  digestStatus: $("digestStatus"),
  digestSend: $("digestSend"),
  sendLogsButton: $("sendLogsButton"),
  sendLogsModal: $("sendLogsModal"),
  sendLogsClose: $("sendLogsClose"),
  sendLogsCancel: $("sendLogsCancel"),
  sendLogsSubmit: $("sendLogsSubmit"),
  sendLogsDownload: $("sendLogsDownload"),
  sendLogsNote: $("sendLogsNote"),
  sendLogsMeta: $("sendLogsMeta"),
  sendLogsFileCount: $("sendLogsFileCount"),
  sendLogsFileList: $("sendLogsFileList"),
  sendLogsStatus: $("sendLogsStatus"),

  // Wish list
  wishlistButton: $("wishlistButton"),
  wishlistCount: $("wishlistCount"),
  wishlistModal: $("wishlistModal"),
  wishlistClose: $("wishlistClose"),
  wishlistCancel: $("wishlistCancel"),
  wishlistSubmit: $("wishlistSubmit"),
  wishlistStatus: $("wishlistStatus"),
  wishlistTabActiveCount: $("wishlistTabActiveCount"),
  wishlistActiveBody: $("wishlistActiveBody"),
  wishlistArchiveBody: $("wishlistArchiveBody"),
  wishlistArchiveFilter: $("wishlistArchiveFilter"),
  wishlistSummary: $("wishlistSummary"),
  wishlistManualAdd: $("wishlistManualAdd"),
  wishlistManualForm: $("wishlistManualForm"),
  wishlistManualCode: $("wishlistManualCode"),
  wishlistManualName: $("wishlistManualName"),
  wishlistManualQty: $("wishlistManualQty"),
  wishlistManualConfirm: $("wishlistManualConfirm"),
  wishlistManualCancel: $("wishlistManualCancel"),
  wishlistCheckOrders: $("wishlistCheckOrders"),
  wishlistDraftBanner: $("wishlistDraftBanner"),
  wishlistDraftBannerTime: $("wishlistDraftBannerTime"),
  wishlistDraftRestore: $("wishlistDraftRestore"),
  wishlistDraftDiscard: $("wishlistDraftDiscard"),

  wishlistSettingsStore: $("wishlistSettingsStore"),
  wishlistSettingsSupplier: $("wishlistSettingsSupplier"),
  wishlistSettingsOldDays: $("wishlistSettingsOldDays"),
  wishlistSettingsNotifyVk: $("wishlistSettingsNotifyVk"),
  wishlistSettingsTemplate: $("wishlistSettingsTemplate"),
  wishlistSettingsSave: $("wishlistSettingsSave"),
  wishlistSettingsStatus: $("wishlistSettingsStatus"),

  wishlistConfirmModal: $("wishlistConfirmModal"),
  wishlistConfirmText: $("wishlistConfirmText"),
  wishlistConfirmCancel: $("wishlistConfirmCancel"),
  wishlistConfirmOk: $("wishlistConfirmOk"),
};

const state = {
  audioContext: null,
  mediaStream: null,
  sourceNode: null,
  workletNode: null,
  monitorGain: null,
  websocket: null,
  pendingSocketClose: null,
  lifecycle: "idle",
  setupGeneration: 0,
  selectedDeviceId: "",
  activeLotOpenedAt: null,
  reservationsThisSession: 0,
  chunksSent: 0,
  bytesSent: 0,
  finalLines: [],
  partialText: "",
  eventsCount: 0,
  transcriptFinalCount: 0,
  lastDetection: null,
  safeMode: false,
  startedAt: 0,
  uptimeTimer: null,
};

const digestState = {
  date: "",
  clients: [],
  loading: false,
  sending: false,
  results: new Map(),
  selectedViewerIds: new Set(),
};

const TARGET_SAMPLE_RATE = 16000;

async function requestDeviceLabels() {
  const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  tempStream.getTracks().forEach((track) => track.stop());
}

async function loadInputDevices() {
  try {
    await requestDeviceLabels();
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === "audioinput");

    elements.microphoneSelect.innerHTML = "";

    for (const [index, device] of inputs.entries()) {
      const option = document.createElement("option");
      option.value = device.deviceId;
      option.textContent = device.label || `Microphone ${index + 1}`;
      elements.microphoneSelect.append(option);
    }

    if (inputs.length === 0) {
      const option = document.createElement("option");
      option.textContent = "Микрофоны не найдены";
      option.disabled = true;
      option.selected = true;
      elements.microphoneSelect.append(option);
    }

    // Restore previously chosen mic if still available; otherwise fall back to
    // the first option. Persisted via mic-select 'change' handler.
    const savedDeviceId = localStorage.getItem("microphoneDeviceId");
    if (savedDeviceId && inputs.some((d) => d.deviceId === savedDeviceId)) {
      elements.microphoneSelect.value = savedDeviceId;
    }
    state.selectedDeviceId = elements.microphoneSelect.value;
    logEvent(`Найдено микрофонов: ${inputs.length}`, "info");
  } catch (error) {
    handleError(error, "Не удалось получить список микрофонов");
  }
}

function logEvent(message, level = "info") {
  const row = document.createElement("div");
  row.className = "event";
  const t = document.createElement("span");
  t.className = "t";
  t.textContent = new Date().toLocaleTimeString();
  const msg = document.createElement("span");
  msg.className = "msg";
  msg.dataset.lvl = level;
  if (level === "err") msg.style.color = "var(--red)";
  else if (level === "warn") msg.style.color = "var(--amber)";
  else if (level === "ok") msg.style.color = "var(--green)";
  msg.textContent = message;
  row.append(t, msg);
  elements.eventLog.prepend(row);

  state.eventsCount += 1;
  elements.eventCount.textContent = `· ${state.eventsCount}`;

  while (elements.eventLog.children.length > 80) {
    elements.eventLog.lastChild.remove();
  }
}

function setSessionPill(kind, label) {
  elements.sessionLabel.textContent = label;
  elements.sessionDot.className = "dot";
  elements.sessionPill.className = "pill";
  if (kind === "live") {
    elements.sessionDot.classList.add("dot--live");
    elements.sessionPill.classList.add("pill--green");
  } else if (kind === "warn") {
    elements.sessionDot.classList.add("dot--warn");
    elements.sessionPill.classList.add("pill--amber");
  } else if (kind === "err") {
    elements.sessionDot.classList.add("dot--err");
    elements.sessionPill.classList.add("pill--red");
  }
}

async function fetchProjectVersion() {
  try {
    const response = await fetch("/health");
    const data = await response.json();
    if (data.version && elements.projectVersion) {
      elements.projectVersion.textContent = `v${data.version}`;
    }
  } catch {
    // Version label is informational; keep the header quiet if /health is unavailable.
  }
}

function setSocketState(value) {
  elements.socketState.textContent = value;
  elements.socketDot.className = "dot";
  if (value === "connected") elements.socketDot.classList.add("dot--live");
  else if (value === "error") elements.socketDot.classList.add("dot--err");
}

function setLifecycle(next) {
  const previous = state.lifecycle;
  state.lifecycle = next;
  const isActive = next === "starting" || next === "streaming" || next === "stopping";

  // Stream just ended after a session with at least one reservation —
  // suggest opening the daily digest. The banner is dismissable; we don't
  // open the modal automatically because that would steal focus right when
  // the operator may still be reading the room.
  if (next === "idle" && previous === "stopping" && state.reservationsThisSession > 0) {
    showDigestPromptBanner(state.reservationsThisSession);
  }
  if (next === "starting") {
    state.reservationsThisSession = 0;
    state.lotsSeenThisSession = new Set();
    state.reservationTotalsByLot = new Map();
    state.eventsByLot = new Map();
    hideDigestPromptBanner();
  }

  elements.startButton.disabled = isActive;
  elements.startButton.hidden = isActive;
  elements.stopButton.hidden = !isActive;
  elements.stopButton.disabled = next === "idle";
  elements.microphoneSelect.disabled = isActive;

  if (next === "streaming") {
    setSessionPill("live", "Live");
    state.startedAt = Date.now();
    startUptimeTimer();
  } else if (next === "starting") {
    setSessionPill("warn", "Starting…");
  } else if (next === "stopping") {
    setSessionPill("warn", "Stopping…");
  } else {
    setSessionPill("", "Idle");
    stopUptimeTimer();
    elements.uptimeLabel.textContent = "0s";
  }
}

function startUptimeTimer() {
  stopUptimeTimer();
  state.uptimeTimer = window.setInterval(() => {
    const sec = Math.floor((Date.now() - state.startedAt) / 1000);
    elements.uptimeLabel.textContent = formatUptime(sec);
  }, 1000);
}
function stopUptimeTimer() {
  if (state.uptimeTimer) {
    clearInterval(state.uptimeTimer);
    state.uptimeTimer = null;
  }
}
function formatUptime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function updateMetrics() {
  elements.chunksSent.textContent = String(state.chunksSent);
  elements.bytesSent.textContent = String(state.bytesSent);
}

function clearChildren(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function renderDetection(detection) {
  state.lastDetection = detection;
  if (!detection) {
    elements.detectionInset.hidden = true;
    return;
  }

  elements.detectionInset.hidden = false;
  const chosen = detection.chosen || {};
  elements.detectionCode.textContent = chosen.code || "—";

  const parts = [];
  if (chosen.source) parts.push(chosen.source);
  if (detection.status) parts.push(detection.status);
  elements.detectionSourceLine.textContent = parts.join(" · ");

  clearChildren(elements.detectionCandidatesWrap);
  const candidates = Array.isArray(detection.candidates) ? detection.candidates : [];
  for (const c of candidates) {
    const code = c && (c.code || c);
    if (!code) continue;
    const span = document.createElement("span");
    span.className = "candidate";
    span.textContent = code;
    elements.detectionCandidatesWrap.append(span);
  }
}

// Per-session running totals — fed from each state push. We snapshot the
// active lot's events array so it survives lot switches. End-of-stream recap
// and per-buyer totals both read from this without backend changes.
function trackSessionAggregates(lot) {
  if (!lot) return;
  if (!state.lotsSeenThisSession) state.lotsSeenThisSession = new Set();
  if (!state.eventsByLot) state.eventsByLot = new Map();
  if (!state.reservationTotalsByLot) state.reservationTotalsByLot = new Map();
  if (lot.lotSessionId) state.lotsSeenThisSession.add(lot.lotSessionId);
  const events = lot.reservations?.events || [];
  state.eventsByLot.set(lot.lotSessionId, events);

  let totalQty = 0;
  let totalRub = 0;
  for (const ev of events) {
    if (ev.status !== "reserved" && ev.status !== "reserved_appended") continue;
    const qty = Number(ev.quantity) || 1;
    totalQty += qty;
    if (typeof ev.price === "number" && ev.price > 0) totalRub += ev.price * qty;
  }
  state.reservationTotalsByLot.set(lot.lotSessionId, { totalQty, totalRub });
}

function aggregatePerViewer() {
  const map = new Map();
  for (const events of state.eventsByLot?.values() || []) {
    for (const ev of events) {
      if (ev.status !== "reserved" && ev.status !== "reserved_appended") continue;
      const key = String(ev.viewerId || ev.userId || ev.viewerName || "");
      if (!key) continue;
      const qty = Number(ev.quantity) || 1;
      const rub = typeof ev.price === "number" && ev.price > 0 ? ev.price * qty : 0;
      const prev = map.get(key) || { name: ev.viewerName || ev.userName || key, count: 0, sum: 0 };
      prev.count += 1;
      prev.sum += rub;
      map.set(key, prev);
    }
  }
  return map;
}

function buildSessionRecap() {
  const lotCount = state.lotsSeenThisSession?.size || 0;
  let reservations = 0;
  let revenue = 0;
  for (const { totalQty, totalRub } of state.reservationTotalsByLot?.values() || []) {
    reservations += totalQty;
    revenue += totalRub;
  }
  return { lotCount, reservations, revenue };
}

function updateLotAge() {
  const pill = document.getElementById("lotAgePill");
  if (!pill) return;
  if (!state.activeLotOpenedAt) {
    pill.hidden = true;
    return;
  }
  const ms = Date.now() - new Date(state.activeLotOpenedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) {
    pill.hidden = true;
    return;
  }
  const minutes = Math.floor(ms / 60000);
  pill.hidden = false;
  pill.textContent = minutes < 1 ? "только что" : `открыт ${minutes} мин`;
  pill.classList.toggle("lot-age--stale", minutes >= 10);
}

setInterval(updateLotAge, 30000);

function renderActiveLot(lot) {
  const closeBtn = document.getElementById("closeLotButton");
  if (!lot) {
    elements.lotCard.hidden = true;
    elements.lotEmpty.hidden = false;
    elements.lotArticle.textContent = "";
    clearChildren(elements.lotStockPill);
    renderReservations(null);
    state.activeLotOpenedAt = null;
    updateLotAge();
    if (closeBtn) closeBtn.hidden = true;
    return;
  }

  elements.lotCard.hidden = false;
  elements.lotEmpty.hidden = true;
  if (closeBtn) closeBtn.hidden = false;

  const product = lot.product || {};
  const code = lot.code || product.code || "—";
  elements.lotCode.textContent = code;
  elements.lotArticle.textContent = `· ${code}`;
  state.activeLotOpenedAt = lot.openedAt || state.activeLotOpenedAt || new Date().toISOString();
  updateLotAge();
  elements.lotName.textContent = product.name || "—";
  elements.lotArticleValue.textContent = product.code || code;
  const lotPrice = product.salePrice > 0 ? product.salePrice : product.voicePrice;
  elements.lotPrice.textContent = lotPrice != null ? formatPrice(lotPrice) : "—";

  const stock = product.availableStock;
  elements.lotStock.textContent = stock != null ? String(stock) : "—";
  elements.lotStock.classList.remove("green", "amber", "red", "lot-stock--low", "lot-stock--empty");
  if (typeof stock === "number") {
    if (stock <= 0) {
      elements.lotStock.classList.add("red", "lot-stock--empty");
    } else if (stock <= 2) {
      elements.lotStock.classList.add("amber", "lot-stock--low");
    } else {
      elements.lotStock.classList.add("green");
    }
  }

  clearChildren(elements.lotStockPill);
  if (typeof stock === "number") {
    const pill = document.createElement("span");
    pill.className = "pill";
    if (stock <= 0) pill.classList.add("pill--red");
    else if (stock <= 2) pill.classList.add("pill--amber");
    else pill.classList.add("pill--green");
    // "осталась последняя" — explicit cue the operator can announce on air.
    let text;
    if (stock <= 0) text = "нет в наличии";
    else if (stock === 1) text = "осталась последняя";
    else if (stock <= 2) text = `осталось ${stock}`;
    else text = `остаток ${stock}`;
    pill.textContent = text;
    elements.lotStockPill.append(pill);
  }

  renderReservations(lot.reservations);
}

function formatPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("ru-RU").format(n) + " ₽";
}

function renderReservations(reservations) {
  const events = (reservations && Array.isArray(reservations.events)) ? reservations.events : [];
  clearChildren(elements.reservationList);

  if (events.length === 0) {
    elements.reservationEmpty.hidden = false;
    elements.reservationCount.textContent = "· 0";
    return;
  }
  elements.reservationEmpty.hidden = true;
  elements.reservationCount.textContent = `· ${events.length}`;
  // Used by the post-stop digest banner to decide whether to prompt the
  // operator. Tracks the high-water mark across all lots in the session,
  // not just the currently rendered lot's events.
  if (events.length > state.reservationsThisSession) {
    state.reservationsThisSession = events.length;
  }

  const perViewer = aggregatePerViewer();
  for (const ev of events.slice().reverse()) {
    const item = document.createElement("div");
    item.className = "res-item";

    const avatar = document.createElement("div");
    avatar.className = "res-avatar";
    const name = ev.viewerName || ev.userName || ev.viewerId || "?";
    avatar.textContent = String(name).slice(0, 2).toUpperCase();

    const meta = document.createElement("div");
    meta.className = "res-meta";
    const nameRow = document.createElement("div");
    nameRow.className = "res-name";
    nameRow.textContent = name;
    const detail = document.createElement("div");
    detail.className = "res-detail";
    const ts = ev.createdAt || ev.timestamp;
    const timeText = ts ? new Date(ts).toLocaleTimeString() : (ev.status || "");
    // Running total for this viewer across the whole stream — surfaces
    // "Анна: 3-я бронь, 5400 ₽" in the UI without a MoySklad round-trip.
    const key = String(ev.viewerId || ev.userId || ev.viewerName || "");
    const agg = perViewer.get(key);
    let totalText = "";
    if (agg && agg.count > 1) {
      totalText = agg.sum > 0
        ? ` · итого ${agg.count} брони, ${formatPrice(agg.sum)}`
        : ` · итого ${agg.count} брони`;
    }
    detail.textContent = `${timeText}${totalText}`;
    meta.append(nameRow, detail);

    const right = document.createElement("span");
    right.className = "pill";
    if (ev.status === "accepted" || ev.accepted) right.classList.add("pill--green");
    else if (ev.status === "rejected") right.classList.add("pill--red");
    right.textContent = ev.status || "бронь";

    item.append(avatar, meta, right);
    elements.reservationList.append(item);
  }
}

function renderTranscript() {
  const lines = state.finalLines;
  if (lines.length === 0 && !state.partialText) {
    elements.transcriptOutput.className = "transcript-empty";
    elements.transcriptOutput.textContent = "Запустите сессию для начала транскрипции";
    return;
  }
  elements.transcriptOutput.className = "transcript";
  clearChildren(elements.transcriptOutput);

  for (const line of lines) {
    const div = document.createElement("div");
    div.className = "transcript-line";
    const ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = line.ts;
    const txt = document.createElement("span");
    txt.textContent = line.text;
    div.append(ts, txt);
    elements.transcriptOutput.append(div);
  }
  if (state.partialText) {
    const div = document.createElement("div");
    div.className = "transcript-line partial";
    div.textContent = state.partialText;
    elements.transcriptOutput.append(div);
  }
  elements.transcriptOutput.scrollTop = elements.transcriptOutput.scrollHeight;
}

function setTranscriptStatus(text) {
  elements.transcriptStatus.firstElementChild
    ? (elements.transcriptStatus.firstElementChild.textContent = text)
    : (elements.transcriptStatus.textContent = text);
}

async function cleanupStreamingResources() {
  state.monitorGain?.disconnect();
  state.workletNode?.disconnect();
  state.sourceNode?.disconnect();
  state.mediaStream?.getTracks().forEach((track) => track.stop());

  if (state.audioContext && state.audioContext.state !== "closed") {
    await state.audioContext.close();
  }

  state.audioContext = null;
  state.mediaStream = null;
  state.sourceNode = null;
  state.workletNode = null;
  state.monitorGain = null;
  setLifecycle("idle");
}

function downsampleToInt16(float32Array, inputRate, targetRate) {
  if (inputRate === targetRate) return convertFloatToInt16(float32Array);
  const sampleRateRatio = inputRate / targetRate;
  const resultLength = Math.round(float32Array.length / sampleRateRatio);
  const result = new Int16Array(resultLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < resultLength) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
    let accumulator = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < float32Array.length; i += 1) {
      accumulator += float32Array[i];
      count += 1;
    }
    const sample = count > 0 ? accumulator / count : 0;
    result[offsetResult] = Math.max(-1, Math.min(1, sample)) * 0x7fff;
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

function convertFloatToInt16(float32Array) {
  const result = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i += 1) {
    result[i] = Math.max(-1, Math.min(1, float32Array[i])) * 0x7fff;
  }
  return result;
}

function connectSocket() {
  return new Promise((resolve, reject) => {
    const url = elements.wsUrlInput.value.trim();
    elements.endpointLabel.textContent = url;
    const websocket = new WebSocket(url);
    websocket.binaryType = "arraybuffer";

    websocket.addEventListener("open", () => {
      state.websocket = websocket;
      setSocketState("connected");
      logEvent("Связь с сервером установлена", "ok");
      hideConnectionBanner();
      resolve(websocket);
    });

    websocket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      try {
        const payload = JSON.parse(event.data);
        handleServerMessage(payload);
      } catch {
        logEvent(`Невалидное сообщение сервера: ${event.data}`, "warn");
      }
    });

    websocket.addEventListener("close", () => {
      setSocketState("disconnected");
      const expectedClose = state.pendingSocketClose === websocket;
      if (expectedClose) state.pendingSocketClose = null;
      if (state.websocket === websocket) state.websocket = null;

      if (expectedClose) {
        logEvent("Эфир остановлен. Связь с сервером закрыта.", "info");
        return;
      }
      logEvent("Связь с сервером оборвалась. Нажмите «Перезапустить» для возобновления.", "warn");
      showConnectionBanner();
      if (state.lifecycle !== "idle" || state.audioContext || state.mediaStream) {
        void cleanupStreamingResources();
      }
    });

    websocket.addEventListener("error", (event) => {
      setSocketState("error");
      // Server-side single-broadcast guard rejects a second connection with
      // HTTP 409 — the browser surfaces it as a generic error here. We
      // can't read the HTTP code from the WS API, but the actionable hint
      // is always the same.
      reject(new Error(
        "Не удалось подключиться. Возможно, эфир уже запущен в другой вкладке или окне. " +
        "Закройте лишние вкладки и попробуйте снова.",
      ));
    });
  });
}

function handleServerMessage(payload) {
  if (payload.type === "partial") {
    setTranscriptStatus("partial");
    elements.partialLatency.textContent = formatLatency(payload.latencyMs);
    state.partialText = payload.text || "";
    renderTranscript();
    return;
  }

  if (payload.type === "final") {
    setTranscriptStatus("final");
    elements.finalLatency.textContent = formatLatency(payload.latencyMs);
    if (payload.text) {
      state.finalLines.push({ ts: new Date().toLocaleTimeString(), text: payload.text });
      state.transcriptFinalCount += 1;
      elements.transcriptCount.textContent = `· ${state.transcriptFinalCount}`;
    }
    state.partialText = "";
    renderTranscript();
    return;
  }

  if (payload.type === "state") {
    trackSessionAggregates(payload.activeLot || null);
    renderActiveLot(payload.activeLot || null);
    renderDetection(payload.lastDetection || null);
    if (typeof payload.safeMode === "boolean") applySafeModeFromServer(payload.safeMode);
    return;
  }

  if (payload.type === "error") {
    logEvent(payload.message || "Ошибка", "err");
    return;
  }

  if (payload.type === "warning") {
    logEvent(payload.message || "Предупреждение", "warn");
    return;
  }

  if (payload.type === "info") {
    logEvent(payload.message || "", "info");
    return;
  }

  if (payload.type === "wishlist_count_changed") {
    updateWishlistBadge(payload.count);
    return;
  }

  logEvent(`Неизвестное сообщение: ${JSON.stringify(payload)}`, "warn");
}

function formatLatency(value) {
  if (typeof value !== "number") return "—";
  return `${Math.round(value)} ms`;
}

function showDigestPromptBanner(reservationCount) {
  const banner = document.getElementById("digestPromptBanner");
  const text = document.getElementById("digestPromptText");
  if (!banner) return;
  const recap = buildSessionRecap();
  const parts = [`Лотов: ${recap.lotCount}`, `броней: ${reservationCount}`];
  if (recap.revenue > 0) parts.push(`сумма: ${formatPrice(recap.revenue)}`);
  if (text) {
    text.textContent = `${parts.join(", ")}. Отправить клиентам сводку в ЛС?`;
  }
  banner.hidden = false;
}

function hideDigestPromptBanner() {
  const banner = document.getElementById("digestPromptBanner");
  if (banner) banner.hidden = true;
}

document.getElementById("digestPromptOpen")?.addEventListener("click", () => {
  hideDigestPromptBanner();
  openDigestModal();
});

document.getElementById("digestPromptDismiss")?.addEventListener("click", hideDigestPromptBanner);

function showConnectionBanner() {
  const banner = document.getElementById("connectionBanner");
  if (banner) banner.hidden = false;
}

function hideConnectionBanner() {
  const banner = document.getElementById("connectionBanner");
  if (banner) banner.hidden = true;
}

document.getElementById("connectionBannerStart")?.addEventListener("click", () => {
  hideConnectionBanner();
  if (state.lifecycle === "idle") void startStreaming();
});

// Non-blocking inline replacement for window.confirm — used at the start of a
// session for product-code cache and during streaming for one-off operator
// confirmations. Stays out of the main thread so partial transcripts can
// still flow while the operator decides.
function askCacheChoice() {
  const remembered = localStorage.getItem("cacheBannerPref");
  if (remembered === "load" || remembered === "skip") {
    return Promise.resolve(remembered);
  }

  const banner = document.getElementById("cacheBanner");
  const loadBtn = document.getElementById("cacheBannerLoad");
  const skipBtn = document.getElementById("cacheBannerSkip");
  const remember = document.getElementById("cacheBannerRemember");
  if (!banner || !loadBtn || !skipBtn) {
    // Defensive fallback — element missing in stripped HTML build.
    return Promise.resolve("load");
  }

  return new Promise((resolve) => {
    banner.hidden = false;
    const finish = (choice) => {
      if (remember?.checked) localStorage.setItem("cacheBannerPref", choice);
      banner.hidden = true;
      loadBtn.removeEventListener("click", onLoad);
      skipBtn.removeEventListener("click", onSkip);
      resolve(choice);
    };
    const onLoad = () => finish("load");
    const onSkip = () => finish("skip");
    loadBtn.addEventListener("click", onLoad);
    skipBtn.addEventListener("click", onSkip);
  });
}

async function refreshProductCodeCacheIfRequested() {
  const choice = await askCacheChoice();
  if (choice === "skip") {
    logEvent("Загрузка кодов товаров пропущена", "warn");
    return;
  }

  logEvent("Загружаю коды товаров из МойСклад…", "info");
  const response = await fetch("/api/product-codes/refresh", { method: "POST" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }

  logEvent(`Коды товаров загружены: ${payload.count || 0}`, "ok");
}

async function startStreaming() {
  if (state.lifecycle !== "idle") return;

  const setupGeneration = state.setupGeneration + 1;
  state.setupGeneration = setupGeneration;
  setLifecycle("starting");

  try {
    try {
      await refreshProductCodeCacheIfRequested();
    } catch (cacheError) {
      // Fall through: streaming proceeds without the cache. The operator
      // sees the warning in the event log; abandoning the start mid-flight
      // costs a couple of seconds and an extra click before air, which is
      // worse than running the broadcast without the cache for the first
      // few lots.
      logEvent(
        `Не удалось загрузить коды товаров: ${cacheError.message || cacheError}. Эфир запускается без кеша.`,
        "warn",
      );
    }

    if (state.setupGeneration !== setupGeneration || state.lifecycle !== "starting") {
      return;
    }

    state.chunksSent = 0;
    state.bytesSent = 0;
    state.finalLines = [];
    state.partialText = "";
    state.transcriptFinalCount = 0;
    elements.transcriptCount.textContent = "· 0";
    updateMetrics();
    renderTranscript();
    renderDetection(null);

    const websocket = await connectSocket();
    if (state.setupGeneration !== setupGeneration || state.lifecycle !== "starting") {
      websocket.close();
      return;
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: state.selectedDeviceId ? { exact: state.selectedDeviceId } : undefined,
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    if (state.setupGeneration !== setupGeneration || state.lifecycle !== "starting") {
      stream.getTracks().forEach((t) => t.stop());
      websocket.close();
      return;
    }

    const audioContext = new AudioContext();
    await audioContext.audioWorklet.addModule("./audio-processor.js");

    if (state.setupGeneration !== setupGeneration || state.lifecycle !== "starting") {
      await audioContext.close();
      stream.getTracks().forEach((t) => t.stop());
      websocket.close();
      return;
    }

    const sourceNode = audioContext.createMediaStreamSource(stream);
    const workletNode = new AudioWorkletNode(audioContext, "pcm-capture-processor");
    const monitorGain = audioContext.createGain();
    monitorGain.gain.value = 0;

    websocket.send(JSON.stringify({
      type: "start",
      sampleRate: TARGET_SAMPLE_RATE,
      encoding: "pcm_s16le",
      deviceId: state.selectedDeviceId || null,
      startedAt: new Date().toISOString(),
      vkLiveVideoUrl: elements.vkLiveUrlInput.value.trim() || null,
    }));

    workletNode.port.onmessage = (event) => {
      if (state.lifecycle !== "streaming" || !state.websocket || state.websocket.readyState !== WebSocket.OPEN) return;
      const pcmChunk = downsampleToInt16(event.data, audioContext.sampleRate, TARGET_SAMPLE_RATE);
      state.websocket.send(pcmChunk.buffer);
      state.chunksSent += 1;
      state.bytesSent += pcmChunk.byteLength;
      updateMetrics();
    };

    sourceNode.connect(workletNode);
    workletNode.connect(monitorGain);
    monitorGain.connect(audioContext.destination);

    state.audioContext = audioContext;
    state.mediaStream = stream;
    state.sourceNode = sourceNode;
    state.workletNode = workletNode;
    state.monitorGain = monitorGain;

    setLifecycle("streaming");
    setTranscriptStatus("listening");
    logEvent("Эфир запущен. Можно называть код товара или цену.", "ok");
  } catch (error) {
    handleError(error, "Не удалось запустить стриминг");
    await stopStreaming();
  }
}

async function stopStreaming() {
  if (state.lifecycle === "idle") return;
  state.setupGeneration += 1;
  setLifecycle("stopping");

  if (state.websocket?.readyState === WebSocket.OPEN) {
    const socketToClose = state.websocket;
    state.pendingSocketClose = socketToClose;
    socketToClose.send(JSON.stringify({ type: "stop", stoppedAt: new Date().toISOString() }));
    window.setTimeout(() => {
      if (socketToClose.readyState === WebSocket.OPEN) socketToClose.close();
    }, 1500);
  }

  await cleanupStreamingResources();
  setTranscriptStatus("idle");
  logEvent("Эфир остановлен.", "info");
}

function handleError(error, prefix) {
  const details = error instanceof Error ? error.message : String(error);
  logEvent(`${prefix}: ${details}`, "err");
  console.error(error);
}

function renderSafeMode() {
  elements.safeModeToggle.checked = state.safeMode;
  elements.safeModeBadge.hidden = !state.safeMode;
}

function applySafeModeFromServer(value) {
  state.safeMode = Boolean(value);
  renderSafeMode();
}

async function requestSafeModeViaHttp(desired) {
  const response = await fetch("/api/safe-mode", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: desired }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  applySafeModeFromServer(payload.safeMode);
}

async function fetchSafeModeInitial() {
  try {
    const response = await fetch("/api/safe-mode");
    if (!response.ok) return;
    const payload = await response.json();
    applySafeModeFromServer(payload.safeMode);
  } catch (error) {
    handleError(error, "Не удалось получить состояние safe mode");
  }
}

elements.safeModeToggle.addEventListener("change", (event) => {
  const desired = event.target.checked;
  logEvent(desired ? "Safe mode: запрос на включение" : "Safe mode: запрос на выключение", "info");

  if (state.websocket && state.websocket.readyState === WebSocket.OPEN) {
    state.websocket.send(JSON.stringify({ type: "setSafeMode", enabled: desired }));
    return;
  }
  requestSafeModeViaHttp(desired).catch((error) => {
    elements.safeModeToggle.checked = state.safeMode;
    handleError(error, "Safe mode: не удалось переключить");
  });
});

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "?";
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(2)} МБ`;
}

function setSendLogsStatus(text, level) {
  const el = elements.sendLogsStatus;
  if (!text) { el.hidden = true; el.textContent = ""; return; }
  el.hidden = false;
  el.textContent = text;
  el.classList.toggle("ok", level === "ok");
  el.classList.toggle("error", level === "error");
}

function setSendLogsBusy(busy) {
  elements.sendLogsSubmit.disabled = true;
  elements.sendLogsDownload.disabled = busy;
  elements.sendLogsCancel.disabled = busy;
  elements.sendLogsClose.disabled = busy;
}

function closeSendLogsModal() {
  elements.sendLogsModal.hidden = true;
  setSendLogsStatus("", null);
}

async function loadSendLogsPreview() {
  elements.sendLogsMeta.textContent = "Загружаю список файлов...";
  elements.sendLogsFileList.innerHTML = "";
  elements.sendLogsFileCount.textContent = "0";
  elements.sendLogsSubmit.disabled = true;
  elements.sendLogsDownload.disabled = true;
  try {
    const response = await fetch("/api/send-logs/preview");
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
    elements.sendLogsFileCount.textContent = String(payload.files.length);
    elements.sendLogsFileList.innerHTML = payload.files.map((f) => {
      const note = f.truncated ? ` (обрезано из ${formatBytes(f.originalBytes)})` : "";
      return `<li><span>${f.name}</span><span>${formatBytes(f.bytes)}${note}</span></li>`;
    }).join("");
    elements.sendLogsMeta.textContent =
      `Всего: ${formatBytes(payload.totalBytes)} в исходном виде · доступно только скачивание`;
    elements.sendLogsSubmit.hidden = true;
    elements.sendLogsSubmit.disabled = true;
    elements.sendLogsDownload.disabled = false;
  } catch (error) {
    elements.sendLogsMeta.textContent = `Ошибка: ${error.message}`;
  }
}

function openSendLogsModal() {
  elements.sendLogsModal.hidden = false;
  setSendLogsStatus("", null);
  elements.sendLogsNote.value = "";
  loadSendLogsPreview();
}

elements.sendLogsButton.addEventListener("click", openSendLogsModal);
elements.sendLogsClose.addEventListener("click", closeSendLogsModal);
elements.sendLogsCancel.addEventListener("click", closeSendLogsModal);
elements.sendLogsModal.addEventListener("click", (event) => {
  if (event.target === elements.sendLogsModal) closeSendLogsModal();
});

elements.sendLogsDownload.addEventListener("click", async () => {
  const userNote = elements.sendLogsNote.value.trim();
  setSendLogsBusy(true);
  setSendLogsStatus("Готовлю архив...", null);
  try {
    const response = await fetch("/api/send-logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userNote, download: true }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
    const disposition = response.headers.get("content-disposition") || "";
    const match = /filename="([^"]+)"/.exec(disposition);
    const filename = match ? match[1] : "v-amber-logs.zip";
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setSendLogsStatus(`Архив скачан (${formatBytes(blob.size)})`, "ok");
    logEvent(`Логи скачаны (${formatBytes(blob.size)})`, "success");
  } catch (error) {
    setSendLogsStatus(`Не удалось скачать: ${error.message}`, "error");
    handleError(error, "Не удалось скачать логи");
  } finally {
    setSendLogsBusy(false);
  }
});

const vkLiveUrlWrap = document.getElementById("vkLiveUrlWrap");
const vkUrlStatus = document.getElementById("vkUrlStatus");

function setVkUrlStatus(level, text) {
  if (!vkUrlStatus) return;
  if (!level) {
    vkUrlStatus.hidden = true;
    vkUrlStatus.className = "vk-url-status";
    vkUrlStatus.textContent = "";
    state.vkUrlValid = null;
    return;
  }
  vkUrlStatus.hidden = false;
  vkUrlStatus.className = `vk-url-status ${level}`;
  vkUrlStatus.textContent = text;
}
state.vkUrlValid = null;

let vkUrlValidationToken = 0;
async function validateVkUrl(url) {
  const myToken = ++vkUrlValidationToken;
  if (!url) {
    setVkUrlStatus(null);
    return;
  }
  setVkUrlStatus("checking", "Проверяю канал...");
  try {
    const response = await fetch("/api/vk/validate-url?url=" + encodeURIComponent(url));
    const payload = await response.json();
    if (myToken !== vkUrlValidationToken) return;
    if (payload.ok) {
      const titleSnippet = payload.title ? ` · ${payload.title.slice(0, 40)}` : "";
      const liveMark = payload.isLive ? " · LIVE" : "";
      setVkUrlStatus("ok", `✓ Канал доступен${liveMark}${titleSnippet}`);
      state.vkUrlValid = true;
    } else {
      setVkUrlStatus("error", `✗ ${payload.message || payload.code || "Не могу подтвердить ссылку"}`);
      state.vkUrlValid = false;
    }
  } catch (error) {
    if (myToken !== vkUrlValidationToken) return;
    setVkUrlStatus("error", `✗ Ошибка проверки: ${error.message}`);
    state.vkUrlValid = false;
  }
}

let vkUrlDebounce = null;
function scheduleVkUrlValidation(url) {
  clearTimeout(vkUrlDebounce);
  vkUrlDebounce = setTimeout(() => validateVkUrl(url), 400);
}

elements.toggleAdvanced.addEventListener("click", () => {
  vkLiveUrlWrap.hidden = !vkLiveUrlWrap.hidden;
  if (!vkLiveUrlWrap.hidden) elements.vkLiveUrlInput.focus();
});

elements.refreshDevicesButton.addEventListener("click", loadInputDevices);
elements.startButton.addEventListener("click", startStreaming);
elements.stopButton.addEventListener("click", stopStreaming);

document.getElementById("closeLotButton")?.addEventListener("click", () => {
  if (state.websocket && state.websocket.readyState === 1) {
    state.websocket.send(JSON.stringify({ type: "closeLot" }));
    logEvent("Лот закрыт вручную", "info");
  } else {
    logEvent("Связь с сервером не установлена — нельзя закрыть лот", "warn");
  }
});

// Click-to-edit on the lot price field. Replaces the rendered price with a
// small inline number input; Enter applies, Escape cancels. Server hops the
// new value through setLotPrice (see ws-server.js).
function arePriceEditsAllowed() {
  return state.lifecycle === "streaming" || state.lifecycle === "starting";
}
elements.lotPrice.addEventListener("click", () => {
  if (!arePriceEditsAllowed()) return;
  if (elements.lotPrice.dataset.editing === "1") return;
  elements.lotPrice.dataset.editing = "1";

  const original = elements.lotPrice.textContent;
  // Strip currency / spaces so the input shows a number the operator can edit.
  const seed = (original || "").replace(/[^\d]/g, "");
  const input = document.createElement("input");
  input.type = "number";
  input.min = "1";
  input.step = "1";
  input.value = seed;
  input.className = "input";
  input.style.maxWidth = "100px";
  input.style.padding = "2px 6px";

  elements.lotPrice.textContent = "";
  elements.lotPrice.append(input);
  input.focus();
  input.select();

  const restore = () => {
    elements.lotPrice.textContent = original;
    delete elements.lotPrice.dataset.editing;
  };

  const apply = () => {
    const value = Number(input.value);
    if (!Number.isFinite(value) || value <= 0) {
      restore();
      return;
    }
    if (state.websocket && state.websocket.readyState === 1) {
      state.websocket.send(JSON.stringify({ type: "setLotPrice", value }));
      logEvent(`Цена изменена вручную: ${value} ₽`, "ok");
    }
    // Server will emit a fresh state shortly; restore visually in the meantime.
    restore();
  };

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      apply();
    } else if (event.key === "Escape") {
      event.preventDefault();
      restore();
    }
  });
  input.addEventListener("blur", restore);
});
elements.microphoneSelect.addEventListener("change", (event) => {
  state.selectedDeviceId = event.target.value;
  if (event.target.value) {
    localStorage.setItem("microphoneDeviceId", event.target.value);
  }
});
elements.vkLiveUrlInput.addEventListener("input", () => {
  const url = elements.vkLiveUrlInput.value.trim();
  localStorage.setItem("vkLiveVideoUrl", url);
  scheduleVkUrlValidation(url);
});

const savedVkUrl = localStorage.getItem("vkLiveVideoUrl");
if (savedVkUrl) {
  elements.vkLiveUrlInput.value = savedVkUrl;
  vkLiveUrlWrap.hidden = false;
  validateVkUrl(savedVkUrl);
}

elements.endpointLabel.textContent = elements.wsUrlInput.value;
setSessionPill("", "Idle");
renderSafeMode();
fetchSafeModeInitial();

navigator.mediaDevices.addEventListener("devicechange", loadInputDevices);
loadInputDevices();

// ===== Reservation digests =====

function todayLocalDate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function setDigestStatus(text, level) {
  elements.digestStatus.hidden = !text;
  elements.digestStatus.textContent = text || "";
  elements.digestStatus.className = "modal-status" + (level ? ` ${level}` : "");
}

function statusLabel(status) {
  const map = {
    sent: "отправлено",
    already_sent: "уже отправлено",
    dm_not_allowed: "ЛС закрыты",
    missing_vk_id: "нет VK ID",
    safe_mode_blocked: "safe mode",
    failed: "ошибка",
  };
  return map[status] || status || "";
}

function digestClientStatus(client) {
  const result = client.viewerId ? digestState.results.get(String(client.viewerId)) : null;
  if (result?.status) return result.status;
  if (client.alreadySent) return "already_sent";
  if (!client.viewerId) return "missing_vk_id";
  if (!client.canSend && client.cannotSendReason) return client.cannotSendReason;
  return "ready";
}

function updateDigestSendState() {
  const selectedCount = digestState.clients.filter((client) =>
    client.viewerId
    && !client.alreadySent
    && client.canSend
    && digestState.selectedViewerIds.has(String(client.viewerId))
  ).length;
  elements.digestSend.disabled = digestState.loading || digestState.sending || selectedCount === 0;
  elements.digestSummary.textContent = digestState.loading
    ? "Загрузка..."
    : `${digestState.clients.length} клиентов, к отправке ${selectedCount}`;
}

function renderDigestPreview() {
  const previousSelection = digestState.selectedViewerIds;
  digestState.selectedViewerIds = new Set();
  for (const client of digestState.clients) {
    const viewerId = client.viewerId ? String(client.viewerId) : "";
    if (!viewerId || client.alreadySent || !client.canSend) continue;
    if (previousSelection.size === 0 || previousSelection.has(viewerId)) {
      digestState.selectedViewerIds.add(viewerId);
    }
  }

  if (digestState.clients.length === 0) {
    elements.digestList.innerHTML = `<div class="wishlist-empty">За выбранный день открытых броней с #Эфир не найдено.</div>`;
    updateDigestSendState();
    return;
  }

  elements.digestList.innerHTML = digestState.clients.map((client) => {
    const status = digestClientStatus(client);
    const ready = status === "ready";
    const statusClass = ready || status === "sent" ? "pill--green"
      : (status === "already_sent" ? "pill--blue" : "pill--amber");
    const positions = (client.positions || []).map((p) => `
      <li>
        <span class="mono">${escapeHtml(p.productCode || "—")}</span>
        <span>${escapeHtml(p.productName || "Товар")}</span>
        <span class="mono">${escapeHtml(p.quantity || 0)} шт</span>
        <span class="mono">${escapeHtml(formatPrice(p.sum || 0))}</span>
      </li>
    `).join("");
    const orders = (client.orders || []).map((order) => `
      <a href="${escapeHtml(order.url || "#")}" target="_blank" rel="noreferrer">${escapeHtml(order.name || order.id || "заказ")}</a>
    `).join(", ");
    const result = client.viewerId ? digestState.results.get(String(client.viewerId)) : null;
    const error = result?.error ? `<div class="digest-error">${escapeHtml(result.error)}</div>` : "";
    const checked = client.viewerId && digestState.selectedViewerIds.has(String(client.viewerId));
    return `
      <section class="digest-client ${ready ? "" : "digest-client--muted"}">
        <div class="digest-client-head">
          <label class="digest-check">
            <input class="digest-select" data-viewer-id="${escapeHtml(client.viewerId || "")}" type="checkbox" ${ready && checked ? "checked" : ""} ${ready ? "" : "disabled"} />
            <span>${escapeHtml(client.viewerName || (client.viewerId ? `VK ${client.viewerId}` : "Клиент без VK ID"))}</span>
          </label>
          <span class="pill ${statusClass}">${ready ? "можно отправить" : escapeHtml(statusLabel(status))}</span>
        </div>
        <div class="digest-meta">
          <span>VK: <span class="mono">${escapeHtml(client.viewerId || "—")}</span></span>
          <span>Заказы: ${orders || "—"}</span>
          <span>Итого: <span class="mono">${escapeHtml(formatPrice(client.total || 0))}</span></span>
        </div>
        <ul class="digest-positions">${positions}</ul>
        ${error}
      </section>
    `;
  }).join("");

  document.querySelectorAll(".digest-select").forEach((input) => {
    input.addEventListener("change", () => {
      const viewerId = String(input.dataset.viewerId || "");
      if (!viewerId) return;
      if (input.checked) digestState.selectedViewerIds.add(viewerId);
      else digestState.selectedViewerIds.delete(viewerId);
      updateDigestSendState();
    });
  });
  updateDigestSendState();
}

async function loadDigestPreview() {
  const date = elements.digestDate.value || todayLocalDate();
  digestState.date = date;
  digestState.loading = true;
  digestState.results = new Map();
  digestState.selectedViewerIds = new Set();
  setDigestStatus("Загружаю брони из МойСклада...", null);
  updateDigestSendState();
  try {
    const res = await fetch(`/api/reservation-digests/preview?date=${encodeURIComponent(date)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
    digestState.clients = data.clients || [];
    renderDigestPreview();
    setDigestStatus(`Предпросмотр обновлен: ${data.count || 0}.`, "ok");
  } catch (error) {
    digestState.clients = [];
    renderDigestPreview();
    setDigestStatus(`Ошибка: ${error.message}`, "error");
  } finally {
    digestState.loading = false;
    updateDigestSendState();
  }
}

function openDigestModal() {
  elements.digestModal.hidden = false;
  elements.digestDate.value = digestState.date || todayLocalDate();
  setDigestStatus("", null);
  void loadDigestPreview();
}

function closeDigestModal() {
  elements.digestModal.hidden = true;
}

async function sendDigestMessages() {
  const viewerIds = digestState.clients
    .filter((client) =>
      client.viewerId
      && !client.alreadySent
      && client.canSend
      && digestState.selectedViewerIds.has(String(client.viewerId))
    )
    .map((client) => String(client.viewerId));
  if (viewerIds.length === 0) return;

  digestState.sending = true;
  elements.digestSend.disabled = true;
  setDigestStatus("Отправляю сообщения VK...", null);
  try {
    const res = await fetch("/api/reservation-digests/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ date: elements.digestDate.value, viewerIds }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
    digestState.results = new Map((data.results || [])
      .filter((item) => item.viewerId)
      .map((item) => [String(item.viewerId), item]));
    for (const client of digestState.clients) {
      const result = client.viewerId ? digestState.results.get(String(client.viewerId)) : null;
      if (result?.status === "sent" || result?.status === "already_sent") {
        client.alreadySent = true;
        client.canSend = false;
      }
    }
    renderDigestPreview();
    const counts = (data.results || []).reduce((acc, item) => {
      acc[item.status] = (acc[item.status] || 0) + 1;
      return acc;
    }, {});
    setDigestStatus(
      `Готово: отправлено ${counts.sent || 0}, уже было ${counts.already_sent || 0}, ЛС закрыты ${counts.dm_not_allowed || 0}, safe mode ${counts.safe_mode_blocked || 0}, ошибок ${counts.failed || 0}.`,
      (counts.failed || counts.dm_not_allowed || counts.safe_mode_blocked) ? "error" : "ok",
    );
  } catch (error) {
    setDigestStatus(`Ошибка отправки: ${error.message}`, "error");
  } finally {
    digestState.sending = false;
    updateDigestSendState();
  }
}

elements.digestButton.addEventListener("click", openDigestModal);
elements.digestClose.addEventListener("click", closeDigestModal);
elements.digestCancel.addEventListener("click", closeDigestModal);
elements.digestRefresh.addEventListener("click", loadDigestPreview);
elements.digestSend.addEventListener("click", sendDigestMessages);
elements.digestQuickToday.addEventListener("click", () => {
  elements.digestDate.value = todayLocalDate();
  void loadDigestPreview();
});
elements.digestQuickYesterday.addEventListener("click", () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const pad = (n) => String(n).padStart(2, "0");
  elements.digestDate.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  void loadDigestPreview();
});
elements.digestModal.addEventListener("click", (event) => {
  if (event.target === elements.digestModal) closeDigestModal();
});

// ===== Wish list =====
const wishlistState = {
  draftId: null,
  groups: [],       // [{supplierId, supplierName, entries:[{id,...,selected:bool}]}]
  archiveCache: [],
  settings: null,
  suppliers: [],
  stores: [],
  pendingSubmit: false,
  saveTimers: new Map(), // entryId -> timeout id (debounce)
  oldEntries: 0,
};

const WISHLIST_DRAFT_KEY_PREFIX = "wishlist_draft_";

function updateWishlistBadge(count) {
  if (typeof count !== "number") return;
  elements.wishlistCount.textContent = String(count);
  elements.wishlistCount.classList.toggle("has-items", count > 0);
  elements.wishlistCount.classList.toggle("has-old", wishlistState.oldEntries > 0);
  if (elements.wishlistTabActiveCount) elements.wishlistTabActiveCount.textContent = String(count);
}

async function fetchWishlistCount() {
  try {
    const res = await fetch("/api/wishlist/count");
    const data = await res.json();
    updateWishlistBadge(data.count || 0);
  } catch { /* ignore */ }
}

function setWishlistStatus(text, level) {
  const el = elements.wishlistStatus;
  if (!text) { el.hidden = true; el.textContent = ""; el.className = "modal-status"; return; }
  el.hidden = false;
  el.textContent = text;
  el.className = "modal-status" + (level ? ` ${level}` : "");
}

function switchWishlistTab(tabName) {
  document.querySelectorAll(".wishlist-tab").forEach((b) => {
    b.classList.toggle("is-active", b.dataset.tab === tabName);
  });
  document.querySelectorAll(".wishlist-pane").forEach((p) => {
    p.classList.toggle("is-active", p.dataset.pane === tabName);
  });
  if (tabName === "archive") void loadWishlistArchive();
  if (tabName === "settings") void loadWishlistSettings();
}

async function openWishlistModal() {
  elements.wishlistModal.hidden = false;
  setWishlistStatus("", null);
  switchWishlistTab("active");
  await loadWishlistActive();
}

function closeWishlistModal() {
  elements.wishlistModal.hidden = true;
  setWishlistStatus("", null);
}

async function loadWishlistActive() {
  try {
    const draftRes = await fetch("/api/wishlist/draft", { method: "POST" });
    const draftData = await draftRes.json();
    wishlistState.draftId = draftData.draftId;
    wishlistState.groups = (draftData.groups || []).map((g) => ({
      ...g,
      entries: g.entries.map((e) => ({ ...e, selected: true })),
    }));
    // Восстановление черновика из localStorage, если есть.
    const stored = loadStoredDraft();
    if (stored && stored.draftId === wishlistState.draftId) {
      // на свежий draftId сохранённое не относится (draftId меняется каждый раз);
      // показываем баннер только если есть «совместимый» draft с теми же entryIds.
    }
    const savedDraft = loadCompatibleStoredDraft(wishlistState.groups);
    if (savedDraft) {
      const time = new Date(savedDraft.savedAt).toLocaleTimeString();
      elements.wishlistDraftBannerTime.textContent = time;
      elements.wishlistDraftBanner.hidden = false;
      elements.wishlistDraftRestore.onclick = () => {
        applyStoredDraft(savedDraft);
        renderWishlistActive();
        elements.wishlistDraftBanner.hidden = true;
      };
      elements.wishlistDraftDiscard.onclick = () => {
        clearStoredDraft();
        elements.wishlistDraftBanner.hidden = true;
      };
    } else {
      elements.wishlistDraftBanner.hidden = true;
    }
    renderWishlistActive();
  } catch (error) {
    setWishlistStatus(`Не удалось загрузить wish list: ${error.message}`, "error");
  }
}

function renderWishlistActive() {
  const body = elements.wishlistActiveBody;
  const groups = wishlistState.groups;
  // Записи без productId не могут уйти в PO — сразу гасим selected, чтобы submit и
  // суммы не учитывали их. (Пользователь увидит дизейбленный чекбокс и подсказку.)
  for (const g of groups) {
    for (const e of g.entries) {
      if (!e.productId) e.selected = false;
    }
  }
  let totalActive = 0;
  let oldCount = 0;
  for (const g of groups) {
    totalActive += g.entries.length;
    oldCount += g.entries.filter((e) => e.isOld).length;
  }
  wishlistState.oldEntries = oldCount;
  updateWishlistBadge(totalActive);

  if (groups.length === 0) {
    body.innerHTML = `<div class="wishlist-empty">Wish list пуст. Используйте «+ Добавить вручную», чтобы создать предзаказ.</div>`;
    elements.wishlistSubmit.disabled = true;
    elements.wishlistSummary.textContent = "—";
    return;
  }

  body.innerHTML = groups.map((g, gIdx) => {
    const noSupplier = !g.supplierId;
    const allSelected = g.entries.every((e) => e.selected);
    const someSelected = g.entries.some((e) => e.selected);
    const sumAmount = g.entries
      .filter((e) => e.selected)
      .reduce((acc, e) => acc + (Number(e.buyPrice || 0) * Number(e.quantity || 0)), 0);
    return `
      <div class="wishlist-group ${noSupplier ? "wishlist-group--no-supplier" : ""}">
        <div class="wishlist-group-head">
          <input type="checkbox" data-group-toggle="${gIdx}" ${allSelected ? "checked" : ""}
                 ${!allSelected && someSelected ? "data-indeterminate=true" : ""} />
          <span class="wishlist-group-name">${escapeHtml(g.supplierName || "Без поставщика")}${noSupplier ? " ⚠" : ""}</span>
          <span class="wishlist-group-stats">${g.entries.filter((e) => e.selected).length}/${g.entries.length} · ${formatKopecks(sumAmount)}</span>
        </div>
        <table class="wishlist-table">
          <thead><tr>
            <th></th><th>Артикул</th><th>Товар</th><th>Кол-во</th>
            <th>Закуп. цена</th><th>Зрители</th><th>Возраст</th><th></th>
          </tr></thead>
          <tbody>
            ${g.entries.map((e) => renderWishlistRow(g, e)).join("")}
          </tbody>
        </table>
      </div>
    `;
  }).join("");

  // Indeterminate checkboxes (no HTML attribute)
  body.querySelectorAll("input[data-indeterminate]").forEach((cb) => { cb.indeterminate = true; });
  // Bind events
  body.querySelectorAll("[data-group-toggle]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const gIdx = Number(cb.dataset.groupToggle);
      const checked = cb.checked;
      wishlistState.groups[gIdx].entries.forEach((e) => {
        // Missing-product и «уже в открытом заказе» записи не отправляемы —
        // оставляем unchecked даже если оператор нажал «выделить группу».
        e.selected = checked && Boolean(e.productId) && !e.alreadyInOrder?.inOpenOrder;
      });
      renderWishlistActive();
      persistDraftDebounced();
    });
  });
  body.querySelectorAll("[data-entry-toggle]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const entry = findEntry(cb.dataset.entryToggle);
      if (entry) entry.selected = cb.checked;
      renderGroupTotals();
      persistDraftDebounced();
    });
  });
  body.querySelectorAll("[data-inline-edit]").forEach((input) => {
    input.addEventListener("input", () => {
      const entry = findEntry(input.dataset.inlineEdit);
      if (!entry) return;
      const field = input.dataset.field;
      // КРИТИЧНО: entry.buyPrice ВСЕГДА хранится в копейках (как МС отдаёт).
      // Поле в input — рубли (для удобства оператора), при чтении умножаем.
      // Раньше тут хранили рубли → submit отправлял ×100 меньшую цену в PO.
      let value;
      if (field === "quantity") {
        value = Math.max(1, Number(input.value) || 1);
      } else if (field === "buyPrice") {
        value = Math.round((Number(input.value) || 0) * 100);
      } else {
        value = Number(input.value) || 0;
      }
      entry[field] = value;
      schedulePatchEntry(entry.id, input, { [field]: value });
      persistDraftDebounced();
      // Update group total without full re-render to keep focus.
      renderGroupTotals();
    });
  });
  body.querySelectorAll("[data-supplier-pick]").forEach((sel) => {
    sel.addEventListener("change", () => {
      const entry = findEntry(sel.dataset.supplierPick);
      if (!entry) return;
      const supplierId = sel.value;
      const supplier = wishlistState.suppliers.find((s) => s.id === supplierId);
      entry.supplierId = supplierId || null;
      entry.supplierName = supplier?.name || "";
      schedulePatchEntry(entry.id, sel, { supplierId, supplierName: supplier?.name || "" });
      // После смены supplier нужна пере-группировка — перерисуем целиком.
      regroupAndRender();
    });
  });
  body.querySelectorAll("[data-remove]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const entryId = btn.dataset.remove;
      // Inline two-step delete: first click swaps the button into a confirm
      // strip ("Удалить?  [Да]  [Нет]"). Auto-reverts after 4s if the
      // operator clicks elsewhere — replaces the blocking window.confirm.
      // Built with createElement / textContent only (no innerHTML) so a
      // buyer-supplied entryId can never inject markup here.
      const wrap = document.createElement("span");
      wrap.className = "inline-confirm";

      const label = document.createElement("span");
      label.textContent = "Удалить?";
      wrap.append(label);

      const yes = document.createElement("button");
      yes.type = "button";
      yes.className = "btn btn--danger";
      yes.textContent = "Да";

      const no = document.createElement("button");
      no.type = "button";
      no.className = "btn btn--ghost";
      no.textContent = "Нет";

      wrap.append(yes, no);

      const parent = btn.parentNode;
      const nextSibling = btn.nextSibling;
      parent?.replaceChild(wrap, btn);

      const restore = () => {
        if (wrap.parentNode === parent) parent.insertBefore(btn, nextSibling);
        wrap.remove();
      };
      const timeout = setTimeout(restore, 4000);

      no.addEventListener("click", () => {
        clearTimeout(timeout);
        restore();
      });
      yes.addEventListener("click", async () => {
        clearTimeout(timeout);
        try {
          const res = await fetch(`/api/wishlist/${entryId}`, { method: "DELETE" });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          await loadWishlistActive();
        } catch (error) {
          setWishlistStatus(`Не удалось удалить: ${error.message}`, "error");
          restore();
        }
      });
    });
  });
  body.querySelectorAll("[data-archive]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const entryId = btn.dataset.archive;
      try {
        const res = await fetch(`/api/wishlist/${entryId}`, { method: "DELETE" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await loadWishlistActive();
        setWishlistStatus("Запись архивирована.", "ok");
      } catch (error) {
        setWishlistStatus(`Не удалось архивировать: ${error.message}`, "error");
      }
    });
  });

  updateSubmitButtonState();
}

function renderWishlistRow(group, entry) {
  const supplierCell = !group.supplierId
    ? `<select class="wishlist-supplier-picker" data-supplier-pick="${entry.id}">
         <option value="">Выберите поставщика…</option>
         ${wishlistState.suppliers.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join("")}
       </select>`
    : "";
  const viewers = (entry.seenEvents || []).length > 1
    ? `${entry.viewerName} +${(entry.seenEvents.length - 1)}`
    : (entry.viewerName || "—");
  const ageDays = Math.floor((Date.now() - new Date(entry.createdAt).getTime()) / 86400000);
  const ageStr = ageDays === 0 ? "сегодня" : `${ageDays} дн.`;
  const failedBadge = entry.trigger === "order_failed"
    ? `<span class="wishlist-trigger-failed">order_failed</span>` : "";

  // productId:null — товар не найден в кэше МойСклад. PO в МС упадёт без assortment.
  // Запрещаем чекбокс и подсвечиваем строку.
  const missingProduct = !entry.productId;
  const inOpenOrder = entry.alreadyInOrder?.inOpenOrder === true;
  const productCell = missingProduct
    ? `<span class="wishlist-product-missing" title="Товар с этим артикулом не найден в МойСклад. Невозможно создать PO. Удалите запись или обновите каталог.">⚠ ${escapeHtml(entry.productName || entry.productCode || "—")}</span>`
    : escapeHtml(entry.productName || "—");
  const rowClasses = [
    entry.isOld ? "wishlist-row--old" : "",
    missingProduct ? "wishlist-row--missing-product" : "",
    inOpenOrder ? "wishlist-row--in-order" : "",
  ].filter(Boolean).join(" ");

  // Бейдж «уже в открытом заказе» — оператор не должен создавать дубль PO.
  // Кнопка-чекбокс заменяется на «Архивировать» (вызывает обычный DELETE
  // /api/wishlist/:id с reason=already_in_customerorder).
  const inOrderBadge = inOpenOrder
    ? `<span class="wishlist-trigger-in-order" title="Этот зритель уже имеет открытый customerorder с этим товаром (${escapeHtml(entry.alreadyInOrder?.orderName || entry.alreadyInOrder?.orderId || "?")}). Создавать PO не нужно.">✔ в заказе</span>`
    : "";

  const checkboxCell = inOpenOrder
    ? `<button class="wishlist-row-archive" data-archive="${entry.id}" title="Архивировать: товар уже в открытом customerorder">📥</button>`
    : `<input type="checkbox" data-entry-toggle="${entry.id}" ${entry.selected && !missingProduct ? "checked" : ""} ${missingProduct ? "disabled title='Невозможно отправить: товар не найден в МойСклад'" : ""} />`;

  return `
    <tr class="${rowClasses}">
      <td>${checkboxCell}</td>
      <td class="mono">${escapeHtml(entry.productCode)}</td>
      <td>${productCell} ${failedBadge} ${inOrderBadge} ${supplierCell}</td>
      <td>
        <input type="number" class="wishlist-inline-input" min="1" max="999"
               data-inline-edit="${entry.id}" data-field="quantity" value="${entry.quantity}" />
      </td>
      <td>
        <input type="number" class="wishlist-inline-input" min="0" step="0.01"
               data-inline-edit="${entry.id}" data-field="buyPrice"
               value="${entry.buyPrice != null ? (entry.buyPrice / 100) : ""}"
               placeholder="—"
               title="В рублях. На сервер уходит ×100 как копейки." />
      </td>
      <td><span class="wishlist-viewers" title="${escapeHtml((entry.seenEvents || []).map((s) => s.ts).join("\n"))}">${escapeHtml(viewers)}</span></td>
      <td class="mono dim">${ageStr}</td>
      <td><button class="wishlist-row-remove" data-remove="${entry.id}" title="Удалить из wish list">×</button></td>
    </tr>
  `;
}

function renderGroupTotals() {
  document.querySelectorAll(".wishlist-group").forEach((groupEl, gIdx) => {
    const g = wishlistState.groups[gIdx];
    if (!g) return;
    const sum = g.entries
      .filter((e) => e.selected)
      .reduce((acc, e) => acc + (Number(e.buyPrice || 0) * Number(e.quantity || 0)), 0);
    const selCount = g.entries.filter((e) => e.selected).length;
    const stats = groupEl.querySelector(".wishlist-group-stats");
    if (stats) stats.textContent = `${selCount}/${g.entries.length} · ${formatKopecks(sum)}`;
    const groupToggle = groupEl.querySelector("[data-group-toggle]");
    if (groupToggle) {
      groupToggle.checked = selCount > 0 && selCount === g.entries.length;
      groupToggle.indeterminate = selCount > 0 && selCount < g.entries.length;
    }
  });
  updateSubmitButtonState();
}

function updateSubmitButtonState() {
  let total = 0;
  let supplierGroups = 0;
  let sumAmount = 0;
  let missing = 0;
  for (const g of wishlistState.groups) {
    for (const e of g.entries) if (!e.productId) missing += 1;
    const selected = g.entries.filter((e) => e.selected);
    if (selected.length === 0) continue;
    total += selected.length;
    if (g.supplierId) supplierGroups += 1;
    sumAmount += selected.reduce((acc, e) => acc + Number(e.buyPrice || 0) * Number(e.quantity || 0), 0);
  }
  elements.wishlistSubmit.disabled = total === 0;
  const missingNote = missing > 0 ? ` · ⚠ ${missing} без productId (не отправляемы)` : "";
  elements.wishlistSummary.textContent = total === 0
    ? `Выберите позиции${missingNote}`
    : `Выбрано: ${total} позиций · ${supplierGroups} заказов поставщикам · ${formatKopecks(sumAmount)}${missingNote}`;
}

function findEntry(entryId) {
  for (const g of wishlistState.groups) {
    const e = g.entries.find((x) => x.id === entryId);
    if (e) return e;
  }
  return null;
}

function regroupAndRender() {
  const flat = wishlistState.groups.flatMap((g) => g.entries);
  const byKey = new Map();
  for (const e of flat) {
    const key = e.supplierId || "__no_supplier__";
    if (!byKey.has(key)) byKey.set(key, {
      supplierId: e.supplierId || null,
      supplierName: e.supplierName || (e.supplierId ? "" : "Без поставщика"),
      entries: [],
    });
    byKey.get(key).entries.push(e);
  }
  wishlistState.groups = [...byKey.values()];
  renderWishlistActive();
}

function schedulePatchEntry(entryId, inputEl, changes) {
  const prev = wishlistState.saveTimers.get(entryId);
  if (prev) clearTimeout(prev);
  const t = setTimeout(async () => {
    try {
      // changes уже в правильных единицах (buyPrice — копейки, quantity — целое).
      const res = await fetch(`/api/wishlist/${entryId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(changes),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      if (inputEl) {
        inputEl.classList.remove("is-dirty");
        inputEl.removeAttribute("title");
      }
      setWishlistStatus("", null);
    } catch (error) {
      if (inputEl) {
        inputEl.classList.add("is-dirty");
        inputEl.title = `Не сохранено: ${error.message}. Изменения только локально.`;
      }
      setWishlistStatus(`Не удалось сохранить изменение: ${error.message}. Попробуйте ещё раз.`, "error");
    }
  }, 600);
  wishlistState.saveTimers.set(entryId, t);
}

function persistDraftDebounced() {
  if (!wishlistState.draftId) return;
  try {
    const payload = {
      draftId: wishlistState.draftId,
      savedAt: new Date().toISOString(),
      groups: wishlistState.groups,
    };
    localStorage.setItem(WISHLIST_DRAFT_KEY_PREFIX + wishlistState.draftId, JSON.stringify(payload));
  } catch { /* ignore quota */ }
}

function loadStoredDraft() {
  try {
    // Берём самый свежий
    let best = null;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(WISHLIST_DRAFT_KEY_PREFIX)) continue;
      const raw = JSON.parse(localStorage.getItem(key) || "null");
      if (raw && (!best || raw.savedAt > best.savedAt)) best = raw;
    }
    return best;
  } catch { return null; }
}

function loadCompatibleStoredDraft(serverGroups) {
  const stored = loadStoredDraft();
  if (!stored) return null;
  const serverIds = new Set(serverGroups.flatMap((g) => g.entries.map((e) => e.id)));
  const storedIds = stored.groups?.flatMap((g) => g.entries.map((e) => e.id)) || [];
  // Совместимым считаем, если хотя бы половина entry ID совпадает.
  const overlap = storedIds.filter((id) => serverIds.has(id)).length;
  if (overlap === 0) return null;
  return stored;
}

function applyStoredDraft(stored) {
  // Накладываем quantity / buyPrice / selected из storage на серверные группы.
  const map = new Map();
  for (const g of stored.groups || []) {
    for (const e of g.entries || []) map.set(e.id, e);
  }
  for (const g of wishlistState.groups) {
    for (const e of g.entries) {
      const saved = map.get(e.id);
      if (saved) {
        if ("quantity" in saved) e.quantity = saved.quantity;
        if ("buyPrice" in saved) e.buyPrice = saved.buyPrice;
        if ("selected" in saved) e.selected = saved.selected;
      }
    }
  }
}

function clearStoredDraft() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith(WISHLIST_DRAFT_KEY_PREFIX)) localStorage.removeItem(key);
    }
  } catch { /* ignore */ }
}

async function loadWishlistArchive() {
  try {
    const res = await fetch("/api/wishlist/archive");
    const data = await res.json();
    wishlistState.archiveCache = data.entries || [];
    renderWishlistArchive();
  } catch (error) {
    elements.wishlistArchiveBody.innerHTML = `<div class="wishlist-empty">Ошибка: ${escapeHtml(error.message)}</div>`;
  }
}

function renderWishlistArchive() {
  const filter = (elements.wishlistArchiveFilter.value || "").toLowerCase().trim();
  const rows = wishlistState.archiveCache.filter((e) => {
    if (!filter) return true;
    return [e.productCode, e.viewerName, e.productName, e.createdAt].some((v) => String(v || "").toLowerCase().includes(filter));
  });
  if (rows.length === 0) {
    elements.wishlistArchiveBody.innerHTML = `<div class="wishlist-empty">Архив пуст.</div>`;
    return;
  }
  elements.wishlistArchiveBody.innerHTML = rows.map((e) => {
    const status = e.status === "consumed" ? "→ ПЗ" : "✕ удалена";
    const detail = e.consumed
      ? `<a href="https://online.moysklad.ru/app/#purchaseorder/edit?id=${e.consumed.purchaseOrderId}" target="_blank" rel="noreferrer">${escapeHtml(e.consumed.purchaseOrderName || "PO")}</a>`
      : escapeHtml(e.removedReason || "");
    return `
      <div class="wishlist-archive-row">
        <span class="mono">${escapeHtml(e.productCode || "")}</span>
        <span>${escapeHtml(e.productName || "—")} · ${escapeHtml(e.viewerName || "—")}</span>
        <span class="a-status">${status}</span>
        <span>${detail}</span>
      </div>
    `;
  }).join("");
}

async function loadWishlistSettings() {
  // ВАЖНО: настройки грузим первым обязательным шагом. Suppliers/stores —
  // необязательны: если МойСклад временно недоступен, оператор всё равно должен
  // видеть и сохранять свои настройки. Раньше Promise.all блокировал всё.
  try {
    const res = await fetch("/api/settings");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    wishlistState.settings = await res.json();
  } catch (error) {
    setWishlistSettingsStatus(`Не удалось загрузить настройки: ${error.message}`, "error");
    return;
  }

  // Списки из МС — best-effort. Каждый сам по себе.
  try {
    const r = await fetch("/api/moysklad/suppliers");
    if (r.ok) wishlistState.suppliers = (await r.json()).rows || [];
  } catch { /* leave previous list */ }
  try {
    const r = await fetch("/api/moysklad/stores");
    if (r.ok) wishlistState.stores = (await r.json()).rows || [];
  } catch { /* leave previous list */ }

  const w = wishlistState.settings.wishlist || {};
  const stores = wishlistState.stores;
  const suppliers = wishlistState.suppliers;

  // Если список не загрузился, но в settings уже есть сохранённый id — показываем его
  // как placeholder-option с пометкой «(сохранено, список недоступен)», чтобы оператор
  // видел: значение есть, не стёрто. На save мы это поле просто не отправим (см. ниже),
  // и settings-store.patch сохранит существующее.
  const storeMissing = stores.length === 0;
  const supplierMissing = suppliers.length === 0;

  const storeOptions = stores.map((s) =>
    `<option value="${escapeHtml(s.id)}" ${s.id === w.defaultStoreId ? "selected" : ""}>${escapeHtml(s.name)}</option>`
  ).join("");
  const storeSavedPlaceholder = (storeMissing && w.defaultStoreId)
    ? `<option value="${escapeHtml(w.defaultStoreId)}" selected>${escapeHtml(w.defaultStoreId)} (сохранено, список МС недоступен)</option>`
    : "";
  elements.wishlistSettingsStore.innerHTML = `<option value="">— не задан —</option>` + storeSavedPlaceholder + storeOptions;

  const supplierOptions = suppliers.map((s) =>
    `<option value="${escapeHtml(s.id)}" ${s.id === w.defaultSupplierId ? "selected" : ""}>${escapeHtml(s.name)}</option>`
  ).join("");
  const supplierSavedPlaceholder = (supplierMissing && w.defaultSupplierId)
    ? `<option value="${escapeHtml(w.defaultSupplierId)}" selected>${escapeHtml(w.defaultSupplierId)} (сохранено, список МС недоступен)</option>`
    : "";
  elements.wishlistSettingsSupplier.innerHTML = `<option value="">— не задан —</option>` + supplierSavedPlaceholder + supplierOptions;

  elements.wishlistSettingsOldDays.value = w.oldDaysThreshold ?? 7;
  elements.wishlistSettingsNotifyVk.checked = Boolean(w.notifyVkOnAdd);
  elements.wishlistSettingsTemplate.value = w.descriptionTemplate || "";

  // Запоминаем флаги для saveWishlistSettings — он пропустит поля, чьи списки не
  // загрузились, чтобы случайный «— не задан —» не стёр сохранённое значение.
  wishlistState.storeListLoaded = !storeMissing;
  wishlistState.supplierListLoaded = !supplierMissing;

  if (storeMissing || supplierMissing) {
    setWishlistSettingsStatus("Списки МС недоступны — текущие сохранённые id отмечены как placeholder и не будут стёрты при сохранении.", "error");
  }
}

function setWishlistSettingsStatus(text, level) {
  const el = elements.wishlistSettingsStatus;
  el.textContent = text || "";
  el.className = "wishlist-settings-status" + (level ? ` ${level}` : "");
}

async function saveWishlistSettings() {
  // ВАЖНО: defaultStoreId / defaultSupplierId отправляем ТОЛЬКО если соответствующий
  // список из МС реально загрузился. Иначе мы рискуем стереть сохранённое значение,
  // потому что select с одним placeholder-option отдаст value === "" или сам saved id.
  // settings-store.patch использует deep merge — отсутствующее поле сохраняется как есть.
  const wishlist = {
    oldDaysThreshold: Number(elements.wishlistSettingsOldDays.value) || 7,
    notifyVkOnAdd: elements.wishlistSettingsNotifyVk.checked,
    descriptionTemplate: elements.wishlistSettingsTemplate.value || "",
  };
  if (wishlistState.storeListLoaded) {
    wishlist.defaultStoreId = elements.wishlistSettingsStore.value || "";
  }
  if (wishlistState.supplierListLoaded) {
    wishlist.defaultSupplierId = elements.wishlistSettingsSupplier.value || "";
  }
  const patch = { wishlist };
  setWishlistSettingsStatus("Сохраняю…", null);
  try {
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Записываем ответ обратно — иначе submit использует устаревший
    // wishlistState.settings (например, пустой defaultStoreId), хотя оператор
    // только что выбрал склад. Сервер вернул мerged-объект как single source of truth.
    const updated = await res.json();
    wishlistState.settings = updated;
    setWishlistSettingsStatus("Сохранено", "ok");
  } catch (error) {
    setWishlistSettingsStatus(`Ошибка: ${error.message}`, "error");
  }
}

async function submitWishlist() {
  if (!wishlistState.draftId) return;
  // Fallback из настроек — если у группы supplier не выставлен (включая «Без
  // поставщика»), но в Настройках указан defaultSupplierId, используем его.
  // Аналогично для склада. Без этого записи без supplier ловили 400, хотя
  // оператор явно настроил дефолтного поставщика именно для такого случая.
  const fallbackSupplierId = wishlistState.settings?.wishlist?.defaultSupplierId || "";
  const fallbackStoreId = wishlistState.settings?.wishlist?.defaultStoreId || "";

  const groups = wishlistState.groups
    .map((g) => {
      // Защита: missing-product и «уже в открытом заказе» не должны попасть
      // в payload, даже если оказались selected через регресс в group-toggle.
      const selected = g.entries.filter((e) =>
        e.selected && e.productId && !e.alreadyInOrder?.inOpenOrder
      );
      if (selected.length === 0) return null;
      // Слипаем позиции по productId (одна строка PO на товар).
      const byProduct = new Map();
      for (const e of selected) {
        const key = e.productId;
        if (!byProduct.has(key)) byProduct.set(key, {
          productId: e.productId,
          productCode: e.productCode,
          quantity: 0, price: e.buyPrice || 0,
          entryIds: [],
        });
        const row = byProduct.get(key);
        row.quantity += Number(e.quantity || 1);
        row.entryIds.push(e.id);
      }
      return {
        supplierId: g.supplierId || fallbackSupplierId || "",
        storeId: fallbackStoreId,
        description: wishlistState.settings?.wishlist?.descriptionTemplate || "",
        positions: [...byProduct.values()],
      };
    })
    .filter(Boolean);

  // Подсказка в подтверждении: какие группы используют fallback-поставщика.
  const fallbackUsed = wishlistState.groups
    .filter((g) => !g.supplierId && g.entries.some((e) => e.selected && e.productId))
    .length;
  if (fallbackUsed > 0 && !fallbackSupplierId) {
    setWishlistStatus(`Группы без поставщика (${fallbackUsed}): задайте supplier в строке или укажите дефолтного поставщика в Настройках.`, "error");
    return;
  }

  if (groups.length === 0) return;

  // Show confirm modal.
  const totalPositions = groups.reduce((a, g) => a + g.positions.reduce((b, p) => b + p.quantity, 0), 0);
  const totalAmount = groups.reduce((a, g) => a + g.positions.reduce((b, p) => b + p.quantity * (p.price || 0), 0), 0);
  const fallbackSupplierName = wishlistState.suppliers.find((s) => s.id === fallbackSupplierId)?.name
    || (fallbackSupplierId ? fallbackSupplierId : "");
  const fallbackNote = (fallbackUsed > 0 && fallbackSupplierId)
    ? ` ${fallbackUsed} ${fallbackUsed === 1 ? "группа без поставщика унаследует" : "групп без поставщика унаследуют"} «${fallbackSupplierName}» из Настроек.`
    : "";
  elements.wishlistConfirmText.textContent =
    `Создать ${groups.length} ${groups.length === 1 ? "заказ поставщику" : "заказов поставщикам"} на ${totalPositions} позиций, сумма ${formatKopecks(totalAmount)}?${fallbackNote}`;
  elements.wishlistConfirmModal.hidden = false;

  elements.wishlistConfirmCancel.onclick = () => { elements.wishlistConfirmModal.hidden = true; };
  elements.wishlistConfirmOk.onclick = async () => {
    elements.wishlistConfirmModal.hidden = true;
    await sendWishlistPurchaseOrder(groups);
  };
}

async function sendWishlistPurchaseOrder(groups) {
  if (wishlistState.pendingSubmit) return;
  wishlistState.pendingSubmit = true;
  elements.wishlistSubmit.disabled = true;
  setWishlistStatus("Отправляю в МойСклад…", null);
  try {
    const res = await fetch("/api/wishlist/purchase-order", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draftId: wishlistState.draftId, groups }),
    });
    const data = await res.json();
    if (res.status === 400 && data.error === "missing_supplier_or_store") {
      setWishlistStatus(`Не задан поставщик/склад для групп: ${data.groupIndices.join(", ")}.`, "error");
      return;
    }
    if (res.status === 409 && data.error === "safe_mode_enabled") {
      setWishlistStatus("Safe mode включён — отправка PO заблокирована. Выключите safe mode и повторите.", "error");
      return;
    }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    const created = data.purchaseOrders || [];
    const failed = data.failedGroups || [];
    const blocked = data.blockedGroupHashes || [];
    let msg = `Создано: ${created.length}.`;
    if (failed.length) msg += ` Не удалось: ${failed.length}.`;
    if (blocked.length) msg += ` Блокировано safe mode: ${blocked.length}.`;
    if (created.length > 0) {
      msg += " " + created.map((po) => `🔗 ${po.name || po.id}`).join(", ");
    }
    setWishlistStatus(msg, data.status === "complete" ? "ok" : "error");

    clearStoredDraft();
    await loadWishlistActive();
    await fetchWishlistCount();
  } catch (error) {
    setWishlistStatus(`Ошибка: ${error.message}`, "error");
  } finally {
    wishlistState.pendingSubmit = false;
    updateSubmitButtonState();
  }
}

async function checkWishlistOrders() {
  const entryIds = wishlistState.groups.flatMap((g) => g.entries.map((e) => e.id));
  if (entryIds.length === 0) return;
  setWishlistStatus("Проверяю пересечения с заказами клиентов…", null);
  try {
    const res = await fetch("/api/wishlist/check-customerorders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryIds }),
    });
    const data = await res.json();
    // Применяем результат на каждую entry: { inOpenOrder, orderId?, orderName? }.
    // Эти строки рендер пометит бейджем «✔ в открытом заказе» и заменит чекбокс
    // на кнопку «Архивировать», чтобы оператор не создавал дубль PO.
    let hits = 0;
    for (const g of wishlistState.groups) {
      for (const e of g.entries) {
        const probe = data[e.id];
        if (probe && probe.inOpenOrder) {
          e.alreadyInOrder = probe;
          e.selected = false; // не позволяем включить в submit
          hits += 1;
        } else {
          e.alreadyInOrder = null;
        }
      }
    }
    renderWishlistActive();
    setWishlistStatus(
      hits === 0
        ? "Пересечений с открытыми заказами нет."
        : `Найдено пересечений: ${hits}. Эти строки помечены и исключены из отправки.`,
      hits ? "ok" : null,
    );
  } catch (error) {
    setWishlistStatus(`Ошибка проверки: ${error.message}`, "error");
  }
}

async function addManualEntry() {
  const productCode = elements.wishlistManualCode.value.trim();
  const viewerName = elements.wishlistManualName.value.trim() || "Ручная позиция";
  const quantity = Math.max(1, Number(elements.wishlistManualQty.value) || 1);
  if (!productCode) {
    setWishlistStatus("Введите артикул.", "error");
    return;
  }
  try {
    const res = await fetch("/api/wishlist/entries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ productCode, viewerName, quantity }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    elements.wishlistManualCode.value = "";
    elements.wishlistManualName.value = "";
    elements.wishlistManualQty.value = "1";
    elements.wishlistManualForm.hidden = true;
    await loadWishlistActive();
    setWishlistStatus("Позиция добавлена.", "ok");
  } catch (error) {
    setWishlistStatus(`Не удалось добавить: ${error.message}`, "error");
  }
}

function formatKopecks(kopecks) {
  const rubles = Number(kopecks || 0) / 100;
  return `${rubles.toFixed(2)} ₽`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Tab buttons
document.querySelectorAll(".wishlist-tab").forEach((btn) => {
  btn.addEventListener("click", () => switchWishlistTab(btn.dataset.tab));
});

// Modal bindings
elements.wishlistButton.addEventListener("click", openWishlistModal);
elements.wishlistClose.addEventListener("click", closeWishlistModal);
elements.wishlistCancel.addEventListener("click", closeWishlistModal);
elements.wishlistModal.addEventListener("click", (event) => {
  if (event.target === elements.wishlistModal) closeWishlistModal();
});

// Manual add
elements.wishlistManualAdd.addEventListener("click", () => {
  elements.wishlistManualForm.hidden = false;
  elements.wishlistManualCode.focus();
});
elements.wishlistManualCancel.addEventListener("click", () => {
  elements.wishlistManualForm.hidden = true;
});
elements.wishlistManualConfirm.addEventListener("click", addManualEntry);

// Check intersections
elements.wishlistCheckOrders.addEventListener("click", checkWishlistOrders);

// Settings save
elements.wishlistSettingsSave.addEventListener("click", saveWishlistSettings);

// Archive filter
elements.wishlistArchiveFilter.addEventListener("input", () => renderWishlistArchive());

// Submit
elements.wishlistSubmit.addEventListener("click", submitWishlist);

// Initial badge fetch on page load
void fetchProjectVersion();
void fetchWishlistCount();
// Preload suppliers/stores (used by manual supplier picker in "Без поставщика" группе).
void loadWishlistSettings();

// ===== Keyboard shortcuts =====
// Space — start/stop the broadcast (only when no modal is open and focus is
// not inside an input/textarea/contenteditable element, so typing in the
// VK URL or wishlist forms does not toggle the stream).
// Esc — close the topmost open modal.
function isEditableTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

function openModals() {
  return [
    elements.digestModal,
    elements.wishlistModal,
    elements.sendLogsModal,
    elements.wishlistConfirmModal,
  ].filter((m) => m && !m.hidden);
}

document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented) return;

  if (event.key === "Escape") {
    const top = openModals().pop();
    if (top) {
      event.preventDefault();
      // Each modal stores its dismiss handler on the close button; clicking
      // it preserves cancel semantics (e.g. wishlistConfirm cancel does not
      // submit the order).
      const closeBtn = top.querySelector("[id$='Close'], [id$='Cancel']");
      if (closeBtn) closeBtn.click();
      else top.hidden = true;
    }
    return;
  }

  if ((event.key === " " || event.code === "Space") && !isEditableTarget(event.target)) {
    if (openModals().length > 0) return;
    event.preventDefault();
    if (state.lifecycle === "idle") {
      void startStreaming();
    } else if (state.lifecycle === "streaming") {
      void stopStreaming();
    }
  }
});
