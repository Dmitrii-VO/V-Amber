import "dotenv/config";

function getRequiredEnv(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export const config = {
  port: Number(process.env.PORT || 8080),
  speechkit: {
    apiKey: getRequiredEnv("YANDEX_SPEECHKIT_API_KEY"),
    folderId: process.env.YANDEX_SPEECHKIT_FOLDER_ID?.trim() || "",
    sendFolderHeader: process.env.YANDEX_SPEECHKIT_SEND_FOLDER_HEADER === "1",
    lang: process.env.YANDEX_SPEECHKIT_LANG?.trim() || "ru-RU",
    model: process.env.YANDEX_SPEECHKIT_MODEL?.trim() || "general",
    sampleRate: 16000,
    endpoint: "stt.api.cloud.yandex.net:443",
  },
};
