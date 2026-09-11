'use strict';
/**
 * 分屏面板：应用 Tab 栏 + iframe 视图。
 * - 切换 Tab 用 display:none 隐藏 iframe，不销毁，切回不重新加载
 * - iframe 懒创建：首次激活才加载，避免面板打开时并发拉起全部应用
 * - 应用数据全部走 HubsStorage，storage.onChanged 实时同步增删改
 */

const els = {
  tabs: document.getElementById('tabs'),
  views: document.getElementById('views'),
  spinner: document.getElementById('spinner'),
  empty: document.getElementById('empty'),
  refresh: document.getElementById('btn-refresh'),
  back: document.getElementById('btn-back'),
  forward: document.getElementById('btn-forward'),
  open: document.getElementById('btn-open'),
  manage: document.getElementById('btn-manage'),
  addFirst: document.getElementById('btn-add-first'),
  error: document.getElementById('load-error'),
  errorTitle: document.getElementById('load-error-title'),
  retry: document.getElementById('btn-retry'),
  errorPopup: document.getElementById('btn-error-popup'),
  errorOpen: document.getElementById('btn-error-open'),
  errorStd: document.getElementById('btn-error-std'),
  menu: document.getElementById('tab-menu'),
  menuClose: document.getElementById('tm-close'),
};

let apps = [];
let activeId = null;
let prefsCache = { ...HUBS_DEFAULT_PREFS };
const frames = new Map(); // appId -> iframe
const loadedApps = new Set(); // 已触发过 load 的 appId
const loadTimers = new Map(); // appId -> 加载看门狗 timer
const LOAD_TIMEOUT_MS = 20000; // 超时未 load 视为加载失败（站点拒绝嵌入/卡死）
let dragTab = null; // 正在拖动排序的 Tab
let menuAppId = null; // 右键菜单对应的 appId

/** 头部吸附在左/右两侧时，Tab 栏竖排 */
function isVerticalHeader() {
  const pos = document.body.dataset.pos;
  return pos === 'left' || pos === 'right';
}

/** 应用头部吸附位置偏好到布局 */
function applyHeaderPos(pos) {
  document.body.dataset.pos = pos || 'top';
}

/** 「边栏跳转内部打开」开启时 body 加 nav-internal（前进/后退按钮展示条件之一） */
function applyInternalNav(on) {
  document.body.classList.toggle('nav-internal', on === true);
}

/* ---------------- 渲染 ---------------- */

/** 图标：按 URL 自动取站点 favicon，取不到（error）兜底为首字母色块 */
function iconNode(app) {
  const span = document.createElement('span');
  span.className = 'tab-icon';
  const img = document.createElement('img');
  img.alt = '';
  img.draggable = false;
  img.src = hubsFaviconUrl(app.url);
  img.addEventListener('error', () => {
    img.remove();
    span.textContent = (app.name || '?').trim().charAt(0).toUpperCase() || '?';
    span.classList.add('letter');
    span.style.setProperty('--icon-color', app.color || '#0078d4');
  });
  span.appendChild(img);
  return span;
}

function renderTabs() {
  els.tabs.textContent = '';
  for (const app of apps) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tab' + (app.id === activeId ? ' active' : '');
    btn.dataset.id = app.id;
    btn.title = app.name;
    btn.appendChild(iconNode(app));
    const label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = app.name;
    btn.appendChild(label);
    btn.addEventListener('click', () => activate(app.id));
    // 右键：已打开过（iframe 存在）的 Tab 提供「关闭」
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (frames.has(app.id)) openTabMenu(e, app.id);
    });
    // 拖动排序
    btn.draggable = true;
    btn.addEventListener('dragstart', (e) => {
      dragTab = btn;
      btn.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', app.id);
    });
    btn.addEventListener('dragend', () => {
      btn.classList.remove('dragging');
      if (dragTab) persistTabOrder();
      dragTab = null;
    });
    btn.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!dragTab || dragTab === btn) return;
      // 头部吸附左右时按纵向比较，否则按横向
      const vert = isVerticalHeader();
      const r = btn.getBoundingClientRect();
      const point = vert ? e.clientY : e.clientX;
      const mid = vert ? r.top + r.height / 2 : r.left + r.width / 2;
      els.tabs.insertBefore(dragTab, point < mid ? btn : btn.nextSibling);
    });
    els.tabs.appendChild(btn);
  }

  const empty = apps.length === 0;
  els.empty.hidden = !empty;
  if (empty) {
    els.spinner.hidden = true;
    for (const f of frames.values()) f.hidden = true;
  }
}

