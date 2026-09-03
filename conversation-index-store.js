(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.CGNConversationIndexStore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SCHEMA_VERSION = 1;
  const STORAGE_PREFIX = "cgn_conversation_index_v1";
  const VALID_VIEWS = new Set(["active", "archived", "scheduled"]);

  function createConversationIndexStore({ storage, cryptoImpl = globalThis.crypto, now = () => Date.now() } = {}) {
    if (!storage || typeof storage.get !== "function" || typeof storage.set !== "function") {
      throw new Error("ConversationIndexStore requires a storage adapter.");
    }

    async function accountKey(accountId) {
      const value = String(accountId || "");
      if (!value) throw new Error("Cannot cache conversations without an account id.");
      if (!cryptoImpl?.subtle || typeof TextEncoder === "undefined") {
        throw new Error("This browser cannot create a private cache namespace.");
      }
      const digest = await cryptoImpl.subtle.digest("SHA-256", new TextEncoder().encode(value));
      const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      return `${STORAGE_PREFIX}:${hash}`;
    }

    async function read(accountId, archiveState) {
      if (!VALID_VIEWS.has(archiveState)) return null;
      const key = await accountKey(accountId);
      const stored = await storage.get(key);
      const bundle = stored?.[key];
      if (!isValidBundle(bundle)) return null;
      const view = bundle.views?.[archiveState];
      if (!isValidView(view)) return null;
      return cloneView(view);
    }

    async function write(accountId, archiveState, view) {
      if (!VALID_VIEWS.has(archiveState)) throw new Error(`Unknown conversation view: ${archiveState}`);
      const key = await accountKey(accountId);
      const stored = await storage.get(key);
      const current = isValidBundle(stored?.[key]) ? stored[key] : emptyBundle();
      current.lastAccessedAt = now();
      current.views[archiveState] = sanitizeView(view);
      await storage.set({ [key]: current });
      return cloneView(current.views[archiveState]);
    }

    async function applyBatch(accountId, { action, succeeded, records }) {
      const ids = new Set((succeeded || []).map(String));
      if (!ids.size) return;
      const key = await accountKey(accountId);
      const stored = await storage.get(key);
      const bundle = isValidBundle(stored?.[key]) ? stored[key] : emptyBundle();
      const selectedRecords = new Map((records || []).filter((record) => ids.has(record.id)).map((record) => [record.id, record]));
      const active = isValidView(bundle.views.active) ? bundle.views.active : emptyView();
      const archived = isValidView(bundle.views.archived) ? bundle.views.archived : emptyView();

      active.records = active.records.filter((record) => !ids.has(record.id));
      archived.records = archived.records.filter((record) => !ids.has(record.id));
      if (action === "archive") {
        archived.records.push(...[...selectedRecords.values()].map((record) => sanitizeRecord({ ...record, archived: true })));
      } else if (action === "restore") {
        active.records.push(...[...selectedRecords.values()].map((record) => sanitizeRecord({ ...record, archived: false })));
      }
      active.syncedAt = now();
      archived.syncedAt = now();
      bundle.views.active = sanitizeView(active);
      bundle.views.archived = sanitizeView(archived);
      bundle.lastAccessedAt = now();
      await storage.set({ [key]: bundle });
    }

    function emptyBundle() {
      return { schemaVersion: SCHEMA_VERSION, lastAccessedAt: now(), views: {} };
    }

    function emptyView() {
      return { records: [], syncedAt: 0, fullSyncedAt: 0, checkpoints: { main: null, projects: {} } };
    }

    return Object.freeze({ accountKey, applyBatch, read, write });
  }

  function sanitizeRecord(record) {
    return {
      id: String(record?.id || ""),
      title: String(record?.title || "未命名聊天"),
      createdAt: Number.isFinite(record?.createdAt) ? record.createdAt : null,
      updatedAt: Number.isFinite(record?.updatedAt) ? record.updatedAt : null,
      archived: Boolean(record?.archived),
      pinned: Boolean(record?.pinned),
      projectId: record?.projectId ? String(record.projectId) : null,
      automation: Boolean(record?.automation),
      temporary: Boolean(record?.temporary)
    };
  }

  function sanitizeView(view) {
    const records = Array.isArray(view?.records) ? view.records.map(sanitizeRecord).filter((record) => record.id) : [];
    const deduped = new Map(records.map((record) => [record.id, record]));
    const projects = view?.checkpoints?.projects && typeof view.checkpoints.projects === "object"
      ? Object.fromEntries(Object.entries(view.checkpoints.projects).filter(([, value]) => Number.isFinite(value)))
      : {};
    return {
      records: [...deduped.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
      syncedAt: Number.isFinite(view?.syncedAt) ? view.syncedAt : 0,
      fullSyncedAt: Number.isFinite(view?.fullSyncedAt) ? view.fullSyncedAt : 0,
      checkpoints: {
        main: Number.isFinite(view?.checkpoints?.main) ? view.checkpoints.main : null,
        projects
      }
    };
  }

  function isValidBundle(bundle) {
    return Boolean(
      bundle
      && typeof bundle === "object"
      && bundle.schemaVersion === SCHEMA_VERSION
      && Number.isFinite(bundle.lastAccessedAt)
      && bundle.views
      && typeof bundle.views === "object"
      && !Array.isArray(bundle.views)
    );
  }

  function isValidView(view) {
    if (!view || typeof view !== "object" || !Array.isArray(view.records)) return false;
    if (!Number.isFinite(view.syncedAt) || !Number.isFinite(view.fullSyncedAt)) return false;
    const checkpoints = view.checkpoints;
    if (!checkpoints || typeof checkpoints !== "object" || Array.isArray(checkpoints)) return false;
    if (!(checkpoints.main === null || Number.isFinite(checkpoints.main))) return false;
    if (!checkpoints.projects || typeof checkpoints.projects !== "object" || Array.isArray(checkpoints.projects)) return false;
    if (Object.values(checkpoints.projects).some((value) => !Number.isFinite(value))) return false;
    return view.records.every(isValidRecord);
  }

  function isValidRecord(record) {
    return Boolean(
      record
      && typeof record === "object"
      && typeof record.id === "string"
      && record.id.length > 0
      && typeof record.title === "string"
      && (record.createdAt === null || Number.isFinite(record.createdAt))
      && (record.updatedAt === null || Number.isFinite(record.updatedAt))
      && typeof record.archived === "boolean"
      && typeof record.pinned === "boolean"
      && (record.projectId === null || typeof record.projectId === "string")
      && typeof record.automation === "boolean"
      && typeof record.temporary === "boolean"
    );
  }

  function cloneView(view) {
    return sanitizeView(view);
  }

  return Object.freeze({ SCHEMA_VERSION, STORAGE_PREFIX, createConversationIndexStore });
});
