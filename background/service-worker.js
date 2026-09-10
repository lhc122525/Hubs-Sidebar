'use strict';
/**
 * Service Worker：
 *  1. 工具栏按钮打开分屏面板（openPanelOnActionClick）
 *  2. 响应悬浮条消息 chrome.sidePanel.open() 真分屏打开并切换应用
 *  3. FrameRulesService —— 依据应用列表维护 declarativeNetRequest 动态规则，
 *     为应用域名剥除 X-Frame-Options / Content-Security-Policy（响应头），
 *     仅作用于 sub_frame，规则 ID 与应用 ID 通过稳定哈希一一映射，增删改时同步清理。
 */

importScripts('../src/shared/defaults.js', '../src/shared/storage.js');

/* =========================================================
 * 工具栏按钮：直接打开面板（兜底无法注入 Content Script 的页面）
 * ========================================================= */
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.error('[Hubs] setPanelBehavior failed:', e));

/* =========================================================
 * 悬浮条 → 打开面板并切换到对应应用
 * ========================================================= */

// 面板开关状态（SW 内存标记；SW 冷启动会重置，届时 open() 幂等兜底）
let panelOpen = false;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  // 面板页面自己汇报开关状态（SW 内存标记，用于 Logo 点击 toggle）
  if (msg.type === 'panel-opened') {
    panelOpen = true;
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'panel-closed') {
    panelOpen = false;
    sendResponse({ ok: true });
    return;
  }

  // Logo 点击 toggle：开着就 close，没开就 open。
  // close 优先用 windowId——面板可能挂在窗口级（工具栏按钮打开），用户切过
  // 标签页后按 tabId 关会关不掉；open() 依然在监听器内同步调用保住手势。
  if (msg.type === 'toggle-panel') {
    const tab = sender.tab || {};
    const openOpts = tab.id != null ? { tabId: tab.id } : {};
    const closeOpts = tab.windowId != null ? { windowId: tab.windowId } : openOpts;
    if (panelOpen) {
      panelOpen = false;
      if (typeof chrome.sidePanel.close !== 'function') {
        console.warn('[Hubs] chrome.sidePanel.close is unavailable on this browser');
        sendResponse({ ok: false, error: 'close unavailable' });
      } else {
        try {
          chrome.sidePanel.close(closeOpts)
            .then(() => sendResponse({ ok: true, opened: false }))
            .catch((e) => {
              console.warn('[Hubs] sidePanel.close failed:', e && e.message);
              panelOpen = true; // 关不掉说明面板还开着，避免开关状态漂移
              sendResponse({ ok: false, error: String(e && e.message) });
            });
        } catch (e) {
          console.warn('[Hubs] sidePanel.close threw:', e && e.message);
          sendResponse({ ok: false, error: String(e && e.message) });
        }
      }
    } else {
      chrome.sidePanel.open(openOpts)
        .then(() => {
          panelOpen = true;
          if (msg.appId) chrome.runtime.sendMessage({ type: 'activate-app', appId: msg.appId }).catch(() => {});
          sendResponse({ ok: true, opened: true });
        })
        .catch((e) => {
          console.warn('[Hubs] sidePanel.open failed:', e && e.message);
          sendResponse({ ok: false, error: String(e && e.message) });
        });
    }
    return true;
  }

  // 面板内点击 Logo：收起边栏（面板页面自己发起，带 windowId 精确关闭）
  if (msg.type === 'close-panel') {
    panelOpen = false;
    if (typeof chrome.sidePanel.close !== 'function') {
      console.warn('[Hubs] chrome.sidePanel.close is unavailable on this browser');
      sendResponse({ ok: false, error: 'close unavailable' });
    } else {
      chrome.sidePanel
        .close({ windowId: msg.windowId })
        .then(() => sendResponse({ ok: true }))
        .catch((e) => {
          console.warn('[Hubs] sidePanel.close failed:', e && e.message);
          panelOpen = true; // 关不掉说明面板还开着，避免开关状态漂移
          sendResponse({ ok: false, error: String(e && e.message) });
        });
    }
    return true;
  }

  // 悬浮条「设置」按钮：打开管理页（openOptionsPage 仅扩展上下文可用，内容脚本转发到这里）
  if (msg.type === 'open-options') {
    chrome.runtime.openOptionsPage()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message) }));
    return true;
  }

  // 悬浮条左键：边栏分屏打开。
  // 关键：在监听器里同步调用 open()（不先 await 别的 API），保住内容脚本
  // 点击携带的用户手势；用 tabId 让浏览器自己解析目标窗口。
  if (msg.type === 'open-panel') {
    const opts = sender.tab && sender.tab.id != null ? { tabId: sender.tab.id } : {};
    chrome.sidePanel.open(opts)
      .then(() => {
        // 面板可能尚未加载完成，激活消息可能丢失——面板加载时会读 lastActiveApp 兜底
        if (msg.appId) {
          chrome.runtime.sendMessage({ type: 'activate-app', appId: msg.appId }).catch(() => {});
        }
        sendResponse({ ok: true });
      })
      .catch((e) => {
        console.warn('[Hubs] sidePanel.open failed:', e && e.message);
        sendResponse({ ok: false, error: String(e && e.message) });
      });
    return true; // 异步 sendResponse
  }

  // 悬浮条启动探测：当前窗口是否小窗（popup）——小窗里不显示悬浮条
  if (msg.type === 'is-popup-window') {
    const wid = sender.tab && sender.tab.windowId;
    if (wid == null) return sendResponse({ ok: true, popup: false });
    chrome.windows
      .get(wid)
      .then((win) => sendResponse({ ok: true, popup: !!win && win.type === 'popup' }))
      .catch(() => sendResponse({ ok: true, popup: false }));
    return true;
  }

  // 悬浮条右键菜单「小窗打开」/「独立窗口」：
  // 小窗 = popup 弹窗（无地址栏/标签）；独立窗口 = 正常浏览器窗口（等同 Ctrl+N），默认小尺寸
  if (msg.type === 'open-window') {
    (async () => {
      try {
        const apps = await HubsStorage.getApps();
        const app = apps.find((a) => a.id === msg.appId);
        if (!app) return sendResponse({ ok: false, error: 'app not found' });
        const isNormal = msg.windowType === 'normal';
        const win = await chrome.windows.create({
          url: app.url,
          type: isNormal ? 'normal' : 'popup',
          width: isNormal ? 480 : 520,
          height: isNormal ? 700 : 720,
          focused: true,
        });
        if (!isNormal) trackPopupWindow(win); // 小窗：登记映射，便于把新开链接拉回
        sendResponse({ ok: true, windowId: win && win.id });
      } catch (e) {
        console.warn('[Hubs] open-window failed:', e && e.message);
        sendResponse({ ok: false, error: String(e && e.message) });
      }
    })();
    return true;
  }
});

