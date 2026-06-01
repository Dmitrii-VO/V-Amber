// Генератор INDEX.md и meta.json для диагностического ZIP.
//
// INDEX.md — entry point для пост-фактум анализа эфира. Когда оператор
// присылает ZIP, начинать чтение надо отсюда: видно сколько сессий, лотов,
// броней, ошибок МС, инциденты order_failed, переключения safe mode, и куда
// именно смотреть (timestamps в session jsonl).

const SUSPICIOUS_MOYSKLAD_DURATION_MS = 3000;

function parseJsonlSafe(content) {
  if (!content) return [];
  const lines = String(content).split(/\r?\n/);
  const records = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // skip invalid line
    }
  }
  return records;
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} с`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  if (minutes < 60) return `${minutes} мин ${seconds} с`;
  const hours = Math.floor(minutes / 60);
  return `${hours} ч ${minutes % 60} мин`;
}

function summarizeSession(records) {
  const summary = {
    startedAt: null,
    endedAt: null,
    durationMs: null,
    endReason: null,
    lotsOpened: 0,
    lotsClosed: 0,
    reservationsAccepted: 0,
    reservationDetected: 0,
    reservationFinalized: 0,
    reservationFinalizedAccepted: 0,
    waitlistPending: 0,
    outOfStock: 0,
    waitlistMigrated: 0,
    safeModeToggles: 0,
    moyskladCalls: 0,
    moyskladErrors: 0,
    moyskladSlowCalls: [],
    purchaseOrdersSubmitted: 0,
    purchaseOrdersOk: 0,
    purchaseOrdersFailed: 0,
    purchaseOrdersBlocked: 0,
    wishlistAdded: 0,
    incidents: [],
    errors: [],
    context: null,
  };

  for (const r of records) {
    const ts = r.ts;
    if (!summary.startedAt) summary.startedAt = ts;
    summary.endedAt = ts;
    switch (r.kind) {
      case "session_started":
        summary.context = r.context || null;
        break;
      case "session_ended":
        summary.endReason = r.reason || null;
        break;
      case "lot_opened":
        summary.lotsOpened += 1;
        break;
      case "lot_closed":
        summary.lotsClosed += 1;
        break;
      case "reservation_accepted":
        // Legacy name: this is an early comment detection in current runtime,
        // not proof that MoySklad accepted the reservation. Keep it only as
        // fallback for old bundles that predate reservation_finalized.
        summary.reservationDetected += 1;
        summary.reservationsAccepted += 1;
        break;
      case "reservation_detected":
        summary.reservationDetected += 1;
        break;
      case "reservation_finalized":
        summary.reservationFinalized += 1;
        if (r.status === "reserved" || r.status === "reserved_appended") {
          summary.reservationFinalizedAccepted += 1;
        }
        break;
      case "reservation_waitlist_pending":
        summary.waitlistPending += 1;
        break;
      case "reservation_out_of_stock":
        summary.outOfStock += 1;
        break;
      case "waitlist_migrated_to_wishlist":
        summary.waitlistMigrated += (r.count || 0);
        break;
      case "safemode_toggled":
        summary.safeModeToggles += 1;
        break;
      case "moysklad_call":
        summary.moyskladCalls += 1;
        if (!r.ok) summary.moyskladErrors += 1;
        // Подозрительный = медленный ИЛИ упавший. Раньше быстрые 4xx/5xx
        // не попадали в INDEX как конкретные timestamp-ссылки — приходилось
        // вручную грепать session jsonl. Теперь любой !ok вызов виден.
        if (Number(r.durationMs) > SUSPICIOUS_MOYSKLAD_DURATION_MS || r.ok === false) {
          summary.moyskladSlowCalls.push({
            ts, op: r.op, path: r.path,
            durationMs: r.durationMs,
            ok: r.ok !== false,
            httpStatus: r.httpStatus,
            errorMessage: r.errorMessage,
          });
        }
        break;
      case "wishlist_added":
        summary.wishlistAdded += 1;
        // order_failed entries — инциденты, требующие внимания оператора.
        if (r.trigger === "order_failed") {
          summary.incidents.push({
            ts, viewerName: r.viewerName, productCode: r.productCode,
            reason: "order_failed — попытка создать customerorder упала, спрос остался",
          });
        }
        break;
      case "purchase_order_submitted":
        summary.purchaseOrdersSubmitted += 1;
        break;
      case "purchase_order_response":
        if (r.ok) summary.purchaseOrdersOk += 1;
        else summary.purchaseOrdersFailed += 1;
        break;
      case "safemode_blocked_purchase_order":
        summary.purchaseOrdersBlocked += 1;
        break;
      case "error":
        summary.errors.push({ ts, component: r.component, message: r.message });
        break;
      default:
        break;
    }
  }

  if (summary.reservationFinalized > 0) {
    summary.reservationsAccepted = summary.reservationFinalizedAccepted;
  }

  if (summary.startedAt && summary.endedAt) {
    summary.durationMs = new Date(summary.endedAt).getTime() - new Date(summary.startedAt).getTime();
  }
  return summary;
}

export function generateIndexMd({
  sessions = [], // [{name, content}]
  wishlistEventsContent = null, // raw JSONL string из wishlist/events.jsonl
  wishlistSnapshot = { active: [], archive: [] },
  submissions = null, // raw drafts object
  settings = null,
  packageVersion = null,
  generatedAt = new Date().toISOString(),
} = {}) {
  const sessionSummaries = sessions.map((s) => ({
    name: s.name,
    summary: summarizeSession(parseJsonlSafe(s.content)),
  }));

  // Парсим wishlist events ДО агрегата — иначе верхняя сводка покажет 0
  // инцидентов, хотя ниже в секции «Инциденты» они будут перечислены.
  const wishlistRecords = parseJsonlSafe(wishlistEventsContent);
  const orderFailedFromWishlist = wishlistRecords
    .filter((r) => r.kind === "added" && r.trigger === "order_failed")
    .map((r) => ({
      ts: r.ts,
      viewerName: r.viewerName,
      productCode: r.productCode,
      source: "wishlist/events.jsonl",
      id: r.id,
    }));

  // Дополняем session-инциденты теми, что отсутствуют в wishlist (по productCode+viewerName).
  const sessionIncidents = sessionSummaries.flatMap((s) =>
    s.summary.incidents.map((i) => ({ session: s.name, ...i, source: s.name }))
  );
  const knownKeys = new Set(orderFailedFromWishlist.map((r) => `${r.productCode}|${r.viewerName}`));
  const sessionOnlyIncidents = sessionIncidents.filter((i) => !knownKeys.has(`${i.productCode}|${i.viewerName}`));
  const allIncidents = [...orderFailedFromWishlist, ...sessionOnlyIncidents];

  // Фактические wishlist-add'ы из events.jsonl, разбитые по триггеру. Раньше
  // INDEX.md писал "N out_of_stock → попали в wishlist", опираясь только на
  // счётчик OoS-отказов из сессий. На деле часть отказов в wishlist не
  // попадает (например, если сервер не рестартовали после фикса, либо
  // wishlistStore.addFromOutOfStock вернул null из-за отсутствия viewerId).
  // Считаем по факту — по записям kind:"added" в events.jsonl.
  const wishlistAddRecords = wishlistRecords.filter((r) => r.kind === "added");
  const wishlistAddsByTrigger = wishlistAddRecords.reduce((acc, r) => {
    const key = r.trigger || "unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const wishlistAddsFromOos =
    (wishlistAddsByTrigger.out_of_stock_reservation || 0)
    + (wishlistAddsByTrigger.out_of_stock || 0);

  // Агрегаты по всем сессиям.
  const totals = sessionSummaries.reduce((acc, s) => {
    const x = s.summary;
    acc.lotsOpened += x.lotsOpened;
    acc.reservationsAccepted += x.reservationsAccepted;
    acc.outOfStock += x.outOfStock;
    acc.waitlistMigrated += x.waitlistMigrated;
    acc.moyskladCalls += x.moyskladCalls;
    acc.moyskladErrors += x.moyskladErrors;
    acc.purchaseOrdersOk += x.purchaseOrdersOk;
    acc.purchaseOrdersFailed += x.purchaseOrdersFailed;
    return acc;
  }, { lotsOpened: 0, reservationsAccepted: 0, outOfStock: 0, waitlistMigrated: 0,
       moyskladCalls: 0, moyskladErrors: 0, purchaseOrdersOk: 0, purchaseOrdersFailed: 0 });
  // Инциденты — берём из объединённого источника, не из session-only.
  totals.incidents = allIncidents.length;

  // Wishlist агрегат.
  const wlActive = wishlistSnapshot.active || [];
  const wlArchive = wishlistSnapshot.archive || [];
  const wlBySupplier = new Map();
  for (const e of wlActive) {
    const key = e.supplierName || "Без поставщика";
    wlBySupplier.set(key, (wlBySupplier.get(key) || 0) + 1);
  }
  const oldestActive = wlActive.reduce((min, e) => {
    if (!min) return e;
    return new Date(e.createdAt) < new Date(min.createdAt) ? e : min;
  }, null);

  // Submissions: подсчёт complete/partial/failed.
  let submissionsByStatus = { complete: 0, partial: 0, failed: 0, pending: 0 };
  let submissionsTotal = 0;
  if (submissions?.drafts) {
    for (const draft of Object.values(submissions.drafts)) {
      submissionsTotal += 1;
      const s = draft.status || "pending";
      submissionsByStatus[s] = (submissionsByStatus[s] || 0) + 1;
    }
  }

  const lines = [];
  lines.push(`# Диагностический бандл V-Amber`);
  lines.push(``);
  lines.push(`Сгенерирован: ${generatedAt}  `);
  if (packageVersion) lines.push(`Версия V-Amber: \`${packageVersion}\`  `);
  lines.push(``);

  lines.push(`## Сводка`);
  lines.push(``);
  lines.push(`- **Сессий:** ${sessions.length}`);
  lines.push(`- **Лотов открыто:** ${totals.lotsOpened}`);
  lines.push(`- **Броней принято:** ${totals.reservationsAccepted}`);
  const detectedTotal = sessionSummaries.reduce((acc, s) => acc + (s.summary.reservationDetected || 0), 0);
  if (detectedTotal !== totals.reservationsAccepted) {
    lines.push(`- **Комментариев с бронью распознано:** ${detectedTotal}`);
  }
  lines.push(`- **Out of stock отказов:** ${totals.outOfStock} (в wishlist попало: ${wishlistAddsFromOos})`);
  lines.push(`- **Waitlist → Wishlist на закрытии лотов:** ${totals.waitlistMigrated}`);
  const wishlistAddsTotal = wishlistAddRecords.length;
  if (wishlistAddsTotal > 0) {
    const breakdown = Object.entries(wishlistAddsByTrigger)
      .sort((a, b) => b[1] - a[1])
      .map(([trigger, count]) => `${trigger}=${count}`)
      .join(", ");
    lines.push(`- **Wishlist добавлений всего:** ${wishlistAddsTotal} (${breakdown})`);
  }
  lines.push(`- **Вызовов МойСклад:** ${totals.moyskladCalls} (ошибок: ${totals.moyskladErrors})`);
  lines.push(`- **Purchase orders создано:** ${totals.purchaseOrdersOk}, ошибок: ${totals.purchaseOrdersFailed}`);
  lines.push(`- **Инциденты order_failed (всего):** ${totals.incidents}`);
  lines.push(``);

  lines.push(`## Wish list (текущее состояние)`);
  lines.push(``);
  lines.push(`- **Активных записей:** ${wlActive.length}`);
  lines.push(`- **В архиве (consumed/removed):** ${wlArchive.length}`);
  if (wlBySupplier.size > 0) {
    lines.push(`- **По поставщикам:**`);
    for (const [name, count] of wlBySupplier) {
      lines.push(`  - ${name}: ${count}`);
    }
  }
  if (oldestActive) {
    const ageDays = Math.floor((Date.now() - new Date(oldestActive.createdAt).getTime()) / 86400000);
    lines.push(`- **Самая старая активная:** ${ageDays} дн. — артикул \`${oldestActive.productCode}\` для ${oldestActive.viewerName}`);
  }
  lines.push(``);

  lines.push(`## Submissions (идемпотентность PO)`);
  lines.push(``);
  lines.push(`- Всего черновиков: ${submissionsTotal}`);
  for (const [status, count] of Object.entries(submissionsByStatus)) {
    if (count > 0) lines.push(`  - ${status}: ${count}`);
  }
  lines.push(``);

  // Подозрительные moysklad_calls (медленные ИЛИ неудачные).
  const allSlow = sessionSummaries.flatMap((s) => s.summary.moyskladSlowCalls.map((c) => ({ session: s.name, ...c })));
  if (allSlow.length > 0) {
    lines.push(`## ⚠ Подозрительные вызовы МойСклад (durationMs > ${SUSPICIOUS_MOYSKLAD_DURATION_MS} или ошибка)`);
    lines.push(``);
    for (const c of allSlow.slice(0, 30)) {
      const tag = c.ok === false
        ? `❌ HTTP ${c.httpStatus || "?"}${c.errorMessage ? ` · ${c.errorMessage}` : ""}`
        : `${c.durationMs}ms`;
      lines.push(`- \`${c.ts}\` ${c.op} ${c.path} — ${tag} · _${c.session}_`);
    }
    if (allSlow.length > 30) lines.push(`- _… и ещё ${allSlow.length - 30}_`);
    lines.push(``);
  }

  // allIncidents уже посчитаны выше до сводки. Здесь только ошибки.
  const allErrors = sessionSummaries.flatMap((s) => s.summary.errors.map((e) => ({ session: s.name, ...e })));
  if (allIncidents.length > 0 || allErrors.length > 0) {
    lines.push(`## ⚠ Инциденты`);
    lines.push(``);
    for (const i of allIncidents) {
      lines.push(`- \`${i.ts}\` order_failed: ${i.viewerName} на артикул \`${i.productCode}\` · _${i.source || i.session}_`);
    }
    for (const e of allErrors) {
      lines.push(`- \`${e.ts}\` ❌ [${e.component || "?"}] ${e.message} · _${e.session}_`);
    }
    lines.push(``);
  }

  // Per-session breakdown.
  lines.push(`## Сессии`);
  lines.push(``);
  for (const s of sessionSummaries) {
    const x = s.summary;
    lines.push(`### \`${s.name}\``);
    lines.push(``);
    if (x.startedAt) lines.push(`- Начало: ${x.startedAt}`);
    if (x.endedAt) lines.push(`- Конец: ${x.endedAt}`);
    if (x.durationMs) lines.push(`- Длительность: ${fmtDuration(x.durationMs)}`);
    if (x.endReason) lines.push(`- Причина окончания: \`${x.endReason}\``);
    if (x.context) {
      lines.push(`- Контекст: версия \`${x.context.version || "?"}\`, safeMode=\`${x.context.safeMode}\`, productCache=\`${x.context.productCache?.count ?? "?"}\``);
    }
    lines.push(`- Лотов: ${x.lotsOpened}, броней: ${x.reservationsAccepted}, out_of_stock: ${x.outOfStock}, waitlist→wishlist: ${x.waitlistMigrated}`);
    lines.push(`- МС: ${x.moyskladCalls} вызовов, ${x.moyskladErrors} ошибок`);
    if (x.safeModeToggles > 0) lines.push(`- Safe mode toggles: ${x.safeModeToggles}`);
    if (x.purchaseOrdersSubmitted > 0) {
      lines.push(`- PO: ${x.purchaseOrdersOk} ok / ${x.purchaseOrdersFailed} failed / ${x.purchaseOrdersBlocked} safe-mode-blocked`);
    }
    lines.push(``);
  }

  // Settings preview.
  if (settings?.wishlist) {
    const w = settings.wishlist;
    lines.push(`## Настройки оператора (wishlist)`);
    lines.push(``);
    lines.push(`- defaultStoreId: \`${w.defaultStoreId || "не задан"}\``);
    lines.push(`- defaultSupplierId: \`${w.defaultSupplierId || "не задан"}\``);
    lines.push(`- oldDaysThreshold: ${w.oldDaysThreshold}`);
    lines.push(`- notifyVkOnAdd: ${w.notifyVkOnAdd}`);
    const tpl = String(w.descriptionTemplate || "");
    lines.push(`- descriptionTemplate: \`${tpl.slice(0, 200)}${tpl.length > 200 ? "…" : ""}\``);
    lines.push(``);
  }

  lines.push(`---`);
  lines.push(``);
  lines.push(`_MVP-ограничения: диагностический sink для moysklad_call работает в рамках одной активной WS-сессии. Если HTTP-вызов идёт без открытой сессии, событие падает в server.log как \`moysklad_call_unrouted\`._`);
  lines.push(``);

  return lines.join("\n");
}

