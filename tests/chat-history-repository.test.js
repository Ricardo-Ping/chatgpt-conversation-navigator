const test = require("node:test");
const assert = require("node:assert/strict");

const { createChatHistoryRepository } = require("../conversation-manager.js");

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

function emptyResponse(status = 204, headers = {}) {
  return new Response(null, { status, headers });
}

function createFixtureFetch(overrides = {}) {
  const calls = [];
  const attempts = new Map();
  const fetchImpl = async (input, options = {}) => {
    const url = String(input);
    calls.push({ url, options });
    const parsed = new URL(url, "https://chatgpt.com");

    if (parsed.pathname === "/api/auth/session") return jsonResponse({ accessToken: "memory-only-token" });
    if (parsed.pathname.startsWith("/backend-api/accounts/check/")) {
      return jsonResponse({
        accounts: {
          default: { account: { account_id: "account-a", plan_type: "plus" } },
          "account-a": { account: { account_id: "account-a", plan_type: "plus" } },
          "account-b": { account: { account_id: "account-b", name: "工作账号" } }
        },
        account_ordering: ["account-a", "account-b"]
      });
    }

    if (parsed.pathname === "/backend-api/conversations") {
      const archived = parsed.searchParams.get("is_archived") === "true";
      const offset = Number(parsed.searchParams.get("offset"));
      if (archived) return jsonResponse({ items: [{ id: "archived", title: "旧聊天", update_time: "2025-01-01T00:00:00Z" }], total: 1, limit: 100, offset: 0 });
      if (offset === 0) {
        return jsonResponse({
          items: [
            { id: "one", title: "聊天一", update_time: "2026-02-01T00:00:00Z" },
            { id: "two", title: "聊天二", update_time: "2026-01-01T00:00:00Z" }
          ],
          total: 3,
          limit: 100,
          offset: 0
        });
      }
      return jsonResponse({ items: [{ id: "three", title: "聊天三", update_time: "2025-12-01T00:00:00Z" }], total: 3, limit: 100, offset });
    }

    if (parsed.pathname === "/backend-api/gizmos/snorlax/sidebar") {
      return jsonResponse({ items: [{ gizmo: { gizmo: { id: "g-p-project" } } }], cursor: null });
    }
    if (parsed.pathname === "/backend-api/gizmos/g-p-project/conversations") {
      return jsonResponse({ items: [{ id: "project-chat", title: "项目聊天", update_time: "2026-04-01T00:00:00Z" }] });
    }
    if (parsed.pathname === "/backend-api/pins") {
      return jsonResponse([
        { item_type: "conversation", item: { id: "one", title: "聊天一", update_time: "2026-02-01T00:00:00Z" } },
        { item_type: "conversation", item: { id: "star", title: "置顶聊天", update_time: "2026-03-01T00:00:00Z" } }
      ]);
    }
    if (parsed.pathname === "/backend-api/tasks") {
      return jsonResponse({
        tasks: [
          {
            task_id: "task-one",
            conversation_id: "scheduled-chat",
            title: "每天检查研究进展",
            status: "active",
            created_at: "2026-08-01T00:00:00Z",
            updated_at: "2026-09-01T00:00:00Z"
          },
          {
            task_id: "task-two",
            title: "尚未产生会话的提醒",
            status: "paused",
            created_at: "2026-07-01T00:00:00Z",
            updated_at: "2026-08-01T00:00:00Z"
          }
        ]
      });
    }

    if (parsed.pathname.startsWith("/backend-api/conversation/")) {
      const id = parsed.pathname.split("/").at(-1);
      const attempt = (attempts.get(id) || 0) + 1;
      attempts.set(id, attempt);
      if (overrides.mutation) return overrides.mutation({ id, attempt, url, options });
      return emptyResponse();
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  return { calls, fetchImpl };
}

test("loads, paginates, merges, and protects all active conversation sources", async () => {
  const fixture = createFixtureFetch();
  const repository = createChatHistoryRepository({ fetchImpl: fixture.fetchImpl, sleep: async () => {} });
  const result = await repository.loadAll({ archiveState: "active" });
  assert.equal(result.accountId, "account-a");
  assert.equal(result.records.length, 5);
  assert.equal(result.records.find((item) => item.id === "one").pinned, true);
  assert.equal(result.records.find((item) => item.id === "star").pinned, true);
  assert.equal(result.records.find((item) => item.id === "project-chat").projectId, "g-p-project");
  assert.equal(result.protectionVerified, true);
  assert.equal(result.canMutate, true);
  assert.ok(fixture.calls.some((call) => call.url.includes("offset=2")));
  assert.ok(fixture.calls.every((call) => !String(call.options.headers?.Authorization || "").includes("undefined")));
});

test("archived view avoids active project and pin requests", async () => {
  const fixture = createFixtureFetch();
  const repository = createChatHistoryRepository({ fetchImpl: fixture.fetchImpl, sleep: async () => {} });
  const result = await repository.loadAll({ archiveState: "archived" });
  assert.deepEqual(result.records.map((item) => item.id), ["archived"]);
  assert.equal(fixture.calls.some((call) => call.url.includes("/backend-api/pins")), false);
  assert.equal(fixture.calls.some((call) => call.url.includes("/gizmos/snorlax/")), false);
});

test("scheduled view reads only the tasks endpoint instead of all conversations", async () => {
  const fixture = createFixtureFetch();
  const repository = createChatHistoryRepository({ fetchImpl: fixture.fetchImpl, sleep: async () => {} });
  const result = await repository.loadAll({ archiveState: "scheduled" });
  assert.deepEqual(result.records.map((item) => item.id), ["scheduled-chat", "task:task-two"]);
  assert.ok(result.records.every((item) => item.automation));
  assert.equal(result.canMutate, false);
  assert.equal(result.compatible, true);
  assert.equal(fixture.calls.some((call) => call.url.includes("/backend-api/tasks")), true);
  assert.equal(fixture.calls.some((call) => call.url.includes("/backend-api/conversations")), false);
  assert.equal(fixture.calls.some((call) => call.url.includes("/backend-api/pins")), false);
  assert.equal(fixture.calls.some((call) => call.url.includes("/gizmos/snorlax/")), false);
});

test("scheduled view paginates tasks and rejects an incompatible task payload", async () => {
  const fixture = createFixtureFetch();
  const pagedFetch = async (input, options) => {
    const parsed = new URL(String(input), "https://chatgpt.com");
    if (parsed.pathname === "/backend-api/tasks") {
      if (!parsed.searchParams.has("cursor")) {
        return jsonResponse({
          tasks: [
            { task_id: "first", title: "任务一", updated_at: "2026-09-01T00:00:00Z" },
            { id: "raw-task-id", title: "", updated_at: "2026-08-15T00:00:00Z" }
          ],
          next_cursor: "page-two"
        });
      }
      return jsonResponse({ tasks: [{ task_id: "second", title: "任务二", updated_at: "2026-08-01T00:00:00Z" }] });
    }
    return fixture.fetchImpl(input, options);
  };
  const repository = createChatHistoryRepository({ fetchImpl: pagedFetch, sleep: async () => {} });
  const result = await repository.loadAll({ archiveState: "scheduled" });
  assert.deepEqual(result.records.map((record) => record.id), ["task:first", "task:raw-task-id", "task:second"]);
  assert.equal(result.records.find((record) => record.id === "task:raw-task-id").title, "未命名定时任务");

  const incompatibleRepository = createChatHistoryRepository({
    fetchImpl: async (input, options) => {
      const parsed = new URL(String(input), "https://chatgpt.com");
      if (parsed.pathname === "/backend-api/tasks") return jsonResponse({ items: [] });
      return fixture.fetchImpl(input, options);
    },
    sleep: async () => {}
  });
  await assert.rejects(
    incompatibleRepository.loadAll({ archiveState: "scheduled" }),
    /已安排接口结构已变化/
  );
});

test("loads one selected account without merging account histories", async () => {
  const fixture = createFixtureFetch();
  const repository = createChatHistoryRepository({ fetchImpl: fixture.fetchImpl, sleep: async () => {} });
  const result = await repository.loadAll({ accountId: "account-b", archiveState: "archived" });
  assert.equal(result.accountId, "account-b");
  assert.equal(result.accounts.length, 2);
  const historyCalls = fixture.calls.filter((call) => call.url.includes("/backend-api/conversations"));
  assert.ok(historyCalls.length > 0);
  assert.ok(historyCalls.every((call) => call.options.headers["ChatGPT-Account-Id"] === "account-b"));
});

test("batch mutations retry transient failures and treat a missing delete as complete", async () => {
  const fixture = createFixtureFetch({
    mutation({ id, attempt }) {
      if (id === "retry-500" && attempt === 1) return emptyResponse(500);
      if (id === "retry-429" && attempt === 1) return emptyResponse(429, { "retry-after": "0.001" });
      if (id === "gone") return emptyResponse(404);
      return emptyResponse();
    }
  });
  const repository = createChatHistoryRepository({ fetchImpl: fixture.fetchImpl, sleep: async () => {} });
  await repository.loadAll({ archiveState: "active" });
  const result = await repository.runBatch({ action: "delete", ids: ["retry-500", "retry-429", "gone"] });
  assert.deepEqual(new Set(result.succeeded), new Set(["retry-500", "retry-429", "gone"]));
  assert.equal(result.failed.length, 0);
  assert.equal(result.unprocessed.length, 0);
});

test("authentication failure stops a batch safely", async () => {
  const fixture = createFixtureFetch({ mutation: () => emptyResponse(401) });
  const repository = createChatHistoryRepository({ fetchImpl: fixture.fetchImpl, sleep: async () => {} });
  await repository.loadAll({ archiveState: "active" });
  const result = await repository.runBatch({ action: "archive", ids: ["one"] });
  assert.equal(result.succeeded.length, 0);
  assert.equal(result.failed.length, 1);
  assert.match(result.fatalError, /登录状态已失效/);
});

test("archive and restore use PATCH with explicit archive state", async () => {
  const fixture = createFixtureFetch();
  const repository = createChatHistoryRepository({ fetchImpl: fixture.fetchImpl, sleep: async () => {} });
  await repository.loadAll({ archiveState: "active" });
  await repository.runBatch({ action: "archive", ids: ["one"] });
  await repository.runBatch({ action: "restore", ids: ["two"] });
  const writes = fixture.calls.filter((call) => call.url.includes("/backend-api/conversation/"));
  assert.equal(writes[0].options.method, "PATCH");
  assert.deepEqual(JSON.parse(writes[0].options.body), { is_archived: true });
  assert.deepEqual(JSON.parse(writes[1].options.body), { is_archived: false });
});

test("an auxiliary compatibility failure disables every mutation", async () => {
  const fixture = createFixtureFetch();
  const fetchImpl = async (input, options) => {
    const parsed = new URL(String(input), "https://chatgpt.com");
    if (parsed.pathname === "/backend-api/pins") return jsonResponse({ unexpected: [] });
    return fixture.fetchImpl(input, options);
  };
  const repository = createChatHistoryRepository({ fetchImpl, sleep: async () => {} });
  const result = await repository.loadAll({ archiveState: "active" });
  assert.equal(result.canMutate, false);
  assert.match(result.warnings.at(-1), /已禁用归档、恢复和删除/);
  await assert.rejects(
    repository.runBatch({ action: "archive", ids: ["one"] }),
    /兼容性检查未通过/
  );
});

test("a failed full compatibility check preserves previously cached records", async () => {
  const fixture = createFixtureFetch();
  const fetchImpl = async (input, options) => {
    const parsed = new URL(String(input), "https://chatgpt.com");
    if (parsed.pathname === "/backend-api/pins") return jsonResponse({ incompatible: true });
    return fixture.fetchImpl(input, options);
  };
  const repository = createChatHistoryRepository({ fetchImpl, sleep: async () => {} });
  const result = await repository.loadAll({
    archiveState: "active",
    mode: "full",
    cachedRecords: [{ id: "cached-only", title: "缓存旧记录", updatedAt: 1, archived: false }]
  });
  assert.equal(result.canMutate, false);
  assert.equal(result.records.some((record) => record.id === "cached-only"), true);
});

test("project discovery paginates and project reads use at most three workers", async () => {
  const fixture = createFixtureFetch();
  let activeProjects = 0;
  let maxActiveProjects = 0;
  const fetchImpl = async (input, options) => {
    const parsed = new URL(String(input), "https://chatgpt.com");
    if (parsed.pathname === "/backend-api/gizmos/snorlax/sidebar") {
      if (!parsed.searchParams.has("cursor")) {
        return jsonResponse({
          items: [
            { gizmo: { gizmo: { id: "g-p-1" } } },
            { gizmo: { gizmo: { id: "g-p-2" } } }
          ],
          cursor: 2
        });
      }
      return jsonResponse({
        items: [
          { gizmo: { gizmo: { id: "g-p-3" } } },
          { gizmo: { gizmo: { id: "g-p-4" } } }
        ],
        cursor: null
      });
    }
    if (/^\/backend-api\/gizmos\/g-p-\d+\/conversations$/.test(parsed.pathname)) {
      activeProjects += 1;
      maxActiveProjects = Math.max(maxActiveProjects, activeProjects);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeProjects -= 1;
      const projectId = parsed.pathname.split("/").at(-2);
      const cursor = parsed.searchParams.get("cursor");
      if (cursor === "0") {
        return jsonResponse({ items: [{ id: `${projectId}-chat-1`, title: projectId }], cursor: `next-${projectId}` });
      }
      return jsonResponse({ items: [{ id: `${projectId}-chat-2`, title: projectId }], cursor: null });
    }
    return fixture.fetchImpl(input, options);
  };
  const repository = createChatHistoryRepository({ fetchImpl, sleep: async () => {} });
  const result = await repository.loadAll({ archiveState: "active" });
  assert.equal(result.records.filter((record) => record.projectId).length, 8);
  assert.equal(maxActiveProjects, 3);
});

test("stopping a batch reports work that was never started", async () => {
  const controller = new AbortController();
  const fixture = createFixtureFetch({
    mutation({ id }) {
      if (id === "stop-now") controller.abort();
      return emptyResponse();
    }
  });
  const repository = createChatHistoryRepository({ fetchImpl: fixture.fetchImpl, sleep: async () => {} });
  await repository.loadAll({ archiveState: "active" });
  const result = await repository.runBatch({
    action: "archive",
    ids: ["stop-now", "later-1", "later-2", "later-3"],
    signal: controller.signal
  });
  assert.ok(result.unprocessed.length >= 1);
  assert.equal(result.succeeded.includes("later-3"), false);
});

test("repository never sends more than three requests at once", async () => {
  const fixture = createFixtureFetch();
  let activeRequests = 0;
  let maxActiveRequests = 0;
  const fetchImpl = async (input, options) => {
    activeRequests += 1;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    await new Promise((resolve) => setTimeout(resolve, 5));
    try {
      return await fixture.fetchImpl(input, options);
    } finally {
      activeRequests -= 1;
    }
  };
  const repository = createChatHistoryRepository({ fetchImpl, sleep: async () => {} });
  await repository.loadAll({ archiveState: "active" });
  maxActiveRequests = 0;
  await repository.runBatch({ action: "archive", ids: ["a", "b", "c", "d", "e", "f"] });
  assert.equal(maxActiveRequests, 3);
});

test("bootstrap authenticates without reading conversation history", async () => {
  const fixture = createFixtureFetch();
  const repository = createChatHistoryRepository({ fetchImpl: fixture.fetchImpl, sleep: async () => {} });
  const result = await repository.bootstrap();
  assert.equal(result.accountId, "account-a");
  assert.equal(result.accounts.length, 2);
  assert.equal(fixture.calls.some((call) => call.url.includes("/backend-api/conversations")), false);
});

test("incremental loading stops after an unchanged cached page and merges cached history", async () => {
  const fixture = createFixtureFetch();
  const cachedRecords = [
    { id: "one", title: "聊天一", updatedAt: Date.parse("2026-02-01T00:00:00Z"), archived: false },
    { id: "two", title: "聊天二", updatedAt: Date.parse("2026-01-01T00:00:00Z"), archived: false },
    { id: "older-cache", title: "缓存旧聊天", updatedAt: Date.parse("2025-01-01T00:00:00Z"), archived: false }
  ];
  const repository = createChatHistoryRepository({ fetchImpl: fixture.fetchImpl, sleep: async () => {} });
  const result = await repository.loadAll({ archiveState: "active", mode: "incremental", cachedRecords });
  assert.equal(result.records.some((record) => record.id === "older-cache"), true);
  assert.equal(fixture.calls.some((call) => call.url.includes("offset=2")), false);
  assert.equal(result.syncMode, "incremental");
});

test("validation mode checks current endpoints while preserving the cached index", async () => {
  const fixture = createFixtureFetch();
  const cachedRecords = [{ id: "cached-only", title: "缓存聊天", updatedAt: 1, archived: false }];
  const repository = createChatHistoryRepository({ fetchImpl: fixture.fetchImpl, sleep: async () => {} });
  const result = await repository.loadAll({ archiveState: "active", mode: "validate", cachedRecords });
  assert.equal(result.records.some((record) => record.id === "cached-only"), true);
  assert.equal(result.canMutate, true);
  assert.equal(fixture.calls.some((call) => call.url.includes("offset=2")), false);
});

test("incremental project loading stops at an unchanged project page", async () => {
  const fixture = createFixtureFetch();
  const projectUrls = [];
  const fetchImpl = async (input, options) => {
    const parsed = new URL(String(input), "https://chatgpt.com");
    if (parsed.pathname === "/backend-api/gizmos/g-p-project/conversations") {
      projectUrls.push(String(input));
      if (parsed.searchParams.get("cursor") === "0") {
        return jsonResponse({
          items: [{ id: "project-chat", title: "项目聊天", update_time: "2026-04-01T00:00:00Z" }],
          cursor: "older-page"
        });
      }
      return jsonResponse({ items: [{ id: "project-older", title: "项目旧聊天" }], cursor: null });
    }
    return fixture.fetchImpl(input, options);
  };
  const cachedRecords = [
    { id: "project-chat", title: "项目聊天", updatedAt: Date.parse("2026-04-01T00:00:00Z"), archived: false, projectId: "g-p-project" },
    { id: "project-cached-old", title: "缓存项目旧聊天", updatedAt: 1, archived: false, projectId: "g-p-project" }
  ];
  const repository = createChatHistoryRepository({ fetchImpl, sleep: async () => {} });
  const result = await repository.loadAll({ archiveState: "active", mode: "incremental", cachedRecords });
  assert.equal(result.records.some((record) => record.id === "project-cached-old"), true);
  assert.equal(projectUrls.some((url) => url.includes("cursor=older-page")), false);
});
