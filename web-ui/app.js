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

function setSocketState(value) {
  elements.socketState.textContent = value;
  elements.socketDot.className = "dot";
  if (value === "connected") elements.socketDot.classList.add("dot--live");
  else if (value === "error") elements.socketDot.classList.add("dot--err");
}

function setLifecycle(next) {
  state.lifecycle = next;
  const isActive = next === "starting" || next === "streaming" || next === "stopping";

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

function renderActiveLot(lot) {
  if (!lot) {
    elements.lotCard.hidden = true;
    elements.lotEmpty.hidden = false;
    elements.lotArticle.textContent = "";
    clearChildren(elements.lotStockPill);
    renderReservations(null);
    return;
  }

  elements.lotCard.hidden = false;
  elements.lotEmpty.hidden = true;

  const product = lot.product || {};
  const code = lot.code || product.code || "—";
  elements.lotCode.textContent = code;
  elements.lotArticle.textContent = `· ${code}`;
  elements.lotName.textContent = product.name || "—";
  elements.lotArticleValue.textContent = product.code || code;
  elements.lotPrice.textContent = product.salePrice != null ? formatPrice(product.salePrice) : "—";

  const stock = product.availableStock;
  elements.lotStock.textContent = stock != null ? String(stock) : "—";
  elements.lotStock.classList.remove("green", "amber", "red");
  if (typeof stock === "number") {
    if (stock <= 0) elements.lotStock.classList.add("red");
    else if (stock <= 2) elements.lotStock.classList.add("amber");
    else elements.lotStock.classList.add("green");
  }

  clearChildren(elements.lotStockPill);
  if (typeof stock === "number") {
    const pill = document.createElement("span");
    pill.className = "pill";
    if (stock <= 0) pill.classList.add("pill--red");
    else if (stock <= 2) pill.classList.add("pill--amber");
    else pill.classList.add("pill--green");
    pill.textContent = stock <= 0 ? "нет в наличии" : `остаток ${stock}`;
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
    detail.textContent = ts ? new Date(ts).toLocaleTimeString() : (ev.status || "");
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
      logEvent("WebSocket connected", "ok");
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
        logEvent("WebSocket closed", "info");
        return;
      }
      logEvent("WebSocket closed unexpectedly", "warn");
      if (state.lifecycle !== "idle" || state.audioContext || state.mediaStream) {
        void cleanupStreamingResources();
      }
    });

    websocket.addEventListener("error", (event) => {
      setSocketState("error");
      reject(new Error(`WebSocket error: ${event.type}`));
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

  logEvent(`Неизвестное сообщение: ${JSON.stringify(payload)}`, "warn");
}

function formatLatency(value) {
  if (typeof value !== "number") return "—";
  return `${Math.round(value)} ms`;
}

async function startStreaming() {
  if (state.lifecycle !== "idle") return;

  const setupGeneration = state.setupGeneration + 1;
  state.setupGeneration = setupGeneration;
  setLifecycle("starting");

  try {
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
    logEvent("Стриминг запущен", "ok");
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
  logEvent("Стриминг остановлен", "info");
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
  elements.sendLogsSubmit.disabled = busy;
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
    const cooldownLabel = payload.cooldownMs > 0
      ? ` · повторно через ${Math.ceil(payload.cooldownMs / 1000)} с`
      : "";
    const telegramLabel = payload.telegramConfigured ? "Telegram настроен" : "Telegram не настроен — доступно только скачивание";
    elements.sendLogsMeta.textContent =
      `Всего: ${formatBytes(payload.totalBytes)} в исходном виде · ${telegramLabel}${cooldownLabel}`;
    elements.sendLogsSubmit.disabled = !payload.telegramConfigured || payload.cooldownMs > 0;
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

elements.sendLogsSubmit.addEventListener("click", async () => {
  const userNote = elements.sendLogsNote.value.trim();
  setSendLogsBusy(true);
  setSendLogsStatus("Отправляю в Telegram...", null);
  logEvent("Отправка логов разработчику...", "info");
  try {
    const response = await fetch("/api/send-logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userNote }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const reason = payload?.error || `HTTP ${response.status}`;
      const detail = payload?.retryAfterMs ? ` (повторите через ${Math.ceil(payload.retryAfterMs / 1000)} с)` : "";
      throw new Error(`${payload?.message || reason}${detail}`);
    }
    const totalKb = Math.max(1, Math.round((payload.totalBytes || 0) / 1024));
    const partsLabel = payload.parts?.length > 1 ? ` в ${payload.parts.length} частях` : "";
    setSendLogsStatus(`Отправлено${partsLabel} (${totalKb} КБ)`, "ok");
    logEvent(`Логи отправлены${partsLabel} (${totalKb} КБ)`, "success");
    setTimeout(closeSendLogsModal, 1500);
  } catch (error) {
    setSendLogsStatus(`Не удалось отправить: ${error.message}`, "error");
    handleError(error, "Не удалось отправить логи");
  } finally {
    setSendLogsBusy(false);
  }
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

elements.toggleAdvanced.addEventListener("click", () => {
  elements.vkLiveUrlInput.hidden = !elements.vkLiveUrlInput.hidden;
  if (!elements.vkLiveUrlInput.hidden) elements.vkLiveUrlInput.focus();
});

elements.refreshDevicesButton.addEventListener("click", loadInputDevices);
elements.startButton.addEventListener("click", startStreaming);
elements.stopButton.addEventListener("click", stopStreaming);
elements.microphoneSelect.addEventListener("change", (event) => {
  state.selectedDeviceId = event.target.value;
});
elements.vkLiveUrlInput.addEventListener("change", () => {
  localStorage.setItem("vkLiveVideoUrl", elements.vkLiveUrlInput.value.trim());
});

const savedVkUrl = localStorage.getItem("vkLiveVideoUrl");
if (savedVkUrl) {
  elements.vkLiveUrlInput.value = savedVkUrl;
  elements.vkLiveUrlInput.hidden = false;
}

elements.endpointLabel.textContent = elements.wsUrlInput.value;
setSessionPill("", "Idle");
renderSafeMode();
fetchSafeModeInitial();

navigator.mediaDevices.addEventListener("devicechange", loadInputDevices);
loadInputDevices();