/** 拖动结束后按 Tab 栏 DOM 顺序保存应用排序（storage.onChanged 驱动三端同步） */
async function persistTabOrder() {
  const order = [...els.tabs.children].map((b) => b.dataset.id);
  const next = order.map((id) => apps.find((a) => a.id === id)).filter(Boolean);
  if (next.length !== apps.length) return;
  await HubsStorage.saveApps(next);
}

/* ---------------- Tab 右键菜单：关闭打开过的选项卡 ---------------- */

function openTabMenu(e, appId) {
  menuAppId = appId;
  els.menu.hidden = false;
  const x = Math.min(e.clientX, innerWidth - els.menu.offsetWidth - 8);
  const y = Math.min(e.clientY, innerHeight - els.menu.offsetHeight - 8);
  els.menu.style.left = x + 'px';
  els.menu.style.top = y + 'px';
  els.menuClose.focus();
}

function hideTabMenu() {
  els.menu.hidden = true;
  menuAppId = null;
}

/** 关闭选项卡：销毁对应 iframe（释放站点登录态/内存），关的是当前则切到相邻应用 */
function closeApp(id) {
  const frame = frames.get(id);
  if (frame) frame.remove();
  frames.delete(id);
  loadedApps.delete(id);
  clearWatchdog(id);

  if (activeId === id) {
    const idx = apps.findIndex((a) => a.id === id);
    const next = apps[idx + 1] || apps[idx - 1];
    if (next) {
      activate(next.id);
      return;
    }
    activeId = null;
    els.spinner.hidden = true;
    els.error.hidden = true;
    for (const btn of els.tabs.children) btn.classList.remove('active');
    HubsStorage.setPrefs({ lastActiveApp: null }).catch(() => {});
  }
}

els.menuClose.addEventListener('click', () => {
  const id = menuAppId;
  hideTabMenu();
  if (id) closeApp(id);
});
document.addEventListener('click', hideTabMenu);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideTabMenu();
});

/* ---------------- iframe 生命周期 ---------------- */

function ensureFrame(app) {
  let frame = frames.get(app.id);
  if (frame) return frame;

  frame = document.createElement('iframe');
  frame.className = 'app-frame';
  frame.src = app.url;
  // 常用站内能力放行（Copilot 语音/剪贴板等），失败不影响加载
  frame.allow = 'clipboard-read; clipboard-write; camera; microphone; autoplay';
  frame.addEventListener('load', () => {
    loadedApps.add(app.id);
    clearWatchdog(app.id);
    if (app.id === activeId) els.spinner.hidden = true;
  });
  frames.set(app.id, frame);
  els.views.appendChild(frame);
  return frame;
}

function activate(id, { skipSave } = {}) {
  const app = apps.find((a) => a.id === id);
  if (!app) return;

  activeId = id;
  if (!skipSave) HubsStorage.setPrefs({ lastActiveApp: id }).catch(() => {});

  els.empty.hidden = true;
  els.error.hidden = true;
  for (const [appId, frame] of frames) {
    frame.hidden = appId !== id; // display:none，保留状态
  }
  const frame = ensureFrame(app);
  frame.hidden = false;
  const isLoaded = loadedApps.has(id);
  els.spinner.hidden = isLoaded;
  if (!isLoaded) {
    armWatchdog(id, app);
    // 不等页面全部资源加载完：约 0.9s 后先关 loading，让站点展示自己的加载进度
    setTimeout(() => {
      if (activeId === id) els.spinner.hidden = true;
    }, 900);
  }

  for (const btn of els.tabs.children) {
    btn.classList.toggle('active', btn.dataset.id === id);
  }
  // 激活的 Tab 滚入可视区（面板窄 / 应用多超出时）
  const activeBtn = els.tabs.querySelector('.tab.active');
  if (activeBtn) activeBtn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
}

/* ---------------- 加载看门狗：超时提示，转圈不无限等 ---------------- */

