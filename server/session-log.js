import { appendFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createSessionJsonl } from "./session-jsonl.js";

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
  let jsonl = null;
  let writeChain = Promise.resolve();

  function append(text) {
    if (!filePath) {
      return;
    }
    const targetFilePath = filePath;

    writeChain = writeChain
      .then(async () => {
        await appendFile(targetFilePath, text + "\n", "utf8");
      })
      .catch((err) => {
        console.error(`session_log_write_failed ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  function jsonlEvent(kind, payload) {
    if (jsonl) jsonl.writeEvent(kind, payload);
  }

  return {
    getFilePath() {
      return filePath;
    },
    getJsonl() {
      return jsonl;
    },
    logSessionStart({ connectionId, vkLiveVideoUrl, context } = {}) {
      const slug = dateSlug();
      filePath = join(sessionsDir, `${slug}.md`);
      jsonl = createSessionJsonl({ filePath: join(sessionsDir, `${slug}.jsonl`) });
      const targetFilePath = filePath;

      // Контекстный блок: версия, env-флаги (только имена/значения, без секретов),
      // настройки оператора. Помогает разобрать сессию пост-фактум без доступа к коду.
      const contextLines = [];
      if (context) {
        contextLines.push(`## Контекст сессии`);
        contextLines.push(``);
        if (context.version) contextLines.push(`- **Версия:** ${context.version}  `);
        if (context.safeMode !== undefined) contextLines.push(`- **Safe mode:** ${context.safeMode ? "on" : "off"}  `);
        if (context.productCache) {
          contextLines.push(`- **Каталог товаров:** ${context.productCache.count} кодов`
            + (context.productCache.loadedAt ? `, обновлён ${context.productCache.loadedAt}` : "")
            + `  `);
        }
        if (context.featureFlags) {
          const flags = Object.entries(context.featureFlags)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ");
          if (flags) contextLines.push(`- **Флаги:** ${flags}  `);
        }
        contextLines.push(``);
      }

      const lines = [
        `# Сессия трансляции`,
        ``,
        `**Начало:** ${nowDateTime()}  `,
        vkLiveVideoUrl ? `**VK видео:** ${vkLiveVideoUrl}  ` : null,
        `**Соединение:** \`${connectionId}\`  `,
        ``,
        ...contextLines,
        `---`,
        ``,
      ].filter((l) => l !== null).join("\n");

      writeChain = writeChain
        .then(async () => {
          await mkdir(sessionsDir, { recursive: true });
          await writeFile(targetFilePath, lines, "utf8");
        })
        .catch((err) => {
          console.error(`session_log_start_failed ${err instanceof Error ? err.message : String(err)}`);
        });

      jsonlEvent("session_started", {
        connectionId: connectionId || null,
        vkLiveVideoUrl: vkLiveVideoUrl || null,
        context: context || null,
      });
    },

    logLotOpened({ code, lotSessionId, productName, salePrice, voicePrice, availableStock, transcript, source } = {}) {
      const effectivePrice = salePrice != null && salePrice > 0 ? salePrice : voicePrice;
      const priceStr = effectivePrice != null ? ` — ${effectivePrice} ₽` : "";
      const stockStr = availableStock != null ? `, остаток: ${availableStock} шт.` : "";
      const sourceLabel = source === "voice" ? "голос" : source === "manual" ? "ручной" : (source || "—");

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

      jsonlEvent("lot_opened", { code, lotSessionId, productName, salePrice, voicePrice, availableStock, source });
    },

    logReservation({ viewerName, viewerId, lotCode } = {}) {
      append(`- ${nowTime()} **Бронь** от ${viewerName || `id${viewerId}`} (лот ${lotCode})`);
      jsonlEvent("reservation_accepted", { viewerName, viewerId, lotCode });
    },

    logReservationWaitlist({ viewerName, viewerId, lotCode, position } = {}) {
      const positionStr = position ? ` №${position}` : "";
      append(`- ${nowTime()} **В очереди${positionStr}** ${viewerName || `id${viewerId}`} (лот ${lotCode}) — ждёт исхода предыдущей брони`);
      jsonlEvent("reservation_waitlist_pending", { viewerName, viewerId, lotCode, position });
    },

    logReservationOutOfStock({ viewerName, viewerId, lotCode } = {}) {
      append(`- ${nowTime()} **Товар закончился** для ${viewerName || `id${viewerId}`} (лот ${lotCode}) — бронь отклонена`);
      jsonlEvent("reservation_out_of_stock", { viewerName, viewerId, lotCode });
    },

    logWaitlistPromoted({ viewerName, viewerId, lotCode, previousPrimaryStatus } = {}) {
      append(`- ${nowTime()} **Очередь продвинулась** → ${viewerName || `id${viewerId}`} стал первым на лот ${lotCode} (предыдущая бронь: ${previousPrimaryStatus || "—"})`);
      jsonlEvent("waitlist_promoted", { viewerName, viewerId, lotCode, previousPrimaryStatus });
    },

    logOrphanWaitlist({ lotCode, lotSessionId, reason, entries } = {}) {
      if (!Array.isArray(entries) || entries.length === 0) {
        return;
      }
      const list = entries
        .map((entry, index) => {
          const label = entry.viewerName || `id${entry.viewerId}`;
          const commentId = entry.commentId ? ` (comment ${entry.commentId})` : "";
          return `  ${index + 1}. ${label}${commentId}`;
        })
        .join("\n");
      append([
        ``,
        `> **⚠ Брошенная очередь** на лоте ${lotCode || lotSessionId || "—"} (${reason || "?"}):`,
        `>`,
        `> Ниже перечислены зрители, чьи брони не успели обработаться. Обработайте их вручную в МойСкладе или ответьте им в VK.`,
        ``,
        list,
        ``,
      ].join("\n"));
      jsonlEvent("orphan_waitlist", {
        lotCode, lotSessionId, reason,
        entries: entries.map((e) => ({
          viewerId: e.viewerId, viewerName: e.viewerName, commentId: e.commentId, status: e.status,
        })),
      });
    },

    logWaitlistMigratedToWishlist({ lotCode, lotSessionId, reason, count } = {}) {
      append(`- ${nowTime()} **В лист предзаказов** перенесено ${count} зрителей с лота ${lotCode} (${reason || "?"})`);
      jsonlEvent("waitlist_migrated_to_wishlist", { lotCode, lotSessionId, reason, count });
    },

    logOrderCreated({ viewerName, viewerId, orderId, lotCode, appended } = {}) {
      const action = appended ? "добавлен в заказ" : "создан заказ";
      append(`- ${nowTime()} **Заказ ${action}** для ${viewerName || `id${viewerId}`} (лот ${lotCode}, заказ \`${orderId || "—"}\`)`);
      jsonlEvent("customer_order_created", { viewerName, viewerId, orderId, lotCode, appended });
    },

    logOrderCancelled({ viewerName, viewerId, orderId, lotCode } = {}) {
      append(`- ${nowTime()} **Бронь отменена** оператором для ${viewerName || `id${viewerId}`} (лот ${lotCode}, заказ \`${orderId || "—"}\`)`);
      jsonlEvent("customer_order_cancelled", { viewerName, viewerId, orderId, lotCode });
    },

    logDiscount({ amount, originalPrice, newPrice, code, lotSessionId, descriptor, transcript } = {}) {
      append(`- ${nowTime()} **Скидка** −${amount} ₽ на лот ${code}: ${originalPrice} ₽ → ${newPrice} ₽`);
      jsonlEvent("discount_applied", { amount, originalPrice, newPrice, code, lotSessionId, descriptor, transcript });
    },

    logDiscountSkipped({ text, reason, code, lotSessionId } = {}) {
      jsonlEvent("discount_skipped", { text, reason, code, lotSessionId });
    },

    logError({ component, message } = {}) {
      append(`- ${nowTime()} **Ошибка** [${component}] ${message}`);
      jsonlEvent("error", { component, message });
    },

    // Hot-path JSONL события для пост-фактум анализа эфира.
    // В .md не дублируем — markdown остаётся читабельным для оператора;
    // JSONL даёт мне (Claude) полный поток.
    logTranscriptFinal({ text, latencyMs, confidence } = {}) {
      jsonlEvent("transcript_final", { text, latencyMs, confidence: confidence ?? null });
    },

    logVkComment({ commentId, viewerId, viewerName, text, createdAt, lotCode } = {}) {
      jsonlEvent("vk_comment", { commentId, viewerId, viewerName, text, createdAt, lotCode });
    },

    logStateSnapshot(payload = {}) {
      // Снимок состояния для реконструкции «что было в момент X».
      // Раз в 30 секунд + на ключевых изменениях.
      jsonlEvent("state_snapshot", payload);
    },

    logSafemodeToggled({ enabled, source } = {}) {
      jsonlEvent("safemode_toggled", { enabled: Boolean(enabled), source: source || null });
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

      jsonlEvent("session_ended", { reason });

      filePath = null;
      // jsonl зануляем НЕ сразу — пусть последняя запись допишется. flush()
      // ниже подождёт writeChain.then().
    },

    // Дождаться завершения всех отложенных записей в .md и .jsonl. Должен
    // вызываться в терминальных путях (socket_close / stream_stop /...) ПЕРЕД
    // тем как оператор откроет ZIP — иначе session_ended может не успеть
    // оказаться на диске к моменту bundle.
    async flush() {
      try { await writeChain; } catch { /* logged */ }
      if (jsonl) {
        try { await jsonl.flush(); } catch { /* swallowed */ }
        jsonl = null;
      }
    },
  };
}
