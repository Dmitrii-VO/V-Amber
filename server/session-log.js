import { appendFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sessionsDir = join(__dirname, "..", "logs", "sessions");

function nowTime() {
  return new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function nowDateTime() {
  return new Date().toLocaleString("ru-RU");
}

function dateSlug() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
}

export function createSessionLog() {
  let filePath = null;
  let writeChain = Promise.resolve();

  function append(text) {
    if (!filePath) {
      return;
    }

    writeChain = writeChain
      .then(async () => {
        await appendFile(filePath, text + "\n", "utf8");
      })
      .catch((err) => {
        console.error(`session_log_write_failed ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  return {
    logSessionStart({ connectionId, vkLiveVideoUrl } = {}) {
      filePath = join(sessionsDir, `${dateSlug()}.md`);

      const lines = [
        `# Сессия трансляции`,
        ``,
        `**Начало:** ${nowDateTime()}  `,
        vkLiveVideoUrl ? `**VK видео:** ${vkLiveVideoUrl}  ` : null,
        `**Соединение:** \`${connectionId}\`  `,
        ``,
        `---`,
        ``,
      ].filter((l) => l !== null).join("\n");

      writeChain = writeChain
        .then(async () => {
          await mkdir(sessionsDir, { recursive: true });
          await writeFile(filePath, lines, "utf8");
        })
        .catch((err) => {
          console.error(`session_log_start_failed ${err instanceof Error ? err.message : String(err)}`);
        });
    },

    logLotOpened({ code, lotSessionId, productName, salePrice, availableStock, transcript, source } = {}) {
      const priceStr = salePrice != null ? ` — ${salePrice} ₽` : "";
      const stockStr = availableStock != null ? `, остаток: ${availableStock} шт.` : "";
      const sourceLabel = source === "voice" ? "голос" : source === "telegram_manual" ? "Telegram" : (source || "—");

      append([
        `## Лот: ${code}${priceStr}`,
        ``,
        `- **Время:** ${nowTime()}`,
        `- **Товар:** ${productName || "—"}${stockStr}`,
        `- **Источник:** ${sourceLabel}`,
        `- **Транскрипт:** _${transcript || "—"}_`,
        `- **ID лота:** \`${lotSessionId}\``,
        ``,
      ].join("\n"));
    },

    logReservation({ viewerName, viewerId, lotCode } = {}) {
      append(`- ${nowTime()} **Бронь** от ${viewerName || `id${viewerId}`} (лот ${lotCode})`);
    },

    logOrderCreated({ viewerName, viewerId, orderId, lotCode, appended } = {}) {
      const action = appended ? "добавлен в заказ" : "создан заказ";
      append(`- ${nowTime()} **Заказ ${action}** для ${viewerName || `id${viewerId}`} (лот ${lotCode}, заказ \`${orderId || "—"}\`)`);
    },

    logDiscount({ amount, originalPrice, newPrice, code } = {}) {
      append(`- ${nowTime()} **Скидка** −${amount} ₽ на лот ${code}: ${originalPrice} ₽ → ${newPrice} ₽`);
    },

    logError({ component, message } = {}) {
      append(`- ${nowTime()} **Ошибка** [${component}] ${message}`);
    },

    logSessionEnd({ reason } = {}) {
      if (!filePath) {
        return;
      }

      const labels = {
        stream_stop: "оператор нажал Стоп",
        stream_end: "поток завершён",
        stream_error: "ошибка потока",
        socket_close: "разрыв соединения",
      };

      append([
        ``,
        `---`,
        ``,
        `**Конец сессии:** ${nowDateTime()} (${labels[reason] || reason})`,
        ``,
      ].join("\n"));

      filePath = null;
    },
  };
}