export function generateMetaJson({
  packageVersion = null,
  config = {},
  files = [],
  generatedAt = new Date().toISOString(),
} = {}) {
  // Имена env-флагов БЕЗ значений — оператору безопасно прислать.
  const envNames = Object.keys(process.env)
    .filter((k) => /^(MOYSKLAD_|VK_|YANDEX_|WISHLIST_|VOICE_|PORT)/.test(k))
    .sort();
  return {
    v: 1,
    generatedAt,
    vamberVersion: packageVersion,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    integrationsEnabled: {
      vk: Boolean(config?.vk?.userToken),
      moysklad: Boolean(config?.moysklad?.login && config?.moysklad?.password),
      speechkit: Boolean(config?.speechkit?.apiKey),
    },
    envFlagsPresent: envNames,
    files: files.map((f) => ({
      name: f.archiveName || f.name,
      bytes: f.bytes ?? f.buffer?.length ?? 0,
      originalBytes: f.originalSize ?? f.originalBytes ?? null,
      truncated: Boolean(f.truncated),
    })),
    mvpLimitations: [
      "moysklad_call sink уважает только одну активную WS-сессию; HTTP-flow без сессии пишет в server.log как unrouted.",
      "Wishlist customerorder lookup (intersections) — заглушка, всегда возвращает inOpenOrder:false.",
      "wishlist-submissions TTL не реализован — записи остаются для аудита навсегда.",
    ],
  };
}
