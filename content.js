(function () {
  const ROOT_ID = "cg-branch-map-root";
  const STORAGE_PREFIX = "cg_branch_map_v3";
  const GLOBAL_BRANCH_PENDING_KEY = "cg_branch_pending_v1";
  const GLOBAL_BRANCH_LINEAGE_KEY = "cg_branch_lineage_v1";
  const GLOBAL_RETURN_TARGET_KEY = "cg_branch_return_target_v1";
  const MESSAGE_SELECTORS = [
    '[data-message-author-role]',
    'article[data-testid^="conversation-turn-"]',
    'article[data-testid*="conversation-turn"]',
    'main article',
    'main [class*="conversation-turn"]'
  ];
  const VIEW_MODE = { MAP: "map", TREE: "tree" };
  const PANEL = { minWidth: 300, maxWidth: 760, minHeight: 260, maxHeight: 860 };
  const MAP_LAYOUT = { cardWidth: 220, cardHeight: 136, levelGap: 250, rowGap: 160, paddingX: 24, paddingY: 18 };

  let conversationId = getConversationId();
  let appState = createEmptyState();
  let rootEl = null;
  let observer = null;
  let scanTimer = null;
  let lastPathname = location.pathname;
  let mapRuntime = null;
  let cachedMessages = [];
  let suppressObserver = false;
  let lifecycleTimer = null;
  let errorGuardInstalled = false;
  let pendingSearchFocus = null;
  let branchOpening = false;
  let liteViewportSyncCleanup = null;

  boot().catch((error) => handleContextError(error));

  async function boot() {
    installGlobalErrorGuards();
    if (!isExtensionContextAlive()) return;
    await loadState();
    normalizeState();
    ensureRoot();
    scanMessages();
    await handleBranchLifecycle();
    await maybeApplyReturnTarget();
    installObserver();
    window.addEventListener("popstate", handleLocationMaybeChanged);
    lifecycleTimer = setInterval(() => {
      if (!isExtensionContextAlive()) {
        if (lifecycleTimer) clearInterval(lifecycleTimer);
        lifecycleTimer = null;
        return;
      }
      try {
        handleLocationMaybeChanged();
        void handleBranchLifecycle().catch((error) => handleContextError(error));
      } catch (error) {
        handleContextError(error);
      }
    }, 1000);
  }

  function createEmptyState() {
    return {
      selectedNodeId: null,
      collapsed: false,
      viewMode: VIEW_MODE.MAP,
      mode: "lite",
      liteOpen: true,
      liteDock: { x: null, y: 180, side: "right" },
      compactDock: { x: null, y: 84, side: "right" },
      panelDock: { x: null, y: 84, side: "right" },
      autoRefresh: true,
      minimalMode: false,
      searchQuery: "",
      panel: { width: 380, height: 500 },
      nodes: []
    };
  }

  function normalizeState() {
    if (!appState || typeof appState !== "object") appState = createEmptyState();
    if (!Array.isArray(appState.nodes)) appState.nodes = [];
    if (!appState.viewMode) appState.viewMode = VIEW_MODE.MAP;
    appState.mode = "lite";
    if (typeof appState.liteOpen !== "boolean") appState.liteOpen = true;
    if (!appState.liteDock || typeof appState.liteDock !== "object") {
      appState.liteDock = { x: null, y: 180, side: "right" };
    }
    if (!["left", "right"].includes(appState.liteDock.side)) appState.liteDock.side = "right";
    if (!(Number.isFinite(appState.liteDock.x) || appState.liteDock.x === null)) appState.liteDock.x = null;
    if (!Number.isFinite(appState.liteDock.y)) appState.liteDock.y = 180;
    if (!appState.compactDock || typeof appState.compactDock !== "object") {
      appState.compactDock = { x: null, y: 84, side: "right" };
    }
    if (!["left", "right"].includes(appState.compactDock.side)) appState.compactDock.side = "right";
    if (!(Number.isFinite(appState.compactDock.x) || appState.compactDock.x === null)) appState.compactDock.x = null;
    if (!Number.isFinite(appState.compactDock.y)) appState.compactDock.y = 84;
    if (!appState.panelDock || typeof appState.panelDock !== "object") {
      appState.panelDock = { x: null, y: 84, side: "right" };
    }
    if (!(Number.isFinite(appState.panelDock.x) || appState.panelDock.x === null)) appState.panelDock.x = null;
    if (!Number.isFinite(appState.panelDock.y)) appState.panelDock.y = 84;
    if (!["left", "right"].includes(appState.panelDock.side)) appState.panelDock.side = "right";
    if (typeof appState.autoRefresh !== "boolean") appState.autoRefresh = true;
    if (!appState.panel) appState.panel = { width: 380, height: 500 };
    appState.panel.width = clamp(Number(appState.panel.width) || 380, PANEL.minWidth, PANEL.maxWidth);
    appState.panel.height = clamp(Number(appState.panel.height) || 500, PANEL.minHeight, PANEL.maxHeight);
    if (typeof appState.searchQuery !== "string") appState.searchQuery = "";
    if (typeof appState.minimalMode !== "boolean") appState.minimalMode = false;
    appState.nodes = appState.nodes.map((n) => ({
      ...n,
      collapsed: Boolean(n.collapsed),
      type: n.type || detectNodeType(n.fullText || n.snippet || "", n.role),
      title: n.title || autoTitle(n.fullText || n.snippet || "", n.role)
    }));
  }

  function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

  function getConversationId() {
    const m = location.pathname.match(/\/c\/([^/?#]+)/);
    return m ? m[1] : "temporary-chat";
  }

  function getStorageKey() { return `${STORAGE_PREFIX}:${conversationId}`; }

  function handleLocationMaybeChanged() {
    if (!isExtensionContextAlive()) return;
    if (location.pathname === lastPathname) return;
    lastPathname = location.pathname;
    conversationId = getConversationId();
    void (async () => {
      await loadState();
      normalizeState();
      ensureRoot();
      scanMessages();
      await handleBranchLifecycle();
      await maybeApplyReturnTarget();
      render();
    })().catch((error) => handleContextError(error));
  }

  async function loadState() {
    const stored = await safeStorageGet(getStorageKey());
    appState = stored[getStorageKey()] || createEmptyState();
  }

  async function saveState() {
    await safeStorageSet({ [getStorageKey()]: appState });
  }

  async function getGlobalStorage(keys) {
    return safeStorageGet(keys);
  }

  async function setGlobalStorage(obj) {
    return safeStorageSet(obj);
  }

  function isExtensionContextAlive() {
    try {
      return typeof chrome !== "undefined" && Boolean(chrome.runtime && chrome.runtime.id && chrome.storage && chrome.storage.local);
    } catch (error) {
      return false;
    }
  }

  function isContextInvalidatedError(error) {
    const text = String((error && (error.message || error)) || "");
    return /Extension context invalidated|Receiving end does not exist|The message port closed before/i.test(text);
  }

  function handleContextError(error) {
    if (isContextInvalidatedError(error)) {
      return;
    }
    console.error("[cg-branch-map] unexpected error", error);
  }

  function installGlobalErrorGuards() {
    if (errorGuardInstalled) return;
    errorGuardInstalled = true;
    window.addEventListener("unhandledrejection", (event) => {
      if (isContextInvalidatedError(event.reason)) {
        event.preventDefault();
      }
    });
    window.addEventListener("error", (event) => {
      if (isContextInvalidatedError(event.error || event.message)) {
        event.preventDefault();
      }
    });
  }

  async function safeStorageGet(keys) {
    if (!isExtensionContextAlive()) return {};
    try {
      return await chrome.storage.local.get(keys);
    } catch (error) {
      handleContextError(error);
      return {};
    }
  }

  async function safeStorageSet(obj) {
    if (!isExtensionContextAlive()) return;
    try {
      await chrome.storage.local.set(obj);
    } catch (error) {
      handleContextError(error);
    }
  }

  function ensureRoot() {
    if (rootEl && document.body.contains(rootEl)) return;
    rootEl = document.createElement("aside");
    rootEl.id = ROOT_ID;
    rootEl.className = "cg-branch-map-root";
    document.body.appendChild(rootEl);
    render();
  }

  function installObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver((mutations) => {
      if (!appState.autoRefresh) return;
      if (suppressObserver) return;
      if (isOnlyPluginMutations(mutations)) return;
      clearTimeout(scanTimer);
      scanTimer = setTimeout(scanMessages, 280);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function isOnlyPluginMutations(mutations) {
    const hasNonPluginNode = (node) => {
      if (!node || node.nodeType !== 1) return false;
      const el = node;
      if (el.id === ROOT_ID) return false;
      if (el.classList && Array.from(el.classList).some((cls) => cls.startsWith("cg-branch-") || cls.startsWith("cg-lite-"))) {
        return false;
      }
      if (el.closest && el.closest(`#${ROOT_ID}`)) return false;
      if (el.closest && el.closest(".cg-branch-toast")) return false;
      return true;
    };

    for (const mutation of mutations) {
      if (mutation.target && mutation.target.nodeType === 1) {
        const target = mutation.target;
        if (target.closest && target.closest(`#${ROOT_ID}`)) continue;
      }
      for (const node of mutation.addedNodes || []) {
        if (hasNonPluginNode(node)) return false;
      }
      for (const node of mutation.removedNodes || []) {
        if (hasNonPluginNode(node)) return false;
      }
    }
    return true;
  }

  function getRole(el) {
    const attr = el.getAttribute("data-message-author-role");
    if (attr) return attr;
    const childRoleEl = el.querySelector && el.querySelector("[data-message-author-role]");
    if (childRoleEl) {
      const childRole = childRoleEl.getAttribute("data-message-author-role");
      if (childRole) return childRole;
    }
    const txt = el.innerText || "";
    if (/^chatgpt|^assistant/i.test(txt)) return "assistant";
    return el.className && String(el.className).toLowerCase().includes("user") ? "user" : null;
  }

  function cleanText(text) { return String(text || "").replace(/\s+/g, " ").trim(); }

  function readMessageText(el) {
    if (!el) return "";
    const cloned = el.cloneNode(true);
    cloned.querySelectorAll(".cg-branch-tag-btn").forEach((btn) => btn.remove());
    return cleanText(cloned.innerText || cloned.textContent || "");
  }

  function simpleHash(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) {
      hash = (hash << 5) - hash + text.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  }

  function findMessages() {
    const candidates = collectMessageCandidates();
    const deduped = [];
    const seenFingerprints = new Set();
    const seenTurnIds = new Set();

    candidates.forEach((el, index) => {
      const role = getRole(el) || (index % 2 === 0 ? "user" : "assistant");
      const text = readMessageText(el);
      if (!text) return;
      const turnHost = el.closest && el.closest('article[data-testid^="conversation-turn-"],article[data-testid*="conversation-turn"]');
      const turnId = (turnHost && turnHost.getAttribute("data-testid")) || el.getAttribute("data-testid");
      if (turnId) {
        if (seenTurnIds.has(turnId)) return;
        seenTurnIds.add(turnId);
      }
      const fingerprint = `${role}|${simpleHash(text.slice(0, 2000))}`;
      if (seenFingerprints.has(fingerprint)) return;
      seenFingerprints.add(fingerprint);
      deduped.push({ el, role, text });
    });

    const occurrences = new Map();
    return deduped.map(({ el, role, text }, index) => {
      const hash = simpleHash(`${role}|${text.slice(0, 1500)}`);
      const count = (occurrences.get(hash) || 0) + 1;
      occurrences.set(hash, count);
      const key = `${role}:${hash}:${count}`;
      const anchorId = `cg-msg-${index}-${hash}`;
      el.dataset.cgBranchKey = key;
      el.dataset.cgBranchHash = hash;
      el.dataset.cgBranchAnchor = anchorId;
      return { element: el, key, hash, anchorId, role, index, text };
    });
  }

  function collectMessageCandidates() {
    const seen = new Set();
    const turnContainers = [];

    document.querySelectorAll('article[data-testid^="conversation-turn-"],article[data-testid*="conversation-turn"]').forEach((el) => {
      const container = normalizeMessageContainer(el);
      if (!container || seen.has(container)) return;
      seen.add(container);
      turnContainers.push(container);
    });
    if (turnContainers.length) return turnContainers;

    const roleContainers = [];

    document.querySelectorAll('[data-message-author-role]').forEach((el) => {
      const container = normalizeMessageContainer(el);
      if (!container || seen.has(container)) return;
      seen.add(container);
      roleContainers.push(container);
    });
    if (roleContainers.length) {
      return roleContainers;
    }

    const unique = [];
    for (const selector of MESSAGE_SELECTORS) {
      document.querySelectorAll(selector).forEach((el) => {
        const container = normalizeMessageContainer(el);
        if (!container) return;
        if (seen.has(container)) return;
        seen.add(container);
        unique.push(container);
      });
    }
    if (unique.length) return unique;

    const fallback = [];
    document.querySelectorAll("main article").forEach((el) => {
      const container = normalizeMessageContainer(el);
      if (!container || seen.has(container)) return;
      const text = readMessageText(container);
      if (!text) return;
      seen.add(container);
      fallback.push(container);
    });
    return fallback;
  }

  function normalizeMessageContainer(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.closest && el.closest(`#${ROOT_ID}`)) return null;
    let container =
      el.closest('[data-message-author-role]') ||
      el.closest('article[data-testid^="conversation-turn-"]') ||
      el.closest('article[data-testid*="conversation-turn"]') ||
      el;
    if (!container) return null;

    if (container.hasAttribute("data-message-author-role")) {
      let parentWithRole = container.parentElement ? container.parentElement.closest('[data-message-author-role]') : null;
      while (parentWithRole) {
        container = parentWithRole;
        parentWithRole = container.parentElement ? container.parentElement.closest('[data-message-author-role]') : null;
      }
    }

    if (!container.closest("main")) return null;
    if (!container || (container.closest && container.closest(`#${ROOT_ID}`))) return null;
    if (!isElementActuallyVisible(container)) return null;
    const text = readMessageText(container);
    if (!text) return null;
    return container;
  }

  function isElementActuallyVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = window.getComputedStyle(el);
    if (!style) return false;
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 8 && rect.height > 8;
  }

  function getButtonHost(messageEl) {
    if (!messageEl) return null;
    if (messageEl.matches && messageEl.matches("[data-message-author-role]")) {
      return messageEl;
    }
    const roleBox = messageEl.querySelector && messageEl.querySelector("[data-message-author-role]");
    if (roleBox) return roleBox;
    const prose = messageEl.querySelector && messageEl.querySelector(".markdown, [class*='prose'], [data-message-content]");
    if (prose) {
      const proseRole = prose.closest && prose.closest("[data-message-author-role]");
      return proseRole || prose;
    }
    const article = messageEl.closest("article");
    return article || messageEl;
  }

  function scanMessages() {
    suppressObserver = true;
    cachedMessages = findMessages();
    injectTagButtons(cachedMessages);
    syncNodesWithMessages(cachedMessages);
    if (!cachedMessages.length) {
      showToast("未扫描到消息，请先打开一条有内容的对话。");
    } else {
      const questionCount = countQuestionMessages(cachedMessages);
      showToast(`已扫描 ${cachedMessages.length} 条消息（提问 ${questionCount} 条）。`);
    }
    render();
    setTimeout(() => { suppressObserver = false; }, 80);
  }

  function injectTagButtons(messages) {
    messages.forEach((message) => {
      const host = getButtonHost(message.element);
      if (!host) return;
      host.classList.add("cg-branch-tag-host");

      let button = host.querySelector(".cg-branch-tag-btn");
      if (message.role !== "assistant") {
        if (button) button.remove();
        host.classList.remove("cg-branch-tag-host-pinned");
        host.classList.remove("cg-branch-tag-host-visible");
        return;
      }
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.className = "cg-branch-tag-btn";
        host.appendChild(button);
      }

      if (!host.dataset.cgTagDelayBound) {
        host.dataset.cgTagDelayBound = "true";
        host.addEventListener("mouseenter", () => {
          if (host._cgTagHideTimer) {
            clearTimeout(host._cgTagHideTimer);
            host._cgTagHideTimer = null;
          }
          host.classList.add("cg-branch-tag-host-visible");
        });
        host.addEventListener("mouseleave", () => {
          if (host.classList.contains("cg-branch-tag-host-pinned")) return;
          if (host._cgTagHideTimer) clearTimeout(host._cgTagHideTimer);
          host._cgTagHideTimer = setTimeout(() => {
            host.classList.remove("cg-branch-tag-host-visible");
            host._cgTagHideTimer = null;
          }, 3000);
        });
      }

      const exists = appState.nodes.find((n) =>
        n.messageKey === message.key ||
        (n.anchorId && message.anchorId && n.anchorId === message.anchorId) ||
        (n.messageHash === message.hash && n.role === message.role)
      );
      if (exists) {
        if (host._cgTagHideTimer) {
          clearTimeout(host._cgTagHideTimer);
          host._cgTagHideTimer = null;
        }
        host.classList.add("cg-branch-tag-host-pinned");
        host.classList.add("cg-branch-tag-host-visible");
        button.textContent = "已设节点";
      } else {
        host.classList.remove("cg-branch-tag-host-pinned");
        button.textContent = "设为节点";
      }

      button.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        createNodeFromMessage(message);
      };
    });
  }

  function syncNodesWithMessages(messages) {
    const byKey = new Map(messages.map((m) => [m.key, m]));
    const byHashRole = new Map(messages.map((m) => [`${m.hash}|${m.role}`, m]));
    let changed = false;

    appState.nodes = appState.nodes.map((node) => {
      const exact = byKey.get(node.messageKey);
      const fuzzy = byHashRole.get(`${node.messageHash}|${node.role}`);
      const matched = exact || fuzzy;
      if (!matched) {
        if (!node.missing) changed = true;
        return { ...node, missing: true };
      }
      if (node.messageKey !== matched.key || node.anchorId !== matched.anchorId || node.missing) changed = true;
      return {
        ...node,
        messageKey: matched.key,
        messageHash: matched.hash,
        anchorId: matched.anchorId,
        missing: false
      };
    });

    if (changed) saveState();
  }

  function detectNodeType(text, role) {
    const t = String(text || "");
    if (/```|^\s*(sudo|apt|npm|pnpm|yarn|pip|conda|git|docker|kubectl|SELECT|CREATE|UPDATE|DELETE|const|let|function)\b/im.test(t)) return "code";
    if (role === "user" || /\?|？/.test(t.slice(0, 120))) return "question";
    if (/步骤|首先|其次|最后|总结|原因|建议|方案|解释|分析|1\.|2\./i.test(t.slice(0, 280))) return "explanation";
    return "answer";
  }

  function autoTitle(text, role) {
    const lines = String(text || "").split("\n").map((l) => cleanText(l)).filter(Boolean);
    if (!lines.length) return role === "user" ? "用户提问" : "助手回复";
    const main = (lines.find((l) => !l.startsWith("```")) || lines[0])
      .replace(/^[-*#>\d.\s]+/, "")
      .replace(/^(你说|ChatGPT\s*说|ChatGPT)\s*[:：]\s*/i, "");
    const t = cleanText(main) || (role === "user" ? "用户提问" : "助手回复");
    return t.length > 32 ? `${t.slice(0, 32)}...` : t;
  }

  function typeLabel(type) {
    if (type === "question") return "问题";
    if (type === "code") return "代码";
    if (type === "explanation") return "解释";
    return "回答";
  }

  function findExistingNodeForMessage(message) {
    if (!message) return null;
    return appState.nodes.find((n) =>
      n.messageKey === message.key ||
      (n.anchorId && message.anchorId && n.anchorId === message.anchorId) ||
      (n.messageHash === message.hash && n.role === message.role)
    ) || null;
  }

  function refreshTagButtons() {
    const messages = cachedMessages.length ? cachedMessages : findMessages();
    if (!messages.length) return;
    injectTagButtons(messages);
  }

  function removeNodeById(nodeId) {
    const target = appState.nodes.find((n) => n.id === nodeId);
    if (!target) return false;
    const parentId = target.parentId || null;
    appState.nodes = appState.nodes
      .filter((n) => n.id !== nodeId)
      .map((n) => (n.parentId === nodeId ? { ...n, parentId } : n));
    if (appState.selectedNodeId === nodeId) {
      appState.selectedNodeId = parentId || (appState.nodes[appState.nodes.length - 1]?.id || null);
    }
    return true;
  }

  async function createNodeFromMessage(message) {
    const existing = findExistingNodeForMessage(message);
    if (existing) {
      removeNodeById(existing.id);
      await saveState();
      render();
      refreshTagButtons();
      flashMessage(message.element);
      showToast("已取消该节点。");
      return;
    }

    const selected = appState.nodes.find((n) => n.id === appState.selectedNodeId);
    const node = {
      id: `node_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      parentId: selected ? selected.id : null,
      messageKey: message.key,
      messageHash: message.hash,
      anchorId: message.anchorId,
      role: message.role,
      type: detectNodeType(message.text, message.role),
      title: autoTitle(message.text, message.role),
      snippet: message.text.slice(0, 180),
      fullText: message.text.slice(0, 2000),
      createdAt: new Date().toISOString(),
      missing: false,
      collapsed: false,
      position: null
    };

    appState.nodes.push(node);
    appState.selectedNodeId = node.id;
    await saveState();
    render();
    refreshTagButtons();
    flashMessage(message.element);
    showToast(selected ? "已创建子分支节点。" : "已创建根节点。");
  }

  async function autoBuildTree() {
    const messages = getNavigationMessages();
    if (!messages.length) {
      showToast("没有扫描到可用消息。");
      return;
    }

    const nodes = [];
    let parentId = null;
    let createdIndex = 0;
    messages.forEach((message) => {
      const id = `auto_${createdIndex}_${Math.random().toString(36).slice(2, 6)}`;
      createdIndex += 1;
      nodes.push({
        id,
        parentId,
        messageKey: message.key,
        messageHash: message.hash,
        anchorId: message.anchorId,
        role: message.role,
        type: detectNodeType(message.text, message.role),
        title: autoTitle(message.text, message.role),
        snippet: cleanText(message.text).slice(0, 180),
        fullText: message.text.slice(0, 2000),
        createdAt: new Date(Date.now() + createdIndex).toISOString(),
        missing: false,
        collapsed: false,
        position: null
      });
      parentId = id;
    });

    appState.nodes = nodes;
    appState.selectedNodeId = nodes[nodes.length - 1].id;
    await saveState();
    render();
    showToast(`已自动建树：${nodes.length} 个节点。`);
  }

  function getDescendantSet(nodes, nodeId, set = new Set()) {
    const children = nodes.filter((n) => n.parentId === nodeId);
    children.forEach((child) => {
      set.add(child.id);
      getDescendantSet(nodes, child.id, set);
    });
    return set;
  }

  function getVisibleNodes(nodes, query) {
    const lowered = cleanText(query).toLowerCase();
    const hidden = new Set();
    nodes.forEach((n) => {
      if (n.collapsed) getDescendantSet(nodes, n.id, hidden);
    });

    const base = nodes.filter((n) => !hidden.has(n.id));
    if (!lowered) return base;

    const byId = new Map(nodes.map((n) => [n.id, n]));
    const include = new Set();
    base.forEach((n) => {
      const joined = `${n.title}\n${n.snippet}\n${n.fullText}`.toLowerCase();
      if (joined.includes(lowered)) {
        include.add(n.id);
        let p = n.parentId ? byId.get(n.parentId) : null;
        while (p) {
          include.add(p.id);
          p = p.parentId ? byId.get(p.parentId) : null;
        }
      }
    });
    return base.filter((n) => include.has(n.id));
  }

  function createHeaderButton(label, action, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cg-branch-map-btn";
    btn.dataset.action = action;
    btn.textContent = label;
    btn.onclick = onClick;
    return btn;
  }

  function getSelectedNode() {
    if (!appState.nodes.length) {
      return null;
    }
    return appState.nodes.find((node) => node.id === appState.selectedNodeId) || appState.nodes[appState.nodes.length - 1];
  }

  function getBranchCandidatesFromTaggedNodes() {
    const candidates = appState.nodes
      .map((node) => ({ node, message: getMessageFromNode(node) }))
      .filter((item) => item.message && item.message.element)
      .map((item) => ({
        node: item.node,
        message: item.message,
        title: autoTitle(item.message.text, item.message.role),
        snippet: cleanText(item.message.text).slice(0, 120)
      }));
    candidates.sort((a, b) => new Date(a.node.createdAt || 0) - new Date(b.node.createdAt || 0));
    return candidates;
  }

  function pickBranchCandidate(candidates) {
    return new Promise((resolve) => {
      const old = document.querySelector(".cg-branch-picker-mask");
      if (old) old.remove();

      const mask = document.createElement("div");
      mask.className = "cg-branch-picker-mask";
      const panel = document.createElement("div");
      panel.className = "cg-branch-picker-panel";

      const title = document.createElement("div");
      title.className = "cg-branch-picker-title";
      title.textContent = "选择开分支节点";
      const sub = document.createElement("div");
      sub.className = "cg-branch-picker-subtitle";
      sub.textContent = `检测到 ${candidates.length} 个已设节点，请选择一个作为分支起点。`;

      const list = document.createElement("div");
      list.className = "cg-branch-picker-list";

      candidates.forEach((item, index) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "cg-branch-picker-item";
        btn.innerHTML = `<span>${index + 1}</span><strong>${escapeHtml(item.title || "未命名节点")}</strong><em>${escapeHtml(item.snippet || "")}</em>`;
        btn.onclick = () => close(item);
        list.appendChild(btn);
      });

      const actions = document.createElement("div");
      actions.className = "cg-branch-picker-actions";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "cg-branch-picker-cancel";
      cancel.textContent = "取消";
      cancel.onclick = () => close(null);
      actions.appendChild(cancel);

      panel.append(title, sub, list, actions);
      mask.appendChild(panel);
      document.body.appendChild(mask);

      const onKey = (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          close(null);
        }
      };
      window.addEventListener("keydown", onKey);
      mask.addEventListener("click", (event) => {
        if (event.target === mask) close(null);
      });

      function close(value) {
        window.removeEventListener("keydown", onKey);
        mask.classList.add("cg-branch-picker-leave");
        setTimeout(() => {
          if (mask.parentNode) mask.parentNode.removeChild(mask);
          resolve(value);
        }, 150);
      }
    });
  }

  async function openBranchInCurrentTab() {
    if (branchOpening) {
      showToast("正在尝试打开分支，请稍候...");
      return;
    }
    let node = null;
    let baseMessage = null;
    const candidates = getBranchCandidatesFromTaggedNodes();
    if (candidates.length > 1) {
      const selected = await pickBranchCandidate(candidates);
      if (!selected) {
        showToast("已取消开分支。");
        return;
      }
      node = selected.node;
      baseMessage = selected.message;
      appState.selectedNodeId = node.id;
      await saveState();
      render();
    } else if (candidates.length === 1) {
      node = candidates[0].node;
      baseMessage = candidates[0].message;
    } else {
      node = getSelectedNode();
      baseMessage = node ? getMessageFromNode(node) : getViewportMessage();
    }
    if (!baseMessage) {
      showToast("没有找到可用于开分支的消息。");
      return;
    }

    const global = await getGlobalStorage([GLOBAL_BRANCH_PENDING_KEY]);
    const currentPending = global[GLOBAL_BRANCH_PENDING_KEY];
    if (currentPending && currentPending.status === "awaiting_child_url") {
      const createdAt = new Date(currentPending.createdAt || 0).getTime();
      if (Date.now() - createdAt < 25000) {
        showToast("已在等待新会话创建，请勿重复点击。");
        return;
      }
      await setGlobalStorage({ [GLOBAL_BRANCH_PENDING_KEY]: null });
    }

    const pending = {
      sourceConversationId: conversationId,
      sourceNodeId: node ? node.id : null,
      sourceMessageKey: baseMessage.key,
      status: "awaiting_child_url",
      expiresAt: new Date(Date.now() + 25000).toISOString(),
      createdAt: new Date().toISOString()
    };
    branchOpening = true;
    try {
      const started = await triggerNativeBranch(baseMessage);
      if (!started) {
        showToast("未找到“新聊天中的分支”入口，ChatGPT 页面结构可能已变化。");
        return;
      }
      await setGlobalStorage({ [GLOBAL_BRANCH_PENDING_KEY]: pending });
      showToast("已触发原生分支，正在等待新会话创建...");
    } finally {
      branchOpening = false;
    }
  }

  async function returnToParentConversation() {
    const global = await getGlobalStorage([GLOBAL_BRANCH_LINEAGE_KEY]);
    const lineage = global[GLOBAL_BRANCH_LINEAGE_KEY] || {};
    const link = lineage[conversationId];
    if (!link || !link.parentConversationId) {
      showToast("当前会话没有父会话记录。");
      return;
    }
    await setGlobalStorage({
      [GLOBAL_RETURN_TARGET_KEY]: {
        targetConversationId: link.parentConversationId,
        targetNodeId: link.parentNodeId,
        createdAt: new Date().toISOString()
      }
    });
    showToast("返回父会话中...");
    location.assign(`https://chatgpt.com/c/${link.parentConversationId}`);
  }

  async function handleBranchLifecycle() {
    try {
      if (!isExtensionContextAlive()) return;
      const global = await getGlobalStorage([GLOBAL_BRANCH_PENDING_KEY, GLOBAL_BRANCH_LINEAGE_KEY]);
      const pending = global[GLOBAL_BRANCH_PENDING_KEY];
      if (!pending) {
        return;
      }
      if (pending.expiresAt && Date.now() > new Date(pending.expiresAt).getTime()) {
        await setGlobalStorage({ [GLOBAL_BRANCH_PENDING_KEY]: null });
        showToast("分支创建超时，请重试“开分支”。");
        return;
      }

      if (pending.status === "awaiting_child_url") {
        if (conversationId === "temporary-chat" || conversationId === pending.sourceConversationId) {
          return;
        }
        const lineage = global[GLOBAL_BRANCH_LINEAGE_KEY] || {};
        lineage[conversationId] = {
          parentConversationId: pending.sourceConversationId,
          parentNodeId: pending.sourceNodeId,
          createdAt: new Date().toISOString()
        };
        await setGlobalStorage({
          [GLOBAL_BRANCH_LINEAGE_KEY]: lineage,
          [GLOBAL_BRANCH_PENDING_KEY]: null
        });
        showToast("分支已在当前页创建，可随时返回父会话。");
      }
    } catch (error) {
      handleContextError(error);
      if (isContextInvalidatedError(error)) {
        return;
      }
      throw error;
    }
  }

  function getMessageFromNode(node) {
    if (!node) {
      return null;
    }
    const byKey = cachedMessages.find((message) => message.key === node.messageKey);
    if (byKey) {
      return byKey;
    }
    return cachedMessages.find((message) => message.hash === node.messageHash && message.role === node.role) || null;
  }

  function getViewportMessage() {
    if (!cachedMessages.length) {
      return null;
    }
    const idx = getCurrentViewportMessageIndex();
    return cachedMessages[idx] || cachedMessages[cachedMessages.length - 1];
  }

  async function triggerNativeBranch(message) {
    if (!message || !message.element) {
      return false;
    }
    const host = getButtonHost(message.element) || message.element;
    const turnHost = host.closest("article") || host;

    const tryOpenMenuAndClick = async (menuTrigger) => {
      if (!menuTrigger) return false;
      safeClick(menuTrigger);
      await wait(260);
      const item = findNativeBranchMenuItem();
      if (item) {
        safeClick(item);
        return true;
      }
      return false;
    };

    const selectors = [
      'button[aria-label*="更多"]',
      'button[aria-label*="More"]',
      'button[data-testid*="more"]',
      'button[data-testid*="message-actions"]',
      'button[id*="radix-"][aria-haspopup="menu"]',
      '[role="button"][aria-haspopup="menu"]'
    ];

    for (const selector of selectors) {
      const local = Array.from(turnHost.querySelectorAll(selector)).filter((el) => isElementActuallyVisible(el));
      for (const trigger of local) {
        if (await tryOpenMenuAndClick(trigger)) return true;
      }
    }

    turnHost.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true, cancelable: true }));
    await wait(220);
    for (const selector of selectors) {
      const local = Array.from(turnHost.querySelectorAll(selector)).filter((el) => isElementActuallyVisible(el));
      for (const trigger of local) {
        if (await tryOpenMenuAndClick(trigger)) return true;
      }
    }

    host.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: host.getBoundingClientRect().left + 16, clientY: host.getBoundingClientRect().top + 16 }));
    await wait(260);
    const fallbackItem = findNativeBranchMenuItem();
    if (fallbackItem) {
      safeClick(fallbackItem);
      return true;
    }
    return false;
  }

  function findNativeBranchMenuItem() {
    const menus = Array.from(document.querySelectorAll('[role="menu"],[data-radix-popper-content-wrapper]'));
    const scope = menus.length ? menus : [document];
    const items = scope.flatMap((root) => Array.from(root.querySelectorAll('[role="menuitem"],button,a,div')));
    return items.find((el) => {
      const txt = cleanText(el.textContent || "");
      return /新聊天中的分支|Branch in new chat|分支/i.test(txt);
    }) || null;
  }

  function safeClick(el) {
    if (!el) return;
    const target = el.closest("button,a,[role='menuitem'],[role='button']") || el;
    ["pointerdown", "mousedown", "mouseup", "pointerup", "click"].forEach((type) => {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    });
    if (typeof target.click === "function") target.click();
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function maybeApplyReturnTarget() {
    try {
      if (!isExtensionContextAlive()) return;
      if (conversationId === "temporary-chat") {
        return;
      }
      const global = await getGlobalStorage([GLOBAL_RETURN_TARGET_KEY]);
      const target = global[GLOBAL_RETURN_TARGET_KEY];
      if (!target || target.targetConversationId !== conversationId) {
        return;
      }

      appState.selectedNodeId = target.targetNodeId || appState.selectedNodeId;
      await saveState();
      await setGlobalStorage({ [GLOBAL_RETURN_TARGET_KEY]: null });
      const node = appState.nodes.find((item) => item.id === appState.selectedNodeId);
      if (node) {
        setTimeout(() => jumpToNode(node), 350);
      }
    } catch (error) {
      handleContextError(error);
      if (isContextInvalidatedError(error)) {
        return;
      }
      throw error;
    }
  }

  function render() {
    if (!rootEl) return;

    if (liteViewportSyncCleanup) {
      liteViewportSyncCleanup();
      liteViewportSyncCleanup = null;
    }

    mapRuntime = null;
    if (appState.minimalMode) {
      renderMinimalDock();
      return;
    }
    appState.mode = "lite";
    renderLiteMode();
    return;

    /*
    rootEl.classList.remove("cg-lite-root");
    rootEl.classList.remove("cg-compact-root");
    rootEl.classList.remove("cg-compact-left");
    rootEl.classList.remove("cg-compact-right");
    rootEl.dataset.collapsed = String(Boolean(appState.collapsed));
    rootEl.dataset.minimal = "false";
    rootEl.style.width = `${appState.panel.width}px`;
    rootEl.style.height = appState.collapsed ? "64px" : `${appState.panel.height}px`;
    if (appState.collapsed) {
      applyCompactDockPosition();
      rootEl.classList.add("cg-compact-root");
      rootEl.classList.toggle("cg-compact-left", appState.compactDock.side === "left");
      rootEl.classList.toggle("cg-compact-right", appState.compactDock.side !== "left");
    } else {
      applyPanelDockPosition();
    }
    rootEl.innerHTML = "";

    const header = document.createElement("div");
    header.className = "cg-branch-map-header";

    const title = document.createElement("div");
    title.className = "cg-branch-map-title";
    title.innerHTML = `<strong>对话分支图</strong><span>${conversationId}</span>`;

    const actions = document.createElement("div");
    actions.className = "cg-branch-map-actions";

    actions.append(
      createHeaderButton("刷新", "refresh", () => scanMessages()),
      createHeaderButton(appState.autoRefresh ? "自动开" : "自动关", "auto", async () => {
        appState.autoRefresh = !appState.autoRefresh;
        await saveState();
        render();
      }),
      createHeaderButton(appState.viewMode === VIEW_MODE.MAP ? "树形" : "脑图", "mode", async () => {
        appState.viewMode = appState.viewMode === VIEW_MODE.MAP ? VIEW_MODE.TREE : VIEW_MODE.MAP;
        await saveState();
        render();
      }),
      createHeaderButton("建树", "build", () => autoBuildTree()),
      createHeaderButton("开分支", "branch", () => openBranchInCurrentTab()),
      createHeaderButton("返回父", "back", () => returnToParentConversation()),
      createHeaderButton("轻量", "lite", async () => {
        appState.mode = "lite";
        appState.minimalMode = false;
        await saveState();
        render();
      }),
      createHeaderButton("极简", "minimal", async () => {
        appState.minimalMode = true;
        await saveState();
        render();
      }),
      createHeaderButton("清空", "clear", async () => {
        if (!window.confirm("要清空当前这条 ChatGPT 对话的分支图吗？")) return;
        appState = createEmptyState();
        await saveState();
        scanMessages();
        showToast("当前会话图谱已清空。");
      }),
      createHeaderButton(appState.collapsed ? "展开" : "收起", "toggle", async () => {
        appState.collapsed = !appState.collapsed;
        await saveState();
        render();
      })
    );

    header.append(title, actions);
    rootEl.appendChild(header);
    if (appState.collapsed) {
      installCompactDockDrag(header);
    } else {
      installAdvancedPanelDrag(header);
    }

    const body = document.createElement("div");
    body.className = "cg-branch-map-body";

    const tools = document.createElement("div");
    tools.className = "cg-branch-tool-row";
    const search = document.createElement("input");
    search.className = "cg-branch-search";
    search.placeholder = "搜索节点...";
    search.value = appState.searchQuery;
    let imeComposing = false;
    search.onkeydown = (event) => {
      event.stopPropagation();
    };
    search.addEventListener("compositionstart", () => {
      imeComposing = true;
    });
    search.addEventListener("compositionend", (event) => {
      imeComposing = false;
      const inputEl = event.target;
      appState.searchQuery = String(inputEl.value || "");
      pendingSearchFocus = {
        value: appState.searchQuery,
        start: Number.isFinite(inputEl.selectionStart) ? inputEl.selectionStart : null,
        end: Number.isFinite(inputEl.selectionEnd) ? inputEl.selectionEnd : null
      };
      render();
    });
    search.oninput = (e) => {
      const inputEl = e.target;
      if (imeComposing || e.isComposing) return;
      appState.searchQuery = String(inputEl.value || "");
      pendingSearchFocus = {
        value: appState.searchQuery,
        start: Number.isFinite(inputEl.selectionStart) ? inputEl.selectionStart : null,
        end: Number.isFinite(inputEl.selectionEnd) ? inputEl.selectionEnd : null
      };
      render();
    };
    tools.appendChild(search);
    body.appendChild(tools);
    body.appendChild(renderNavigatorBar());

    if (!appState.nodes.length) {
      const empty = document.createElement("div");
      empty.className = "cg-branch-empty";
      empty.innerHTML = "<div>把鼠标移到某条消息上，点击“设为节点”。</div><div>或者点“建树”，自动生成基础结构。</div>";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cg-branch-empty-btn";
      btn.textContent = "扫描当前消息";
      btn.onclick = () => scanMessages();
      empty.appendChild(btn);
      body.appendChild(empty);
    } else {
      const visible = getVisibleNodes(appState.nodes, appState.searchQuery);
      if (!visible.length) {
        const none = document.createElement("div");
        none.className = "cg-branch-empty";
        none.innerHTML = "<div>没有匹配节点，换个关键词试试。</div>";
        body.appendChild(none);
      } else if (appState.viewMode === VIEW_MODE.MAP) {
        renderMapView(body, visible);
      } else {
        const tree = document.createElement("div");
        tree.className = "cg-branch-tree";
        renderNodeChildren(tree, null, 0, new Set(visible.map((n) => n.id)));
        body.appendChild(tree);
      }
    }

    rootEl.appendChild(body);
    if (!appState.collapsed) {
      installResizeHandles();
    }
    restorePendingSearchFocus();
    */
  }

  function restorePendingSearchFocus() {
    if (!pendingSearchFocus) return;
    const state = pendingSearchFocus;
    pendingSearchFocus = null;
    const input = rootEl ? rootEl.querySelector(".cg-lite-search, .cg-branch-search") : null;
    if (!input) return;
    input.focus({ preventScroll: true });
    if (typeof state.start === "number" && typeof state.end === "number") {
      const max = input.value.length;
      const start = clamp(state.start, 0, max);
      const end = clamp(state.end, 0, max);
      input.setSelectionRange(start, end);
    } else {
      const max = input.value.length;
      input.setSelectionRange(max, max);
    }
  }

  function renderLiteMode() {
    rootEl.classList.add("cg-lite-root");
    rootEl.classList.toggle("cg-lite-left", appState.liteDock.side === "left");
    rootEl.classList.toggle("cg-lite-right", appState.liteDock.side !== "left");
    rootEl.dataset.collapsed = "false";
    rootEl.dataset.minimal = "false";
    rootEl.innerHTML = "";
    rootEl.style.width = "auto";
    rootEl.style.height = "auto";
    rootEl.style.top = `${clamp(appState.liteDock.y, 12, Math.max(12, window.innerHeight - 70))}px`;
    const dockX = Number.isFinite(appState.liteDock.x)
      ? clamp(appState.liteDock.x, 8, Math.max(8, window.innerWidth - 360))
      : null;
    rootEl.style.left = "";
    rootEl.style.right = "";
    if (dockX !== null) {
      rootEl.style.left = `${dockX}px`;
    } else if (appState.liteDock.side === "left") {
      rootEl.style.left = "12px";
    } else {
      rootEl.style.right = "12px";
    }

    const eye = document.createElement("button");
    eye.type = "button";
    eye.className = "cg-lite-eye";
    eye.title = appState.liteOpen ? "隐藏问题栏" : "显示问题栏";
    eye.textContent = appState.liteOpen ? "🙈" : "👁";
    eye.onclick = async () => {
      if (eye.dataset.dragMoved === "true") {
        eye.dataset.dragMoved = "false";
        return;
      }
      appState.liteOpen = !appState.liteOpen;
      await saveState();
      render();
    };
    rootEl.appendChild(eye);
    installLiteEyeDrag(eye);

    if (!appState.liteOpen) return;

    const panel = document.createElement("div");
    panel.className = "cg-lite-panel";

    const head = document.createElement("div");
    head.className = "cg-lite-head";
    const title = document.createElement("div");
    title.className = "cg-lite-title";
    title.innerHTML = "<strong>问题栏</strong><span>快速定位提问点</span>";

    const actions = document.createElement("div");
    actions.className = "cg-lite-actions";
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "cg-lite-btn";
    refresh.textContent = "扫描";
    refresh.onclick = () => scanMessages();

    const branch = document.createElement("button");
    branch.type = "button";
    branch.className = "cg-lite-btn";
    branch.textContent = "开分支";
    branch.onclick = () => openBranchInCurrentTab();

    const minimal = document.createElement("button");
    minimal.type = "button";
    minimal.className = "cg-lite-btn";
    minimal.textContent = "极简";
    minimal.onclick = async () => {
      appState.minimalMode = true;
      await saveState();
      render();
    };
    actions.append(refresh, branch, minimal);
    head.append(title, actions);
    panel.appendChild(head);

    const searchWrap = document.createElement("div");
    searchWrap.className = "cg-lite-search-wrap";
    const search = document.createElement("input");
    search.className = "cg-branch-search cg-lite-search";
    search.placeholder = "搜索节点...";
    search.value = appState.searchQuery;
    let imeComposing = false;
    search.onkeydown = (event) => event.stopPropagation();
    search.addEventListener("compositionstart", () => {
      imeComposing = true;
    });
    search.addEventListener("compositionend", (event) => {
      imeComposing = false;
      const inputEl = event.target;
      appState.searchQuery = String(inputEl.value || "");
      pendingSearchFocus = {
        value: appState.searchQuery,
        start: Number.isFinite(inputEl.selectionStart) ? inputEl.selectionStart : null,
        end: Number.isFinite(inputEl.selectionEnd) ? inputEl.selectionEnd : null
      };
      render();
    });
    search.oninput = (event) => {
      const inputEl = event.target;
      if (imeComposing || event.isComposing) return;
      appState.searchQuery = String(inputEl.value || "");
      pendingSearchFocus = {
        value: appState.searchQuery,
        start: Number.isFinite(inputEl.selectionStart) ? inputEl.selectionStart : null,
        end: Number.isFinite(inputEl.selectionEnd) ? inputEl.selectionEnd : null
      };
      render();
    };
    searchWrap.appendChild(search);
    panel.appendChild(searchWrap);

    const quick = document.createElement("div");
    quick.className = "cg-lite-quick";
    const topBtn = document.createElement("button");
    topBtn.type = "button";
    topBtn.className = "cg-lite-quick-btn";
    topBtn.textContent = "顶部";
    topBtn.onclick = () => scrollChatTo(0);
    const bottomBtn = document.createElement("button");
    bottomBtn.type = "button";
    bottomBtn.className = "cg-lite-quick-btn";
    bottomBtn.textContent = "底部";
    bottomBtn.onclick = () => scrollChatTo("bottom");
    quick.append(topBtn, bottomBtn);
    panel.appendChild(quick);

    const list = document.createElement("div");
    list.className = "cg-lite-list";
    const allGroups = getNavigationGroups();
    const navGroups = filterNavigationGroups(allGroups, appState.searchQuery);
    if (!navGroups.length) {
      const empty = document.createElement("div");
      empty.className = "cg-lite-empty";
      empty.textContent = appState.searchQuery ? "没有匹配结果。" : "暂无问题，点击“扫描”更新。";
      list.appendChild(empty);
    } else {
      navGroups.forEach((group, index) => {
        const primary = group.user || group.assistant;
        if (!primary) return;
        const item = document.createElement("button");
        item.type = "button";
        item.className = "cg-lite-item";
        item.title = cleanText(primary.text).slice(0, 200);
        item.innerHTML = `<span>${index + 1}</span><strong>${escapeHtml(`${primary.role === "assistant" ? "ChatGPT 说" : "你说"}：${autoTitle(primary.text, primary.role)}`)}</strong>`;
        const focusMessage = group.user || primary;
        item.dataset.messageKey = focusMessage.key || "";
        item.onclick = () => jumpToMessage(focusMessage);

        if (group.user && group.assistant) {
          const sub = document.createElement("button");
          sub.type = "button";
          sub.className = "cg-lite-item-sub";
          if (findExistingNodeForMessage(group.assistant)) {
            sub.dataset.node = "true";
            const marker = document.createElement("span");
            marker.className = "cg-lite-node-marker";
            marker.textContent = "✦";
            sub.appendChild(marker);
          }
          const label = document.createElement("span");
          label.textContent = `ChatGPT：${autoTitle(group.assistant.text, group.assistant.role)}`;
          sub.appendChild(label);
          sub.title = cleanText(group.assistant.text).slice(0, 200);
          sub.onclick = (event) => {
            event.stopPropagation();
            jumpToMessage(group.assistant);
          };
          item.appendChild(sub);
        }
        list.appendChild(item);
      });
    }
    panel.appendChild(list);
    rootEl.appendChild(panel);
    installLiteViewportSync(list);
    restorePendingSearchFocus();
  }

  function installLiteViewportSync(listEl) {
    if (!listEl) return;
    const rows = Array.from(listEl.querySelectorAll(".cg-lite-item"));
    if (!rows.length) return;
    const rowByKey = new Map(rows.map((row) => [row.dataset.messageKey, row]));

    const container = getChatScrollContainer();
    let rafId = 0;

    const update = () => {
      rafId = 0;
      const source = getNavigationMessages().filter((m) => m.role === "user");
      const messages = source.length ? source : getNavigationMessages();
      if (!messages.length) return;
      const currentIndex = getCurrentViewportMessageIndex(messages);
      const current = messages[currentIndex];
      rows.forEach((row) => row.classList.remove("cg-lite-item-current"));
      if (current && rowByKey.has(current.key)) {
        rowByKey.get(current.key).classList.add("cg-lite-item-current");
      }
    };

    const schedule = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(update);
    };

    const onScroll = () => schedule();
    container.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });

    liteViewportSyncCleanup = () => {
      container.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
    };

    schedule();
  }

  function getNavigationMessages() {
    return cachedMessages.length ? cachedMessages : findMessages();
  }

  function getNavigationGroups() {
    const messages = getNavigationMessages();
    const groups = [];
    messages.forEach((message) => {
      if (message.role === "user") {
        groups.push({ user: message, assistant: null });
        return;
      }
      const last = groups[groups.length - 1];
      if (last && last.user && !last.assistant) {
        last.assistant = message;
        return;
      }
      groups.push({ user: null, assistant: message });
    });
    return groups;
  }

  function filterNavigationGroups(groups, rawQuery) {
    const query = cleanText(rawQuery).toLowerCase();
    if (!query) return groups;
    return groups.filter((group) => {
      const u = group.user ? `${group.user.text}\n${group.user.snippet || ""}`.toLowerCase() : "";
      const a = group.assistant ? `${group.assistant.text}\n${group.assistant.snippet || ""}`.toLowerCase() : "";
      return u.includes(query) || a.includes(query);
    });
  }

  function countQuestionMessages(messages) {
    return messages.filter((message) => {
      if (message.role !== "user") return false;
      return Boolean(cleanText(message.text));
    }).length;
  }

  function installLiteEyeDrag(eyeEl) {
    eyeEl.style.touchAction = "none";
    eyeEl.onpointerdown = null;

    const maxX = () => Math.max(8, window.innerWidth - (eyeEl.offsetWidth || 58) - 8);
    const maxY = () => Math.max(8, window.innerHeight - (eyeEl.offsetHeight || 42) - 8);

    if (typeof window.interact === "function") {
      if (eyeEl._cgInteract && typeof eyeEl._cgInteract.unset === "function") {
        eyeEl._cgInteract.unset();
      }

      let dragging = false;
      let x = clamp(rootEl.getBoundingClientRect().left, 8, maxX());
      let y = clamp(rootEl.getBoundingClientRect().top, 8, maxY());

      const dragApi = window.interact(eyeEl).draggable({
        inertia: false,
        listeners: {
          start() {
            dragging = false;
            x = clamp(rootEl.getBoundingClientRect().left, 8, maxX());
            y = clamp(rootEl.getBoundingClientRect().top, 8, maxY());
            eyeEl.classList.add("cg-lite-eye-dragging");
            eyeEl.dataset.dragMoved = "false";
          },
          move(event) {
            dragging = true;
            x = clamp(x + event.dx, 8, maxX());
            y = clamp(y + event.dy, 8, maxY());
            rootEl.style.left = `${x}px`;
            rootEl.style.top = `${y}px`;
            rootEl.style.right = "";
          },
          end() {
            eyeEl.classList.remove("cg-lite-eye-dragging");
            if (!dragging) return;
            eyeEl.dataset.dragMoved = "true";
            const side = x + (eyeEl.offsetWidth || 58) / 2 < window.innerWidth / 2 ? "left" : "right";
            appState.liteDock.side = side;
            appState.liteDock.y = clamp(y, 12, Math.max(12, window.innerHeight - 70));
            appState.liteDock.x = null;
            void saveState().then(() => render()).catch((error) => handleContextError(error));
          }
        }
      });
      eyeEl._cgInteract = dragApi;
      return;
    }

    installLiteEyeDragFallback(eyeEl);
  }

  function installLiteEyeDragFallback(eyeEl) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startTop = 0;
    let startLeft = 0;

    eyeEl.onpointerdown = (event) => {
      if (event.button !== 0) return;
      dragging = false;
      startX = event.clientX;
      startY = event.clientY;
      startTop = clamp(appState.liteDock.y, 12, Math.max(12, window.innerHeight - 70));
      const currentLeft = rootEl.getBoundingClientRect().left;
      startLeft = clamp(currentLeft, 8, Math.max(8, window.innerWidth - 80));
      eyeEl.setPointerCapture(event.pointerId);
      eyeEl.classList.add("cg-lite-eye-dragging");

      const onMove = (mv) => {
        dragging = true;
        const nextTop = clamp(startTop + (mv.clientY - startY), 12, Math.max(12, window.innerHeight - 70));
        const nextLeft = clamp(startLeft + (mv.clientX - startX), 8, Math.max(8, window.innerWidth - 80));
        rootEl.style.top = `${nextTop}px`;
        rootEl.style.left = `${nextLeft}px`;
        rootEl.style.right = "";
      };

      const onUp = async (up) => {
        eyeEl.classList.remove("cg-lite-eye-dragging");
        eyeEl.removeEventListener("pointermove", onMove);
        eyeEl.removeEventListener("pointerup", onUp);
        eyeEl.removeEventListener("pointercancel", onUp);

        if (!dragging) return;
        eyeEl.dataset.dragMoved = "true";
        const snappedSide = up.clientX < window.innerWidth / 2 ? "left" : "right";
        const snappedTop = clamp(startTop + (up.clientY - startY), 12, Math.max(12, window.innerHeight - 70));
        appState.liteDock.side = snappedSide;
        appState.liteDock.y = snappedTop;
        appState.liteDock.x = null;
        await saveState();
        render();
      };

      eyeEl.addEventListener("pointermove", onMove);
      eyeEl.addEventListener("pointerup", onUp);
      eyeEl.addEventListener("pointercancel", onUp);
    };
  }

  function renderMinimalDock() {
    rootEl.classList.add("cg-compact-root");
    rootEl.classList.toggle("cg-compact-left", appState.compactDock.side === "left");
    rootEl.classList.toggle("cg-compact-right", appState.compactDock.side !== "left");
    rootEl.dataset.minimal = "true";
    rootEl.dataset.collapsed = "false";
    rootEl.style.width = "84px";
    rootEl.style.height = "auto";
    applyCompactDockPosition();
    rootEl.innerHTML = "";

    const dock = document.createElement("div");
    dock.className = "cg-branch-mini-dock";

    const expand = document.createElement("button");
    expand.type = "button";
    expand.className = "cg-branch-mini-dock-btn";
    expand.textContent = "展开";
    expand.onclick = async () => {
      appState.minimalMode = false;
      await saveState();
      render();
    };

    const prev = document.createElement("button");
    prev.type = "button";
    prev.className = "cg-branch-mini-dock-btn";
    prev.textContent = "上";
    prev.onclick = () => jumpNeighborMessage(-1);

    const next = document.createElement("button");
    next.type = "button";
    next.className = "cg-branch-mini-dock-btn";
    next.textContent = "下";
    next.onclick = () => jumpNeighborMessage(1);

    const top = document.createElement("button");
    top.type = "button";
    top.className = "cg-branch-mini-dock-btn";
    top.textContent = "顶部";
    top.onclick = () => scrollChatTo(0);

    const bottom = document.createElement("button");
    bottom.type = "button";
    bottom.className = "cg-branch-mini-dock-btn";
    bottom.textContent = "底部";
    bottom.onclick = () => scrollChatTo("bottom");

    dock.append(expand, top, bottom, prev, next);
    rootEl.appendChild(dock);
    installCompactDockDrag(dock);
  }

  function applyCompactDockPosition() {
    rootEl.style.top = `${clamp(appState.compactDock.y, 12, Math.max(12, window.innerHeight - 80))}px`;
    const dockX = Number.isFinite(appState.compactDock.x)
      ? clamp(appState.compactDock.x, 8, Math.max(8, window.innerWidth - 120))
      : null;
    rootEl.style.left = "";
    rootEl.style.right = "";
    if (dockX !== null) {
      rootEl.style.left = `${dockX}px`;
    } else if (appState.compactDock.side === "left") {
      rootEl.style.left = "12px";
    } else {
      rootEl.style.right = "12px";
    }
  }

  function applyPanelDockPosition() {
    const maxX = Math.max(8, window.innerWidth - appState.panel.width - 8);
    const x = Number.isFinite(appState.panelDock.x) ? clamp(appState.panelDock.x, 8, maxX) : null;
    const y = clamp(appState.panelDock.y, 12, Math.max(12, window.innerHeight - 80));
    rootEl.style.top = `${y}px`;
    rootEl.style.left = "";
    rootEl.style.right = "";
    if (x !== null) {
      rootEl.style.left = `${x}px`;
    } else if (appState.panelDock.side === "left") {
      rootEl.style.left = "12px";
    } else {
      rootEl.style.right = "18px";
    }
  }

  function installAdvancedPanelDrag(headerEl) {
    if (!headerEl) return;
    const titleEl = headerEl.querySelector(".cg-branch-map-title");
    if (!titleEl) return;
    titleEl.style.touchAction = "none";

    if (typeof window.interact === "function") {
      if (titleEl._cgInteract && typeof titleEl._cgInteract.unset === "function") {
        titleEl._cgInteract.unset();
      }
      let x = Number.isFinite(appState.panelDock.x)
        ? clamp(appState.panelDock.x, 8, Math.max(8, window.innerWidth - appState.panel.width - 8))
        : clamp(rootEl.getBoundingClientRect().left, 8, Math.max(8, window.innerWidth - appState.panel.width - 8));
      let y = clamp(appState.panelDock.y, 12, Math.max(12, window.innerHeight - 80));

      const api = window.interact(titleEl).draggable({
        listeners: {
          move(event) {
            const maxX = Math.max(8, window.innerWidth - appState.panel.width - 8);
            x = clamp(x + event.dx, 8, maxX);
            y = clamp(y + event.dy, 12, Math.max(12, window.innerHeight - 80));
            rootEl.style.left = `${x}px`;
            rootEl.style.top = `${y}px`;
            rootEl.style.right = "";
          },
          end() {
            const centerX = x + appState.panel.width / 2;
            const snapSide = centerX < window.innerWidth / 2 ? "left" : "right";
            appState.panelDock.side = snapSide;
            appState.panelDock.x = null;
            appState.panelDock.y = y;
            void saveState().then(() => render()).catch((error) => handleContextError(error));
          }
        }
      });
      titleEl._cgInteract = api;
    }

    titleEl.ondblclick = async () => {
      appState.panelDock.side = "right";
      appState.panelDock.x = null;
      appState.panelDock.y = 84;
      await saveState();
      render();
    };
  }

  function installCompactDockDrag(dragHandleEl) {
    if (!dragHandleEl) return;
    dragHandleEl.style.touchAction = "none";
    if (typeof window.interact === "function") {
      if (dragHandleEl._cgInteract && typeof dragHandleEl._cgInteract.unset === "function") {
        dragHandleEl._cgInteract.unset();
      }
      let x = clamp(rootEl.getBoundingClientRect().left, 8, Math.max(8, window.innerWidth - 96));
      let y = clamp(rootEl.getBoundingClientRect().top, 8, Math.max(8, window.innerHeight - 80));
      const api = window.interact(dragHandleEl).draggable({
        listeners: {
          move(event) {
            x = clamp(x + event.dx, 8, Math.max(8, window.innerWidth - 96));
            y = clamp(y + event.dy, 8, Math.max(8, window.innerHeight - 80));
            rootEl.style.left = `${x}px`;
            rootEl.style.top = `${y}px`;
            rootEl.style.right = "";
          },
          end() {
            const side = x + 48 < window.innerWidth / 2 ? "left" : "right";
            appState.compactDock.side = side;
            appState.compactDock.y = clamp(y, 12, Math.max(12, window.innerHeight - 80));
            appState.compactDock.x = null;
            void saveState().then(() => render()).catch((error) => handleContextError(error));
          }
        }
      });
      dragHandleEl._cgInteract = api;
      return;
    }
  }

  function renderNavigatorBar() {
    const wrap = document.createElement("div");
    wrap.className = "cg-branch-nav-wrap";

    const actions = document.createElement("div");
    actions.className = "cg-branch-nav-actions";

    const toTop = document.createElement("button");
    toTop.type = "button";
    toTop.className = "cg-branch-nav-btn";
    toTop.textContent = "顶部";
    toTop.onclick = () => scrollChatTo(0);

    const toBottom = document.createElement("button");
    toBottom.type = "button";
    toBottom.className = "cg-branch-nav-btn";
    toBottom.textContent = "底部";
    toBottom.onclick = () => scrollChatTo("bottom");

    const prevNode = document.createElement("button");
    prevNode.type = "button";
    prevNode.className = "cg-branch-nav-btn";
    prevNode.textContent = "上一条";
    prevNode.onclick = () => jumpNeighborMessage(-1);

    const nextNode = document.createElement("button");
    nextNode.type = "button";
    nextNode.className = "cg-branch-nav-btn";
    nextNode.textContent = "下一条";
    nextNode.onclick = () => jumpNeighborMessage(1);

    actions.append(toTop, toBottom, prevNode, nextNode);
    wrap.appendChild(actions);

    const navMain = document.createElement("div");
    navMain.className = "cg-branch-nav-main";
    const overview = document.createElement("div");
    overview.className = "cg-branch-nav-overview";

    const overviewTitle = document.createElement("div");
    overviewTitle.className = "cg-branch-nav-overview-title";
    overviewTitle.textContent = "对话概述";
    overview.appendChild(overviewTitle);

    const navList = document.createElement("div");
    navList.className = "cg-branch-nav-overview-list";

    const navMessages = getNavigationMessages();
    const allGroups = getNavigationGroups();
    const navGroups = filterNavigationGroups(allGroups, appState.searchQuery);
    const query = cleanText(appState.searchQuery).toLowerCase();
    const currentIndex = getCurrentViewportMessageIndex();
    const currentMessage = navMessages[currentIndex] || null;

    navGroups.forEach((group, index) => {
      const primary = group.user || group.assistant;
      if (!primary) return;
      const row = document.createElement("button");
      row.type = "button";
      row.className = "cg-branch-nav-overview-item";
      row.title = cleanText(primary.text).slice(0, 160);
      row.onclick = () => jumpToMessage(primary);

      const dot = document.createElement("span");
      dot.className = "cg-branch-nav-row-dot";
      dot.dataset.role = group.user ? group.user.role : (group.assistant ? group.assistant.role : "assistant");
      if (currentMessage && ((group.user && currentMessage.key === group.user.key) || (group.assistant && currentMessage.key === group.assistant.key))) {
        dot.dataset.current = "true";
      }

      const text = document.createElement("span");
      text.className = "cg-branch-nav-row-text";
      text.textContent = `${index + 1}. ${primary.role === "assistant" ? "ChatGPT 说" : "你说"}：${autoTitle(primary.text, primary.role)}`;

      row.append(dot, text);

      if (group.user && group.assistant) {
        const sub = document.createElement("button");
        sub.type = "button";
        sub.className = "cg-branch-nav-overview-sub";
        sub.textContent = `ChatGPT：${autoTitle(group.assistant.text, group.assistant.role)}`;
        sub.title = cleanText(group.assistant.text).slice(0, 160);
        if (currentMessage && currentMessage.key === group.assistant.key) {
          sub.dataset.current = "true";
        }
        sub.onclick = (event) => {
          event.stopPropagation();
          jumpToMessage(group.assistant);
        };
        row.appendChild(sub);
      }

      navList.appendChild(row);
    });

    overview.appendChild(navList);

    if (!navGroups.length) {
      const empty = document.createElement("div");
      empty.className = "cg-branch-nav-empty";
      empty.textContent = "暂无消息导航";
      overview.appendChild(empty);
      navMain.appendChild(overview);
      wrap.appendChild(navMain);
      return wrap;
    }
    navMain.append(overview);
    const summary = document.createElement("div");
    summary.className = "cg-branch-nav-summary";
    summary.textContent = query
      ? `消息 ${navMessages.length} 条 · 对话组 ${navGroups.length}/${allGroups.length}`
      : `消息 ${navMessages.length} 条 · 对话组 ${navGroups.length}`;
    wrap.append(navMain, summary);
    return wrap;
  }

  function getCurrentViewportMessageIndex(messages = cachedMessages) {
    if (!messages.length) {
      return 0;
    }
    const container = getChatScrollContainer();
    const centerY = container === window
      ? window.scrollY + window.innerHeight / 2
      : container.scrollTop + container.clientHeight / 2;
    let bestIndex = 0;
    let bestDistance = Number.MAX_SAFE_INTEGER;

    messages.forEach((message, index) => {
      const rect = message.element.getBoundingClientRect();
      const absCenter = container === window
        ? window.scrollY + rect.top + rect.height / 2
        : container.scrollTop + (rect.top - container.getBoundingClientRect().top) + rect.height / 2;
      const distance = Math.abs(absCenter - centerY);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    return bestIndex;
  }

  function getChatScrollContainer() {
    const probe = cachedMessages[0] ? cachedMessages[0].element : null;
    if (probe) {
      let parent = probe.parentElement;
      while (parent) {
        const style = window.getComputedStyle(parent);
        const canScroll = /(auto|scroll)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight + 40;
        if (canScroll) {
          return parent;
        }
        parent = parent.parentElement;
      }
    }

    const candidates = Array.from(document.querySelectorAll("main, div, section")).filter((el) => {
      const style = window.getComputedStyle(el);
      return /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 80;
    });
    if (candidates.length) {
      candidates.sort((a, b) => b.scrollHeight - a.scrollHeight);
      return candidates[0];
    }
    return window;
  }

  function scrollChatTo(target) {
    const container = getChatScrollContainer();
    const maxTop = container === window
      ? Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
      : Math.max(0, container.scrollHeight - container.clientHeight);
    const top = target === "bottom" ? maxTop : 0;
    if (container === window) {
      window.scrollTo({ top, behavior: "smooth" });
      return;
    }
    container.scrollTo({ top, behavior: "smooth" });
  }

  function jumpNeighborMessage(direction) {
    const stepMessages = getNavigationMessages().filter((message) => message.role === "user");
    if (!stepMessages.length) {
      showToast("暂无消息可跳转。");
      return;
    }
    const current = getCurrentViewportMessageIndex(stepMessages);
    if (direction < 0 && current <= 0) {
      showToast("已经到第一条提问。");
      jumpToMessage(stepMessages[0]);
      return;
    }
    if (direction > 0 && current >= stepMessages.length - 1) {
      showToast("已经到最后一条提问。");
      jumpToMessage(stepMessages[stepMessages.length - 1]);
      return;
    }
    const next = clamp(current + direction, 0, stepMessages.length - 1);
    jumpToMessage(stepMessages[next]);
  }

  function jumpNeighborNode(direction) {
    if (!appState.nodes.length) {
      showToast("还没有节点可跳转。");
      return;
    }
    const nodes = [...appState.nodes].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const current = nodes.findIndex((node) => node.id === appState.selectedNodeId);
    const base = current >= 0 ? current : 0;
    const nextIndex = clamp(base + direction, 0, nodes.length - 1);
    const targetNode = nodes[nextIndex];
    appState.selectedNodeId = targetNode.id;
    saveState();
    render();
    jumpToNode(targetNode);
  }

  function jumpToMessage(message) {
    if (!message || !message.element) {
      showToast("该消息当前不可见。");
      return;
    }
    scrollElementToStart(message.element);
    flashMessage(message.element);
  }

  function scrollElementToStart(element) {
    if (!element) return;
    const container = getChatScrollContainer();
    const topOffset = 18;
    if (container === window) {
      const rect = element.getBoundingClientRect();
      const absoluteTop = window.scrollY + rect.top;
      const targetTop = Math.max(0, absoluteTop - topOffset);
      window.scrollTo({ top: targetTop, behavior: "smooth" });
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const relativeTop = container.scrollTop + (elementRect.top - containerRect.top);
    const targetTop = Math.max(0, relativeTop - topOffset);
    container.scrollTo({ top: targetTop, behavior: "smooth" });
  }

  function installResizeHandles() {
    const directions = ["n", "s", "w", "e", "nw", "ne", "sw", "se"];
    directions.forEach((direction) => {
      const handle = document.createElement("div");
      handle.className = `cg-branch-resize-handle cg-branch-resize-${direction}`;
      handle.title = "拖动调整面板大小";
      rootEl.appendChild(handle);
      installResizeHandle(handle, direction);
    });
  }

  function installResizeHandle(handle, direction) {
    handle.onpointerdown = (event) => {
      event.preventDefault();
      const startX = event.clientX;
      const startY = event.clientY;
      const startWidth = appState.panel.width;
      const startHeight = appState.panel.height;
      handle.setPointerCapture(event.pointerId);

      const onMove = (mv) => {
        const dx = mv.clientX - startX;
        const dy = mv.clientY - startY;
        let nextWidth = startWidth;
        let nextHeight = startHeight;

        if (direction.includes("w")) nextWidth = startWidth - dx;
        if (direction.includes("e")) nextWidth = startWidth + dx;
        if (direction.includes("n")) nextHeight = startHeight - dy;
        if (direction.includes("s")) nextHeight = startHeight + dy;

        appState.panel.width = clamp(nextWidth, PANEL.minWidth, PANEL.maxWidth);
        appState.panel.height = clamp(nextHeight, PANEL.minHeight, PANEL.maxHeight);
        rootEl.style.width = `${appState.panel.width}px`;
        rootEl.style.height = `${appState.panel.height}px`;
      };

      const onUp = async () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
        await saveState();
        render();
      };

      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    };
  }

  function renderMapView(container, nodes) {
    const auto = computeAutoLayout(nodes);
    let width = auto.canvasWidth;
    let height = auto.canvasHeight;

    nodes.forEach((n) => {
      if (!n.position) return;
      const x = Number(n.position.x) || 0;
      const y = Number(n.position.y) || 0;
      width = Math.max(width, x + MAP_LAYOUT.cardWidth + MAP_LAYOUT.paddingX);
      height = Math.max(height, y + MAP_LAYOUT.cardHeight + MAP_LAYOUT.paddingY);
    });

    const wrap = document.createElement("div");
    wrap.className = "cg-branch-canvas-wrap";
    const canvas = document.createElement("div");
    canvas.className = "cg-branch-canvas";
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "cg-branch-link-layer");
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    canvas.appendChild(svg);

    const pos = {};
    nodes.forEach((node) => {
      const fallback = auto.positions[node.id] || { x: 12, y: 12 };
      const x = Number.isFinite(node.position && node.position.x) ? node.position.x : fallback.x;
      const y = Number.isFinite(node.position && node.position.y) ? node.position.y : fallback.y;
      pos[node.id] = { x, y };
      const card = renderMapNodeCard(node);
      card.style.left = `${x}px`;
      card.style.top = `${y}px`;
      canvas.appendChild(card);
    });

    wrap.appendChild(canvas);
    container.appendChild(wrap);
    container.appendChild(renderMiniMap(nodes, pos, width, height, wrap));

    mapRuntime = { wrap, canvas, linkLayer: svg, positions: pos, edges: getEdges(nodes), redrawPending: false, saveDebounce: null };
    redrawMapLinks();
  }

  function renderMiniMap(nodes, pos, canvasWidth, canvasHeight, wrap) {
    const box = document.createElement("div");
    box.className = "cg-branch-mini-map";
    box.innerHTML = "<div class='cg-branch-mini-title'>Mini Map</div><div class='cg-branch-mini-tip'>点击或拖动视口快速定位</div>";

    const stage = document.createElement("div");
    stage.className = "cg-branch-mini-stage";
    const stageWidth = 206;
    const stageHeight = 120;
    const scale = Math.min(stageWidth / Math.max(1, canvasWidth), stageHeight / Math.max(1, canvasHeight));

    nodes.forEach((node) => {
      const p = pos[node.id];
      if (!p) return;
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "cg-branch-mini-dot";
      const miniW = Math.max(10, Math.round(MAP_LAYOUT.cardWidth * scale));
      const miniH = Math.max(7, Math.round(MAP_LAYOUT.cardHeight * scale));
      dot.style.left = `${Math.round(p.x * scale)}px`;
      dot.style.top = `${Math.round(p.y * scale)}px`;
      dot.style.width = `${miniW}px`;
      dot.style.height = `${miniH}px`;
      dot.dataset.role = node.role || "assistant";
      if (node.id === appState.selectedNodeId) dot.dataset.selected = "true";
      dot.title = `${node.role === "user" ? "你说" : "ChatGPT"}：${node.title}`;
      dot.textContent = String(nodes.indexOf(node) + 1);
      dot.onclick = () => {
        wrap.scrollTo({
          left: Math.max(0, p.x - wrap.clientWidth / 2 + MAP_LAYOUT.cardWidth / 2),
          top: Math.max(0, p.y - wrap.clientHeight / 2 + MAP_LAYOUT.cardHeight / 2),
          behavior: "smooth"
        });
      };
      stage.appendChild(dot);
    });

    const viewport = document.createElement("div");
    viewport.className = "cg-branch-mini-viewport";
    const update = () => {
      viewport.style.width = `${Math.max(26, wrap.clientWidth * scale)}px`;
      viewport.style.height = `${Math.max(20, wrap.clientHeight * scale)}px`;
      viewport.style.left = `${wrap.scrollLeft * scale}px`;
      viewport.style.top = `${wrap.scrollTop * scale}px`;
    };
    update();
    wrap.onscroll = () => update();
    stage.appendChild(viewport);

    stage.onclick = (event) => {
      if (event.target && event.target.classList && event.target.classList.contains("cg-branch-mini-dot")) return;
      const rect = stage.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const canvasX = x / scale;
      const canvasY = y / scale;
      wrap.scrollTo({
        left: Math.max(0, canvasX - wrap.clientWidth / 2),
        top: Math.max(0, canvasY - wrap.clientHeight / 2),
        behavior: "smooth"
      });
    };

    let draggingViewport = false;
    viewport.onpointerdown = (event) => {
      event.preventDefault();
      event.stopPropagation();
      draggingViewport = true;
      viewport.setPointerCapture(event.pointerId);
    };
    viewport.onpointermove = (event) => {
      if (!draggingViewport) return;
      const rect = stage.getBoundingClientRect();
      const x = clamp(event.clientX - rect.left, 0, rect.width);
      const y = clamp(event.clientY - rect.top, 0, rect.height);
      const canvasX = x / scale;
      const canvasY = y / scale;
      wrap.scrollTo({
        left: Math.max(0, canvasX - wrap.clientWidth / 2),
        top: Math.max(0, canvasY - wrap.clientHeight / 2),
        behavior: "auto"
      });
    };
    const stopDrag = () => { draggingViewport = false; };
    viewport.onpointerup = stopDrag;
    viewport.onpointercancel = stopDrag;

    box.appendChild(stage);
    return box;
  }

  function renderMapNodeCard(node) {
    const el = document.createElement("div");
    el.className = "cg-branch-map-node";
    el.dataset.nodeId = node.id;
    el.dataset.selected = String(node.id === appState.selectedNodeId);
    el.title = node.fullText || node.snippet || node.title;

    const grip = document.createElement("div");
    grip.className = "cg-branch-map-node-grip";
    grip.textContent = "⋮⋮ 拖拽";

    const header = document.createElement("div");
    header.className = "cg-branch-map-node-header";
    header.innerHTML = `<div class='cg-branch-map-node-title'>${escapeHtml(node.title)}</div><div class='cg-branch-map-node-role'>${escapeHtml(typeLabel(node.type))}</div>`;

    const snippet = document.createElement("div");
    snippet.className = "cg-branch-map-node-snippet";
    snippet.textContent = node.missing ? `[原消息暂未匹配] ${node.snippet}` : node.snippet;

    const actions = document.createElement("div");
    actions.className = "cg-branch-map-node-actions";

    const foldBtn = document.createElement("button");
    foldBtn.type = "button";
    foldBtn.className = "cg-branch-node-mini-btn";
    foldBtn.textContent = node.collapsed ? "展开" : "折叠";
    foldBtn.onclick = async (e) => {
      e.stopPropagation();
      node.collapsed = !node.collapsed;
      await saveState();
      render();
    };

    const jumpBtn = document.createElement("button");
    jumpBtn.type = "button";
    jumpBtn.className = "cg-branch-node-link";
    jumpBtn.textContent = "跳到消息";
    jumpBtn.onclick = async (e) => {
      e.stopPropagation();
      appState.selectedNodeId = node.id;
      await saveState();
      render();
      jumpToNode(node);
    };

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "cg-branch-node-copy";
    copyBtn.textContent = "复制继续";
    copyBtn.onclick = (e) => {
      e.stopPropagation();
      copyPromptForNode(node);
    };

    actions.append(foldBtn, jumpBtn, copyBtn);
    el.append(grip, header, snippet, actions);

    el.onclick = async () => {
      if (appState.selectedNodeId === node.id) return;
      appState.selectedNodeId = node.id;
      await saveState();
      render();
    };

    installMapNodeDrag(el, node);
    return el;
  }

  function installMapNodeDrag(el, node) {
    el.style.touchAction = "none";
    el.onpointerdown = (event) => {
      if (event.button !== 0 || event.target.closest("button") || !mapRuntime) return;

      const startX = event.clientX;
      const startY = event.clientY;
      const current = mapRuntime.positions[node.id] || { x: 0, y: 0 };
      const originX = current.x;
      const originY = current.y;
      let moved = false;
      let lastX = event.clientX;
      let lastY = event.clientY;

      el.setPointerCapture(event.pointerId);
      el.classList.add("cg-branch-map-node-dragging");

      const onMove = (mv) => {
        moved = true;
        lastX = mv.clientX;
        lastY = mv.clientY;
        const x = Math.max(6, originX + (mv.clientX - startX));
        const y = Math.max(6, originY + (mv.clientY - startY));
        mapRuntime.positions[node.id] = { x, y };
        node.position = { x, y };
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        scheduleRedrawLinks();
        scheduleMapStateSave();
      };

      const onEnd = async () => {
        if (moved) {
          const dropTarget = findDropTargetNode(lastX, lastY, node.id);
          if (dropTarget && canReparent(node.id, dropTarget)) {
            node.parentId = dropTarget;
            showToast("已重组分支关系。");
            render();
          }
        }
        el.classList.remove("cg-branch-map-node-dragging");
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onEnd);
        el.removeEventListener("pointercancel", onEnd);
        await saveState();
      };

      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onEnd);
      el.addEventListener("pointercancel", onEnd);
    };
  }

  function findDropTargetNode(clientX, clientY, selfNodeId) {
    if (typeof clientX !== "number" || typeof clientY !== "number") {
      return null;
    }
    const elements = document.elementsFromPoint(clientX, clientY);
    const target = elements.find((item) => item.classList && item.classList.contains("cg-branch-map-node"));
    if (!target) {
      return null;
    }
    const targetId = target.dataset.nodeId;
    if (!targetId || targetId === selfNodeId) {
      return null;
    }
    return targetId;
  }

  function canReparent(nodeId, nextParentId) {
    if (!nextParentId || nodeId === nextParentId) {
      return false;
    }
    const descendants = getDescendantSet(appState.nodes, nodeId, new Set());
    if (descendants.has(nextParentId)) {
      return false;
    }
    return true;
  }

  function scheduleRedrawLinks() {
    if (!mapRuntime || mapRuntime.redrawPending) return;
    mapRuntime.redrawPending = true;
    requestAnimationFrame(() => {
      mapRuntime.redrawPending = false;
      redrawMapLinks();
    });
  }

  function scheduleMapStateSave() {
    if (!mapRuntime) return;
    if (mapRuntime.saveDebounce) clearTimeout(mapRuntime.saveDebounce);
    mapRuntime.saveDebounce = setTimeout(() => saveState(), 350);
  }

  function redrawMapLinks() {
    if (!mapRuntime) return;
    const { linkLayer, positions, edges } = mapRuntime;
    linkLayer.innerHTML = "";

    edges.forEach((edge) => {
      const parent = positions[edge.from];
      const child = positions[edge.to];
      if (!parent || !child) return;

      const x1 = parent.x + MAP_LAYOUT.cardWidth - 10;
      const y1 = parent.y + MAP_LAYOUT.cardHeight / 2;
      const x2 = child.x + 10;
      const y2 = child.y + MAP_LAYOUT.cardHeight / 2;
      const cx = Math.max(46, (x2 - x1) * 0.42);
      const d = `M ${x1} ${y1} C ${x1 + cx} ${y1}, ${x2 - cx} ${y2}, ${x2} ${y2}`;

      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", d);
      p.setAttribute("class", "cg-branch-link");
      linkLayer.appendChild(p);
    });
  }

  function getEdges(nodes) {
    const ids = new Set(nodes.map((n) => n.id));
    return nodes.filter((n) => n.parentId && ids.has(n.parentId)).map((n) => ({ from: n.parentId, to: n.id }));
  }

  function computeAutoLayout(nodes) {
    const byParent = new Map();
    const byId = new Map();
    nodes.forEach((n) => {
      byId.set(n.id, n);
      const k = n.parentId || "__root__";
      if (!byParent.has(k)) byParent.set(k, []);
      byParent.get(k).push(n);
    });
    byParent.forEach((arr) => arr.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)));

    const roots = nodes.filter((n) => !n.parentId || !byId.has(n.parentId));
    roots.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    const positions = {};
    const subtree = new Map();
    let cursorY = MAP_LAYOUT.paddingY;
    let maxDepth = 0;
    let maxY = 0;

    function height(id) {
      if (subtree.has(id)) return subtree.get(id);
      const children = byParent.get(id) || [];
      if (!children.length) {
        subtree.set(id, MAP_LAYOUT.rowGap);
        return MAP_LAYOUT.rowGap;
      }
      const sum = children.reduce((acc, c, i) => acc + height(c.id) + (i > 0 ? MAP_LAYOUT.rowGap * 0.26 : 0), 0);
      subtree.set(id, sum);
      return sum;
    }

    function place(node, depth, topY) {
      const kids = byParent.get(node.id) || [];
      const h = height(node.id);
      const y = topY + h / 2 - MAP_LAYOUT.cardHeight / 2;
      const x = MAP_LAYOUT.paddingX + depth * MAP_LAYOUT.levelGap;
      positions[node.id] = { x, y: Math.max(MAP_LAYOUT.paddingY, y) };
      maxDepth = Math.max(maxDepth, depth);
      maxY = Math.max(maxY, positions[node.id].y);

      let childTop = topY;
      kids.forEach((c, i) => {
        place(c, depth + 1, childTop);
        childTop += height(c.id);
        if (i < kids.length - 1) childTop += MAP_LAYOUT.rowGap * 0.26;
      });
    }

    if (!roots.length && nodes.length) roots.push(nodes[0]);
    roots.forEach((root, i) => {
      place(root, 0, cursorY);
      cursorY += height(root.id);
      if (i < roots.length - 1) cursorY += MAP_LAYOUT.rowGap * 0.35;
    });

    return {
      positions,
      canvasWidth: Math.max(740, MAP_LAYOUT.paddingX * 2 + (maxDepth + 1) * MAP_LAYOUT.levelGap + MAP_LAYOUT.cardWidth),
      canvasHeight: Math.max(420, MAP_LAYOUT.paddingY * 2 + maxY + MAP_LAYOUT.cardHeight + 30)
    };
  }

  function renderNodeChildren(container, parentId, depth, visibleIds) {
    const children = appState.nodes.filter((n) => n.parentId === parentId && visibleIds.has(n.id)).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    children.forEach((node) => {
      const box = document.createElement("div");
      box.className = "cg-branch-node";
      box.dataset.depth = String(depth);
      box.dataset.selected = String(node.id === appState.selectedNodeId);
      box.title = node.fullText || node.snippet || node.title;

      const head = document.createElement("div");
      head.className = "cg-branch-node-header";
      head.innerHTML = `<div class='cg-branch-node-title'>${escapeHtml(node.title)}</div><div class='cg-branch-node-role'>${escapeHtml(typeLabel(node.type))}</div>`;

      const sn = document.createElement("div");
      sn.className = "cg-branch-node-snippet";
      sn.textContent = node.missing ? `[原消息暂未匹配到页面] ${node.snippet}` : node.snippet;

      const actions = document.createElement("div");
      actions.className = "cg-branch-node-actions";

      const foldBtn = document.createElement("button");
      foldBtn.type = "button";
      foldBtn.className = "cg-branch-node-mini-btn";
      foldBtn.textContent = node.collapsed ? "展开" : "折叠";
      foldBtn.onclick = async () => {
        node.collapsed = !node.collapsed;
        await saveState();
        render();
      };

      const jumpBtn = document.createElement("button");
      jumpBtn.type = "button";
      jumpBtn.className = "cg-branch-node-link";
      jumpBtn.textContent = "跳到消息";
      jumpBtn.onclick = async () => {
        appState.selectedNodeId = node.id;
        await saveState();
        render();
        jumpToNode(node);
      };

      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "cg-branch-node-copy";
      copyBtn.textContent = "复制继续";
      copyBtn.onclick = () => copyPromptForNode(node);

      actions.append(foldBtn, jumpBtn, copyBtn);
      box.append(head, sn, actions);
      container.appendChild(box);

      if (!node.collapsed) {
        const hasChildren = appState.nodes.some((n) => n.parentId === node.id && visibleIds.has(n.id));
        if (hasChildren) {
          const childWrap = document.createElement("div");
          childWrap.className = "cg-branch-children";
          box.appendChild(childWrap);
          renderNodeChildren(childWrap, node.id, depth + 1, visibleIds);
        }
      }
    });
  }

  function jumpToNode(node) {
    const exactByKey = document.querySelector(`[data-cg-branch-key="${cssEscape(node.messageKey)}"]`);
    const exactByAnchor = node.anchorId ? document.querySelector(`[data-cg-branch-anchor="${cssEscape(node.anchorId)}"]`) : null;
    let target = exactByKey || exactByAnchor;

    if (!target) {
      const all = cachedMessages.length ? cachedMessages : findMessages();
      const byHashRole = all.find((m) => m.hash === node.messageHash && m.role === node.role);
      if (byHashRole) target = byHashRole.element;
    }

    if (!target && node.snippet) {
      const all = cachedMessages.length ? cachedMessages : findMessages();
      const needle = cleanText(node.snippet).slice(0, 42);
      const fuzzy = all.find((m) => cleanText(m.text).includes(needle));
      if (fuzzy) target = fuzzy.element;
    }

    if (!target) {
      showToast("没有在当前页面找到这条消息，请先展开更多历史消息。");
      return;
    }

    scrollElementToStart(target);
    flashMessage(target);
  }

  function flashMessage(el) {
    el.classList.add("cg-branch-highlight");
    setTimeout(() => el.classList.remove("cg-branch-highlight"), 1800);
  }

  async function copyPromptForNode(node) {
    const prompt = [
      "我们回到一个更早的分支节点继续。",
      `目标节点：${node.title}`,
      `相关片段：${node.snippet}`,
      "请基于这个节点继续回答，并把后续其他分支内容视为旁支，不作为当前主线。"
    ].join("\n");

    try {
      await navigator.clipboard.writeText(prompt);
      showToast("已复制“继续该分支”的提示词。");
    } catch (error) {
      showToast("复制失败，浏览器可能限制了剪贴板权限。");
    }
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value).replace(/"/g, '\\"');
  }

  function showToast(text) {
    const existing = document.querySelector(".cg-branch-toast");
    if (existing) existing.remove();
    const toast = document.createElement("div");
    toast.className = "cg-branch-toast";
    toast.textContent = text;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2000);
  }
})();