function clearWatchdog(id) {
  const t = loadTimers.get(id);
  if (t) {
    clearTimeout(t);
    loadTimers.delete(id);
  }
}

function armWatchdog(id, app) {
  clearWatchdog(id);
  loadTimers.set(
    id,
    setTimeout(() => {
      loadTimers.delete(id);
      if (loadedApps.has(id) || id !== activeId) return;
      showLoadError(app || apps.find((a) => a.id === id));
    }, LOAD_TIMEOUT_MS)
  );
}

function showLoadError(app) {
  if (!app) return;
  els.spinner.hidden = true;
  els.errorTitle.textContent = `「${app.name}」未能加载`;
  els.error.hidden = false;
}

els.retry.addEventListener('click', () => {
  const app = apps.find((a) => a.id === activeId);
  const frame = frames.get(activeId);
  if (!app || !frame) return;
  els.error.hidden = true;
  loadedApps.delete(activeId);
  frame.src = app.url;
  els.spinner.hidden = false;
  armWatchdog(activeId, app);
});

els.errorPopup.addEventListener('click', () => {
  // 小窗 = 真浏览器窗口，无 iframe 限制，站点拒绝嵌入时的最佳兜底
  if (activeId) chrome.runtime.sendMessage({ type: 'open-window', appId: activeId, windowType: 'popup' }).catch(() => {});
});

els.errorStd.addEventListener('click', () => {
  if (activeId) chrome.runtime.sendMessage({ type: 'open-window', appId: activeId, windowType: 'normal' }).catch(() => {});
});

els.errorOpen.addEventListener('click', () => {
  const app = apps.find((a) => a.id === activeId);
  if (app) chrome.tabs.create({ url: app.url });
});

/* ---------------- 应用列表实时同步 ---------------- */

function syncApps(nextApps) {
  const prevIds = new Set(apps.map((a) => a.id));
  const nextIds = new Set(nextApps.map((a) => a.id));

  // 删除：移除对应 iframe（扩展卸载应用时同步清理，iframe 一并销毁）
  for (const id of prevIds) {
    if (!nextIds.has(id)) {
      const f = frames.get(id);
      if (f) f.remove();
      frames.delete(id);
      loadedApps.delete(id);
      clearWatchdog(id);
      if (activeId === id) activeId = null;
    }
  }

  // 修改：URL 变化且 iframe 已存在 → 就地重载（状态丢失是预期行为）
  for (const app of nextApps) {
    if (prevIds.has(app.id)) {
      const f = frames.get(app.id);
      if (f) {
        let current = '';
        try {
          current = new URL(f.src).toString();
        } catch {}
        if (current !== app.url) {
          f.src = app.url;
          loadedApps.delete(app.id);
          armWatchdog(app.id, app);
        }
      }
    }
  }

  apps = nextApps;

  if (!activeId || !nextIds.has(activeId)) {
    const want = new URLSearchParams(location.search).get('app');
    const last = prefsCache.lastActiveApp;
    activeId = (want && nextIds.has(want) && want) || (last && nextIds.has(last) ? last : null) || (apps[0] && apps[0].id) || null;
  }
  renderTabs();
  if (activeId) activate(activeId, { skipSave: true });
}

/* ---------------- 工具栏动作 ---------------- */

/** 后退/前进：当前应用 iframe 的页面历史导航。跨域 iframe 的 history
 *  父级直接访问会抛 SecurityError，转发 __hubs_nav 给 frame-links.js
 *  在 iframe 自己的世界里执行（与抽屉同通道）。 */
function navActive(dir) {
  const frame = frames.get(activeId);
  if (!frame || frame.hidden) return;
  try {
    frame.contentWindow.postMessage({ __hubs_nav: dir }, '*');
  } catch {}
}

els.back.addEventListener('click', () => navActive('back'));
els.forward.addEventListener('click', () => navActive('forward'));

els.refresh.addEventListener('click', () => {
  const frame = frames.get(activeId);
  if (!frame) return;
  const app = apps.find((a) => a.id === activeId);
  frame.src = app.url; // 跨域 iframe 不能调 contentWindow.location.reload，用 src 重置
  loadedApps.delete(activeId);
  els.spinner.hidden = false;
  armWatchdog(activeId, app);
});

