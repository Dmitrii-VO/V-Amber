import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { logger } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const filePath = join(__dirname, "..", "logs", "wishlist-submissions.json");
const tmpPath = `${filePath}.tmp`;

const SCHEMA_VERSION = 1;

function blankDraft() {
  return {
    status: "pending",
    submittedAt: null,
    groups: {},
  };
}

function recomputeDraftStatus(draft) {
  const groups = Object.values(draft.groups || {});
  if (groups.length === 0) {
    draft.status = "pending";
    return;
  }
  const allOk = groups.every((g) => g.status === "ok");
  const allFailed = groups.every((g) => g.status === "failed" || g.status === "safe_mode_blocked");
  if (allOk) draft.status = "complete";
  else if (allFailed) draft.status = "failed";
  else draft.status = "partial";
}

export function createWishlistSubmissions() {
  let payload = { v: SCHEMA_VERSION, drafts: {} };
  let writeChain = Promise.resolve();
  let loaded = false;

  async function persist() {
    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(tmpPath, JSON.stringify(payload, null, 2), "utf8");
      await rename(tmpPath, filePath);
    } catch (error) {
      logger.warn("wishlist-submissions", "save_failed", { error });
    }
  }

  function scheduleSave() {
    writeChain = writeChain.then(persist);
    return writeChain;
  }

  return {
    async load() {
      if (loaded) return payload;
      loaded = true;
      try {
        const raw = await readFile(filePath, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && parsed.drafts) {
          payload = { v: SCHEMA_VERSION, drafts: parsed.drafts };
        }
      } catch (error) {
        if (error?.code !== "ENOENT") {
          logger.warn("wishlist-submissions", "load_failed", { error });
        }
      }
      return payload;
    },

    getSubmission(draftId) {
      return payload.drafts[draftId] || null;
    },

    isDraftComplete(draftId) {
      return payload.drafts[draftId]?.status === "complete";
    },

    getGroupResult(draftId, groupHash) {
      return payload.drafts[draftId]?.groups?.[groupHash] || null;
    },

    listAll() {
      return payload.drafts;
    },

    async recordGroupResult(draftId, groupHash, result) {
      if (!draftId || !groupHash) return;
      const draft = payload.drafts[draftId] || blankDraft();
      draft.submittedAt = draft.submittedAt || new Date().toISOString();
      draft.groups[groupHash] = {
        ...result,
        recordedAt: new Date().toISOString(),
      };
      recomputeDraftStatus(draft);
      payload.drafts[draftId] = draft;
      await scheduleSave();
      return draft;
    },

    async ensureDraft(draftId) {
      if (!draftId) return null;
      if (!payload.drafts[draftId]) {
        payload.drafts[draftId] = blankDraft();
        await scheduleSave();
      }
      return payload.drafts[draftId];
    },
  };
}