/* =========================================================
 * 小窗（popup）内新开链接 → 拉回小窗
 * popup 窗口放不下新标签（浏览器会把 target=_blank 的链接丢到正常
 * 窗口，tabs.move 也不允许移入 popup）。这里监听 tabs.onCreated：
 * 凡是从我们小窗页面打开的新标签，改为在小窗当前标签内原地导航，
 * 并关掉跑到外面的标签。tab→窗口映射存 storage.session，SW 重启可恢复。
 * 局限：带 rel="noopener" 的链接没有 openerTabId，无法识别来源。
 * ========================================================= */
const POPUP_WIN_KEY = 'hubsPopupWindowIds';
const tabToPopup = new Map(); // tabId -> 小窗 windowId
const popupWinIds = new Set();
let popupsLoaded = false;

async function ensurePopupsLoaded() {
  if (popupsLoaded) return;
  popupsLoaded = true;
  let ids = [];
  try {
    const data = await chrome.storage.session.get(POPUP_WIN_KEY);
    ids = data[POPUP_WIN_KEY] || [];
  } catch {}
  for (const id of ids) {
    try {
      const tabs = await chrome.tabs.query({ windowId: id });
      if (!tabs.length) continue; // 窗口已关闭
      popupWinIds.add(id);
      for (const t of tabs) tabToPopup.set(t.id, id);
    } catch {}
  }
}
ensurePopupsLoaded();

async function trackPopupWindow(win) {
  if (!win || win.id == null) return;
  popupWinIds.add(win.id);
  for (const t of win.tabs || []) tabToPopup.set(t.id, win.id);
  try {
    const data = await chrome.storage.session.get(POPUP_WIN_KEY);
    const ids = new Set(data[POPUP_WIN_KEY] || []);
    ids.add(win.id);
    await chrome.storage.session.set({ [POPUP_WIN_KEY]: [...ids] });
  } catch {}
}

