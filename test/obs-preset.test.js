import { test } from "node:test";
import assert from "node:assert/strict";
import { runObsPreset, matchDevice } from "../server/obs-client.js";

// Пресет OBS: 1080p30, фиксированный битрейт, камера и микрофон айфона.
// Гоняем на фейковом OBS (request(type, data)) — без сокета и без OBS.

const PRESET = {
  videoWidth: 1920,
  videoHeight: 1080,
  videoFps: 30,
  videoBitrateKbps: 4500,
  sceneName: "V-Amber",
  cameraInputName: "iPhone — камера",
  micInputName: "iPhone — микрофон",
  cameraDeviceMatch: ["iphone", "айфон"],
  micDeviceMatch: ["iphone", "айфон"],
};

// Фейковый OBS: mac с подключённым айфоном, всё уже настроено правильно.
// Тесты мутируют state, чтобы получить нужное расхождение.
function makeObs(overrides = {}) {
  const state = {
    video: {
      baseWidth: 1920, baseHeight: 1080, outputWidth: 1920, outputHeight: 1080,
      fpsNumerator: 30, fpsDenominator: 1,
    },
    profile: { "Output/Mode": "Simple", "SimpleOutput/VBitrate": "4500" },
    scenes: ["V-Amber"],
    // Элементы сцен: имя сцены → список имён источников в ней.
    sceneItems: { "V-Amber": ["iPhone — камера", "iPhone — микрофон"] },
    inputKinds: ["av_capture_input_v2", "coreaudio_input_capture", "browser_source"],
    inputs: {
      "iPhone — камера": { kind: "av_capture_input_v2", settings: { device: "cam-uid-iphone" } },
      "iPhone — микрофон": { kind: "coreaudio_input_capture", settings: { device_id: "mic-uid-iphone" } },
    },
    devices: {
      device: [
        { itemName: "FaceTime HD Camera", itemEnabled: true, itemValue: "cam-uid-facetime" },
        { itemName: "iPhone Романа", itemEnabled: true, itemValue: "cam-uid-iphone" },
      ],
      device_id: [
        { itemName: "MacBook Pro Microphone", itemEnabled: true, itemValue: "mic-uid-macbook" },
        { itemName: "Микрофон iPhone", itemEnabled: true, itemValue: "mic-uid-iphone" },
      ],
    },
    ...overrides,
  };

  const calls = [];
  async function request(type, data = {}) {
    calls.push({ type, data });
    switch (type) {
      case "GetVideoSettings":
        return { ...state.video };
      case "SetVideoSettings":
        state.video = { ...data };
        return {};
      case "GetProfileParameter":
        return { parameterValue: state.profile[`${data.parameterCategory}/${data.parameterName}`] ?? null };
      case "SetProfileParameter":
        state.profile[`${data.parameterCategory}/${data.parameterName}`] = data.parameterValue;
        return {};
      case "GetSceneList":
        return { scenes: state.scenes.map((sceneName) => ({ sceneName })) };
      case "CreateScene":
        state.scenes.push(data.sceneName);
        state.sceneItems[data.sceneName] = [];
        return {};
      case "GetSceneItemList":
        return { sceneItems: (state.sceneItems[data.sceneName] || []).map((sourceName) => ({ sourceName })) };
      case "CreateSceneItem":
        state.sceneItems[data.sceneName].push(data.sourceName);
        return {};
      case "SetCurrentProgramScene":
        return {};
      case "GetInputKindList":
        return { inputKinds: state.inputKinds };
      case "GetInputList":
        return { inputs: Object.entries(state.inputs).map(([inputName, v]) => ({ inputName, inputKind: v.kind })) };
      case "CreateInput":
        state.inputs[data.inputName] = { kind: data.inputKind, settings: { ...data.inputSettings } };
        state.sceneItems[data.sceneName].push(data.inputName);
        return {};
      case "GetInputSettings":
        return { inputSettings: { ...state.inputs[data.inputName].settings } };
      case "SetInputSettings":
        Object.assign(state.inputs[data.inputName].settings, data.inputSettings);
        return {};
      case "GetInputPropertiesListPropertyItems":
        return { propertyItems: state.devices[data.propertyName] || [] };
      default:
        throw new Error(`unexpected request ${type}`);
    }
  }
  return { request, state, calls };
}

test("всё уже настроено — пресет ничего не трогает", async () => {
  const obs = makeObs();
  const report = await runObsPreset(obs.request, PRESET);
  assert.deepEqual(report, { changes: [], mismatches: [], warnings: [] });
  assert.equal(obs.calls.some((c) => c.type.startsWith("Set") || c.type.startsWith("Create")), false);
});

test("правит разрешение и fps до 1920x1080@30", async () => {
  const obs = makeObs({
    video: {
      baseWidth: 1280, baseHeight: 720, outputWidth: 1280, outputHeight: 720,
      fpsNumerator: 60, fpsDenominator: 1,
    },
  });
  const report = await runObsPreset(obs.request, PRESET);
  assert.deepEqual(obs.state.video, {
    baseWidth: 1920, baseHeight: 1080, outputWidth: 1920, outputHeight: 1080,
    fpsNumerator: 30, fpsDenominator: 1,
  });
  assert.match(report.changes.join(" "), /1920x1080 @ 30 fps/);
});

