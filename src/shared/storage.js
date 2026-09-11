'use strict';
/**
 * StorageService —— 逻辑内核统一：应用数据与偏好的唯一读写入口。
 * 悬浮条（Content Script）、分屏面板（Panel）、管理页（Options）三端共用本文件，
 * 不允许各自另写 chrome.storage 逻辑；数据变更通过 subscribe(storage.onChanged) 广播。
 */
const HubsStorage = (() => {
  const KEY_APPS = 'hubsApps';
  const KEY_PREFS = 'hubsPrefs';

  /* ---------------- 工具 ---------------- */

  function genId() {
    return 'app-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  function normalizeZIndex(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return HUBS_DEFAULT_PREFS.barZIndex;
    return clamp(Math.round(n), 1, 2147483647);
  }

  function normalizePrefs(prefs) {
    const next = { ...HUBS_DEFAULT_PREFS, ...(prefs || {}) };
    next.barZIndex = normalizeZIndex(next.barZIndex);
    return next;
  }

  /** 规范化 URL：补协议、只允许 http(s)，失败返回空串 */
  function normalizeUrl(url) {
    if (!url) return '';
    url = String(url).trim();
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
      return u.origin + (u.pathname === '/' ? '' : u.pathname) + u.search + u.hash;
    } catch {
      return '';
    }
  }

  function normalizeApp(app) {
    return {
      id: String(app.id || genId()),
      name: String(app.name || '').trim() || '未命名',
      url: normalizeUrl(app.url) || 'https://www.bing.com',
      color: String(app.color || '#0078d4'),
      builtin: !!app.builtin,
    };
  }

  /* ---------------- 读取 ---------------- */

  async function getApps() {
    const data = await chrome.storage.sync.get(KEY_APPS);
    let apps = data[KEY_APPS];
    if (!Array.isArray(apps)) {
      apps = HUBS_DEFAULT_APPS.map((a) => ({ ...a }));
      await chrome.storage.sync.set({ [KEY_APPS]: apps });
    }
    return apps.map(normalizeApp);
  }

  async function getPrefs() {
    const data = await chrome.storage.sync.get(KEY_PREFS);
    return normalizePrefs(data[KEY_PREFS]);
  }

  /* ---------------- 写入 ---------------- */

  async function saveApps(list) {
    const apps = (list || []).map(normalizeApp);
    await chrome.storage.sync.set({ [KEY_APPS]: apps });
    return apps;
  }

  async function addApp(data) {
    const apps = await getApps();
    const app = normalizeApp({ ...data, id: data && data.id ? data.id : genId() });
    apps.push(app);
    await saveApps(apps);
    return app;
  }

  async function updateApp(id, patch) {
    const apps = await getApps();
    const idx = apps.findIndex((a) => a.id === id);
    if (idx === -1) return null;
    apps[idx] = normalizeApp({ ...apps[idx], ...patch, id }); // id 不允许被改写
    await saveApps(apps);
    return apps[idx];
  }

  async function removeApp(id) {
    const apps = await getApps();
    const next = apps.filter((a) => a.id !== id);
    await saveApps(next);
    return next.length !== apps.length;
  }

  /** 恢复缺失的内置预设（保留用户已存在的应用，包括同名） */
  async function restorePresets() {
    const apps = await getApps();
    const exist = new Set(apps.map((a) => a.id));
    const missing = HUBS_DEFAULT_APPS.filter((p) => !exist.has(p.id)).map((p) => ({ ...p }));
    if (missing.length) await saveApps(apps.concat(missing));
    return missing.length;
  }

  async function setPrefs(patch) {
    const prefs = normalizePrefs({ ...(await getPrefs()), ...patch });
    await chrome.storage.sync.set({ [KEY_PREFS]: prefs });
    return prefs;
  }

  /* ---------------- 订阅 ---------------- */

  /**
   * storage.onChanged 驱动（不轮询）。
   * cb 收到 { apps?, prefs? }，只包含实际变化的键。
   */
  function subscribe(cb) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      const out = {};
      if (changes[KEY_APPS]) out.apps = (changes[KEY_APPS].newValue || []).map(normalizeApp);
      if (changes[KEY_PREFS]) out.prefs = normalizePrefs(changes[KEY_PREFS].newValue);
      if (Object.keys(out).length) cb(out);
    });
  }

  return {
    genId,
    clamp,
    normalizeUrl,
    normalizeApp,
    getApps,
    saveApps,
    addApp,
    updateApp,
    removeApp,
    restorePresets,
    getPrefs,
    setPrefs,
    subscribe,
    KEY_APPS,
    KEY_PREFS,
  };
})();
