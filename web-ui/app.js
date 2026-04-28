const elements = {
  microphoneSelect: document.querySelector("#microphoneSelect"),
  wsUrlInput: document.querySelector("#wsUrlInput"),
  refreshDevicesButton: document.querySelector("#refreshDevicesButton"),
  startButton: document.querySelector("#startButton"),
  stopButton: document.querySelector("#stopButton"),
  sessionState: document.querySelector("#sessionState"),
  socketState: document.querySelector("#socketState"),
  activeLot: document.querySelector("#activeLot"),
  transcriptMeta: document.querySelector("#transcriptMeta"),
  transcriptOutput: document.querySelector("#transcriptOutput"),
  chunksSent: document.querySelector("#chunksSent"),
  bytesSent: document.querySelector("#bytesSent"),
  partialLatency: document.querySelector("#partialLatency"),
  finalLatency: document.querySelector("#finalLatency"),
  eventLog: document.querySelector("#eventLog"),
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
  finalTranscript: "",
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
    const inputs = devices.filter((device) => device.kind === "audioinput");

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
    logEvent(`Найдено микрофонов: ${inputs.length}`);
  } catch (error) {
    handleError(error, "Не удалось получить список микрофонов");
  }
}

function logEvent(message) {
  const item = document.createElement("li");
  item.textContent = `${new Date().toLocaleTimeString()} - ${message}`;
  elements.eventLog.prepend(item);

  while (elements.eventLog.children.length > 50) {
    elements.eventLog.lastChild.remove();
  }
}

function setSessionState(value) {
  elements.sessionState.textContent = value;
}

function setSocketState(value) {
  elements.socketState.textContent = value;
}

function setLifecycle(nextLifecycle) {
  state.lifecycle = nextLifecycle;
  const isActive = nextLifecycle === "starting" || nextLifecycle === "streaming" || nextLifecycle === "stopping";

  elements.startButton.disabled = isActive;
  elements.stopButton.disabled = nextLifecycle === "idle";
  elements.microphoneSelect.disabled = isActive;
  elements.wsUrlInput.disabled = isActive;
}

function updateMetrics() {
  elements.chunksSent.textContent = String(state.chunksSent);
  elements.bytesSent.textContent = String(state.bytesSent);
}

function updateTranscript(partialText) {
  const combined = [state.finalTranscript, partialText].filter(Boolean).join("\n");
  elements.transcriptOutput.textContent = combined || "Ожидание распознавания...";
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
  setSessionState("idle");
  setLifecycle("idle");
}

function downsampleToInt16(float32Array, inputRate, targetRate) {
  if (inputRate === targetRate) {
    return convertFloatToInt16(float32Array);
  }

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
    const websocket = new WebSocket(elements.wsUrlInput.value.trim());
    websocket.binaryType = "arraybuffer";

    websocket.addEventListener("open", () => {
      state.websocket = websocket;
      setSocketState("connected");
      logEvent("WebSocket connected");
      resolve(websocket);
    });

    websocket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        return;
      }

      try {
        const payload = JSON.parse(event.data);
        handleServerMessage(payload);
      } catch {
        logEvent(`Невалидное сообщение сервера: ${event.data}`);
      }
    });

    websocket.addEventListener("close", () => {
      setSocketState("disconnected");
      const expectedClose = state.pendingSocketClose === websocket;

      if (expectedClose) {
        state.pendingSocketClose = null;
      }

      if (state.websocket === websocket) {
        state.websocket = null;
      }

      if (expectedClose) {
        logEvent("WebSocket closed");
        return;
      }

      logEvent("WebSocket closed unexpectedly");

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
    elements.transcriptMeta.textContent = "partial";
    elements.partialLatency.textContent = formatLatency(payload.latencyMs);
    updateTranscript(payload.text || "");
    return;
  }

  if (payload.type === "final") {
    elements.transcriptMeta.textContent = "final";
    elements.finalLatency.textContent = formatLatency(payload.latencyMs);
    state.finalTranscript = [state.finalTranscript, payload.text || ""].filter(Boolean).join("\n");
    updateTranscript("");
    return;
  }

  if (payload.type === "state") {
    elements.activeLot.textContent = payload.activeLot || "-";
    return;
  }

  if (payload.type === "error") {
    logEvent(`SpeechKit bridge error: ${payload.message || "unknown"}`);
    return;
  }

  logEvent(`Неизвестное сообщение сервера: ${JSON.stringify(payload)}`);
}

function formatLatency(value) {
  if (typeof value !== "number") {
    return "-";
  }

  return `${Math.round(value)} ms`;
}

async function startStreaming() {
  if (state.lifecycle !== "idle") {
    return;
  }

  const setupGeneration = state.setupGeneration + 1;
  state.setupGeneration = setupGeneration;
  setLifecycle("starting");

  try {
    state.chunksSent = 0;
    state.bytesSent = 0;
    state.finalTranscript = "";
    updateMetrics();
    updateTranscript("");

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
      stream.getTracks().forEach((track) => track.stop());
      websocket.close();
      return;
    }

    const audioContext = new AudioContext();
    await audioContext.audioWorklet.addModule("./audio-processor.js");

    if (state.setupGeneration !== setupGeneration || state.lifecycle !== "starting") {
      await audioContext.close();
      stream.getTracks().forEach((track) => track.stop());
      websocket.close();
      return;
    }

    const sourceNode = audioContext.createMediaStreamSource(stream);
    const workletNode = new AudioWorkletNode(audioContext, "pcm-capture-processor");
    const monitorGain = audioContext.createGain();
    monitorGain.gain.value = 0;

    websocket.send(
      JSON.stringify({
        type: "start",
        sampleRate: TARGET_SAMPLE_RATE,
        encoding: "pcm_s16le",
        deviceId: state.selectedDeviceId || null,
        startedAt: new Date().toISOString(),
      }),
    );

    workletNode.port.onmessage = (event) => {
      if (
        state.lifecycle !== "streaming"
        || !state.websocket
        || state.websocket.readyState !== WebSocket.OPEN
      ) {
        return;
      }

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

    setSessionState("streaming");
    setLifecycle("streaming");
    logEvent("Стриминг запущен");
  } catch (error) {
    handleError(error, "Не удалось запустить стриминг");
    await stopStreaming();
  }
}

async function stopStreaming() {
  if (state.lifecycle === "idle") {
    return;
  }

  state.setupGeneration += 1;
  setLifecycle("stopping");

  if (state.websocket?.readyState === WebSocket.OPEN) {
    const socketToClose = state.websocket;
    state.pendingSocketClose = socketToClose;
    socketToClose.send(JSON.stringify({ type: "stop", stoppedAt: new Date().toISOString() }));
    window.setTimeout(() => {
      if (socketToClose.readyState === WebSocket.OPEN) {
        socketToClose.close();
      }
    }, 1500);
  }

  await cleanupStreamingResources();
  logEvent("Стриминг остановлен");
}

function handleError(error, prefix) {
  const details = error instanceof Error ? error.message : String(error);
  logEvent(`${prefix}: ${details}`);
  console.error(error);
}

elements.refreshDevicesButton.addEventListener("click", loadInputDevices);
elements.startButton.addEventListener("click", startStreaming);
elements.stopButton.addEventListener("click", stopStreaming);
elements.microphoneSelect.addEventListener("change", (event) => {
  state.selectedDeviceId = event.target.value;
});

navigator.mediaDevices.addEventListener("devicechange", loadInputDevices);

loadInputDevices();
