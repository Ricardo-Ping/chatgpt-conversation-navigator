const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { conversationRecordsEqual, createThrottledUpdater, getEmptyStateLabel } = require("../conversation-manager.js");

test("progress updates are coalesced to at most one visible update per interval", () => {
  let clock = 0;
  let scheduled = null;
  const values = [];
  const updater = createThrottledUpdater((value) => values.push(value), {
    interval: 100,
    now: () => clock,
    schedule(task, delay) {
      scheduled = { task, delay };
      return scheduled;
    },
    cancelSchedule() { scheduled = null; }
  });
  updater.push("first");
  clock = 10;
  updater.push("second");
  clock = 50;
  updater.push("latest");
  assert.deepEqual(values, ["first"]);
  assert.equal(scheduled.delay, 90);
  clock = 100;
  scheduled.task();
  assert.deepEqual(values, ["first", "latest"]);
});

test("manager keeps stable roots and hides inactive destructive controls", () => {
  const manager = fs.readFileSync(path.join(__dirname, "..", "conversation-manager.js"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "content.css"), "utf8");
  assert.doesNotMatch(manager, /root\.innerHTML\s*=/);
  assert.match(manager, /ui\.list\.replaceChildren\(\)/);
  assert.match(css, /\.cgn-manager-hidden\s*\{\s*display:\s*none\s*!important;/s);
  assert.match(manager, /scheduled:\s*Object\.freeze\(\{\s*label:\s*"已安排"/);
  assert.match(manager, /"项目会话"/);
});

test("toolbar exposes fast incremental sync separately from full calibration", () => {
  const manager = fs.readFileSync(path.join(__dirname, "..", "conversation-manager.js"), "utf8");
  assert.match(manager, /createButton\("同步"[\s\S]*forceIncremental:\s*true/);
  assert.match(manager, /createButton\("全量"[\s\S]*forceFull:\s*true/);
  assert.match(manager, /shouldHydrateCachedView[\s\S]*updateAll\(\{ rebuildList:\s*true \}\)[\s\S]*else\s*\{\s*updateAll\(\)/);
  assert.match(manager, /mode === "full" \|\| requestedView === "scheduled"\s*\? result\.records/);
});

test("empty state leaves loading state and names the scheduled view accurately", () => {
  assert.equal(getEmptyStateLabel({ loading: true, view: "scheduled" }), "正在读取已安排会话…");
  assert.equal(getEmptyStateLabel({ loading: false, view: "scheduled" }), "当前条件下没有已安排会话。");
  assert.equal(getEmptyStateLabel({ loading: false, query: "研究", view: "scheduled" }), "没有匹配的已安排会话。");
  assert.equal(getEmptyStateLabel({ loading: false, view: "active" }), "当前条件下没有聊天。");
});

test("unchanged sync records do not require rebuilding list rows", () => {
  const records = [{ id: "one", title: "聊天", updatedAt: 1, archived: false, pinned: false, projectId: null, automation: false, temporary: false }];
  assert.equal(conversationRecordsEqual(records, structuredClone(records)), true);
  assert.equal(conversationRecordsEqual(records, [{ ...records[0], pinned: true }]), false);
  assert.equal(conversationRecordsEqual(records, [...records, { ...records[0], id: "two" }]), false);
});