els.open.addEventListener('click', () => {
  const app = apps.find((a) => a.id === activeId);
  if (app) chrome.tabs.create({ url: app.url });
});

els.manage.addEventListener('click', () => chrome.runtime.openOptionsPage());
els.addFirst.addEventListener('click', () => chrome.runtime.openOptionsPage());

/* 点击 Logo：收起边栏（走 SW 的 chrome.sidePanel.close，收不到回执时兜底 window.close） */
document.querySelector('.brand').addEventListener('click', async () => {
  try {
    const win = await chrome.windows.getCurrent();
    const res = await chrome.runtime.sendMessage({ type: 'close-panel', windowId: win && win.id });
    if (res && res.ok) return;
  } catch {}
  window.close();
});

/* Tab 栏溢出时：垂直滚轮转横向滚动（滚动条已隐藏，需手动接管） */
els.tabs.addEventListener(
  'wheel',
  (e) => {
    if (!e.deltaY || els.tabs.scrollWidth <= els.tabs.clientWidth) return;
    e.preventDefault();
    els.tabs.scrollLeft += e.deltaY;
  },
  { passive: false }
);

/* 拖动 Tab 靠近两端时自动滚动（随吸附方向切换轴向） */
els.tabs.addEventListener('dragover', (e) => {
  if (!dragTab) return;
  e.preventDefault();
  const r = els.tabs.getBoundingClientRect();
  if (isVerticalHeader()) {
    if (e.clientY < r.top + 30) els.tabs.scrollTop -= 10;
    else if (e.clientY > r.bottom - 30) els.tabs.scrollTop += 10;
  } else {
    if (e.clientX < r.left + 30) els.tabs.scrollLeft -= 10;
    else if (e.clientX > r.right - 30) els.tabs.scrollLeft += 10;
  }
});

/* ---------------- 消息：悬浮条/Service Worker 指定激活应用 ---------------- */

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'activate-app' && msg.appId) {
    if (apps.some((a) => a.id === msg.appId)) activate(msg.appId);
  }
});

/* ---------------- 边栏跳转内部打开：iframe 新开链接原地加载 ---------------- */

// 向 iframe 推送拦截开关（frame-links.js 收到 __hubs_frame_ok 后改写 _blank 为原地导航；
// event.source 与 frame.contentWindow 引用比对是精确身份校验，页面第三方 iframe 不受影响）
function notifyFrameMode(frame) {
  try {
    frame.contentWindow.postMessage({ __hubs_frame_ok: prefsCache.panelInternalNav === true }, '*');
  } catch {}
}

// 抽屉同款探测应答：iframe 启动时主动来问，按当前偏好回复 true/false
window.addEventListener('message', (e) => {
  if (!e.data || e.data.__hubs_probe !== true) return;
  for (const f of frames.values()) {
    if (e.source === f.contentWindow) {
      notifyFrameMode(f);
      return;
    }
  }
});

/* ---------------- 启动 ---------------- */

// 向 SW 汇报面板开关状态，供悬浮条 Logo 点击时 toggle 开/关
chrome.runtime.sendMessage({ type: 'panel-opened' }).catch(() => {});
window.addEventListener('pagehide', () => {
  chrome.runtime.sendMessage({ type: 'panel-closed' }).catch(() => {});
});

(async () => {
  const [initialApps, prefs] = await Promise.all([HubsStorage.getApps(), HubsStorage.getPrefs()]);
  prefsCache = prefs;
  applyHeaderPos(prefs.headerPosition);
  applyInternalNav(prefs.panelInternalNav);
  syncApps(initialApps);
  // 面板未就绪时 activate-app 消息会丢，靠 lastActiveApp 兜底
  const want = new URLSearchParams(location.search).get('app');
  if (want && apps.some((a) => a.id === want)) activate(want, { skipSave: true });
})();

HubsStorage.subscribe((changes) => {
  if (changes.apps) syncApps(changes.apps);
  if (changes.prefs) {
    prefsCache = changes.prefs;
    applyHeaderPos(changes.prefs.headerPosition);
    applyInternalNav(changes.prefs.panelInternalNav);
    for (const f of frames.values()) notifyFrameMode(f); // 「边栏跳转内部打开」切换实时推送
  }
});