test("ставит битрейт 4500 и возвращает профиль в простой режим", async () => {
  const obs = makeObs({ profile: { "Output/Mode": "Advanced", "SimpleOutput/VBitrate": "2500" } });
  const report = await runObsPreset(obs.request, PRESET);
  assert.equal(obs.state.profile["Output/Mode"], "Simple");
  assert.equal(obs.state.profile["SimpleOutput/VBitrate"], "4500");
  assert.equal(report.changes.length, 2);
});

test("создаёт сцену и оба источника с устройствами айфона", async () => {
  const obs = makeObs({ scenes: [], inputs: {} });
  const report = await runObsPreset(obs.request, PRESET);
  assert.deepEqual(obs.state.scenes, ["V-Amber"]);
  assert.equal(obs.state.inputs["iPhone — камера"].kind, "av_capture_input_v2");
  assert.equal(obs.state.inputs["iPhone — камера"].settings.device, "cam-uid-iphone");
  assert.equal(obs.state.inputs["iPhone — микрофон"].settings.device_id, "mic-uid-iphone");
  assert.deepEqual(report.warnings, []);
});

test("переключает источник на айфон, если выбрана встроенная камера", async () => {
  const obs = makeObs();
  obs.state.inputs["iPhone — камера"].settings.device = "cam-uid-facetime";
  await runObsPreset(obs.request, PRESET);
  assert.equal(obs.state.inputs["iPhone — камера"].settings.device, "cam-uid-iphone");
});

test("источник есть, но не в нашей сцене — добавляем элемент, а не второй вход", async () => {
  // OBS удаляет вход только вместе с последним его элементом на всех сценах,
  // поэтому «вход существует» ещё не значит «источник в эфире».
  const obs = makeObs({ sceneItems: { "V-Amber": ["iPhone — микрофон"], "Другая сцена": ["iPhone — камера"] } });
  const report = await runObsPreset(obs.request, PRESET);
  assert.deepEqual(obs.state.sceneItems["V-Amber"], ["iPhone — микрофон", "iPhone — камера"]);
  assert.equal(Object.keys(obs.state.inputs).length, 2);
  assert.match(report.changes.join(" "), /добавлен в сцену/);
});

test("айфон не подключён — предупреждение, остальное применяется", async () => {
  const obs = makeObs({
    devices: { device: [{ itemName: "FaceTime HD Camera", itemEnabled: true, itemValue: "cam-uid-facetime" }], device_id: [] },
    video: {
      baseWidth: 1280, baseHeight: 720, outputWidth: 1280, outputHeight: 720,
      fpsNumerator: 30, fpsDenominator: 1,
    },
  });
  const report = await runObsPreset(obs.request, PRESET);
  assert.equal(report.warnings.length, 2);
  assert.match(report.warnings.join(" "), /устройство не найдено/);
  assert.equal(obs.state.video.outputWidth, 1920); // видео починили несмотря на источники
});

test("не-mac сборка OBS: источники пропускаются с предупреждением", async () => {
  const obs = makeObs({ inputKinds: ["dshow_input", "wasapi_input_capture"], inputs: {} });
  const report = await runObsPreset(obs.request, PRESET);
  assert.equal(report.warnings.length, 2);
  assert.equal(Object.keys(obs.state.inputs).length, 0);
});

test("apply=false только диагностирует, ничего не меняя", async () => {
  const obs = makeObs({
    scenes: [],
    inputs: {},
    profile: { "Output/Mode": "Simple", "SimpleOutput/VBitrate": "2500" },
    video: {
      baseWidth: 1280, baseHeight: 720, outputWidth: 1280, outputHeight: 720,
      fpsNumerator: 30, fpsDenominator: 1,
    },
  });
  const report = await runObsPreset(obs.request, PRESET, { apply: false });
  assert.equal(report.changes.length, 0);
  assert.equal(obs.calls.some((c) => c.type.startsWith("Set") || c.type.startsWith("Create")), false);
  assert.match(report.mismatches.join(" "), /1280x720/);
  assert.match(report.mismatches.join(" "), /битрейт 2500/);
  assert.match(report.mismatches.join(" "), /нет сцены/);
});

test("сбой одного шага не отменяет остальные", async () => {
  const obs = makeObs({
    video: {
      baseWidth: 1280, baseHeight: 720, outputWidth: 1280, outputHeight: 720,
      fpsNumerator: 30, fpsDenominator: 1,
    },
    profile: { "Output/Mode": "Simple", "SimpleOutput/VBitrate": "2500" },
  });
  const inner = obs.request;
  const request = async (type, data) => {
    if (type === "SetVideoSettings") throw new Error("output active");
    return inner(type, data);
  };
  const report = await runObsPreset(request, PRESET);
  assert.deepEqual(report.warnings, ["output active"]);
  assert.equal(obs.state.profile["SimpleOutput/VBitrate"], "4500");
});

test("matchDevice: приоритет по порядку паттернов, отключённые устройства пропускаются", () => {
  const items = [
    { itemName: "Айфон Романа", itemEnabled: true, itemValue: "ru" },
    { itemName: "iPhone Романа", itemEnabled: false, itemValue: "off" },
    { itemName: "iPhone SE", itemEnabled: true, itemValue: "en" },
  ];
  assert.deepEqual(matchDevice(items, ["iphone", "айфон"]), { value: "en", name: "iPhone SE" });
  assert.deepEqual(matchDevice(items, ["айфон"]), { value: "ru", name: "Айфон Романа" });
  assert.equal(matchDevice(items, ["ipad"]), null);
  assert.equal(matchDevice(undefined, ["iphone"]), null);
});