chrome.tabs.onCreated.addListener(async (tab) => {
  await ensurePopupsLoaded();
  if (tab.windowId != null && popupWinIds.has(tab.windowId)) {
    tabToPopup.set(tab.id, tab.windowId); // 小窗内部产生的标签
    return;
  }
  if (tab.openerTabId == null) return;
  const winId = tabToPopup.get(tab.openerTabId);
  if (winId == null) return;
  // 从小窗页面打开、被丢到别的窗口 → 原地导航回小窗，关掉跑出去的标签
  try {
    await chrome.tabs.update(tab.openerTabId, { url: tab.pendingUrl || tab.url || 'about:blank', active: true });
    await chrome.tabs.remove(tab.id);
  } catch {}
});

chrome.tabs.onRemoved.addListener((tabId) => tabToPopup.delete(tabId));

chrome.windows.onRemoved.addListener(async (winId) => {
  if (!popupWinIds.has(winId)) return;
  popupWinIds.delete(winId);
  for (const [t, w] of [...tabToPopup]) {
    if (w === winId) tabToPopup.delete(t);
  }
  try {
    const data = await chrome.storage.session.get(POPUP_WIN_KEY);
    const ids = (data[POPUP_WIN_KEY] || []).filter((id) => id !== winId);
    await chrome.storage.session.set({ [POPUP_WIN_KEY]: ids });
  } catch {}
});

/* =========================================================
 * FrameRulesService —— iframe 嵌入放行
 * ========================================================= */
const FrameRulesService = (() => {
  const MAX_ID = 2147483647;

  /**
   * 规则 ID 与应用 ID 建立稳定映射：FNV-1a 哈希，Service Worker 重启后依然一致。
   * 碰撞时顺延，保证同一批规则内不重复。
   */
  function ruleIdForApp(appId) {
    let h = 0x811c9dc5;
    for (let i = 0; i < appId.length; i++) {
      h ^= appId.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return (h % (MAX_ID - 1)) + 1;
  }

  function buildRule(app, usedIds) {
    let hostname;
    try {
      hostname = new URL(app.url).hostname;
    } catch {
      return null;
    }
    if (!hostname) return null;

    let id = ruleIdForApp(app.id);
    while (usedIds.has(id)) id = (id % (MAX_ID - 1)) + 1;
    usedIds.add(id);

    // 同时覆盖父域：requestDomains 只匹配该域及其子域，www.bing.com 重定向到
    // cn.bing.com / bing.com 时若没列父域，响应头不会被剥，iframe 直接被拦
    const domains = new Set([hostname]);
    const parts = hostname.split('.');
    if (parts.length > 2) domains.add(parts.slice(1).join('.'));

    return {
      id,
      priority: 1,
      condition: {
        // 命中该域（含子域）的子框架请求
        requestDomains: [...domains],
        resourceTypes: ['sub_frame'],
      },
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'X-Frame-Options', operation: 'remove' },
          { header: 'Frame-Options', operation: 'remove' },
          // DNR 只能整头移除，无法只摘 frame-ancestors 指令，故整条移除
          { header: 'Content-Security-Policy', operation: 'remove' },
        ],
      },
    };
  }

  /**
   * 全量重建动态规则：删旧 → 加新（分两步，避免同一 ID 同时出现在
   * removeRuleIds 与 addRules 引发的原子性冲突）。
   * 卸载/删除应用后其规则自然不在新列表中，即被清理。
   */
  async function syncRules(apps) {
    const usedIds = new Set();
    const rules = [];
    for (const app of apps) {
      const rule = buildRule(app, usedIds);
      if (rule) rules.push(rule);
    }

    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const existingIds = existing.map((r) => r.id);

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existingIds,
      addRules: [],
    });
    if (rules.length) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [],
        addRules: rules,
      });
    }
    console.log('[Hubs] DNR rules synced:', rules.map((r) => `${r.id}:${r.condition.requestDomains.join(',')}`).join(' | '));
  }

  return { syncRules, ruleIdForApp };
})();

/* =========================================================
 * 应用列表变更 → 重建放行规则（storage.onChanged 驱动，去抖）
 * ========================================================= */
let syncTimer = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !changes[HubsStorage.KEY_APPS]) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    try {
      await FrameRulesService.syncRules(await HubsStorage.getApps());
    } catch (e) {
      console.error('[Hubs] syncRules failed:', e);
    }
  }, 300);
});

chrome.runtime.onInstalled.addListener(async () => {
  // 首次安装播种默认应用；随后同步放行规则
  try {
    await FrameRulesService.syncRules(await HubsStorage.getApps());
  } catch (e) {
    console.error('[Hubs] init rules failed:', e);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  // SW 冷启动后重建（规则 ID 哈希稳定，可安全幂等重建）
  try {
    await FrameRulesService.syncRules(await HubsStorage.getApps());
  } catch (e) {
    console.error('[Hubs] startup rules failed:', e);
  }
});
