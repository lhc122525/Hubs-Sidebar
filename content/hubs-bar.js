'use strict';
/**
 * Content Script - 收起态悬浮条（Hubs Bar）+ 内嵌抽屉。
 * 仅顶层框架注入；chrome://、edge://、商店页等由 manifest 匹配规则自动跳过。
 * UI 挂在 Shadow DOM 内，隔离页面样式。
 *
 * 点击应用图标：优先 chrome.sidePanel.open() 分屏打开；失败时降级为
 * 悬浮条旁的内嵌抽屉（iframe），绝不新开标签页。
 */
(() => {
  if (window !== window.top) return; // 只在顶层框架

  const proto = location.protocol;
  if (['chrome:', 'edge:', 'about:', 'chrome-extension:', 'edge-extension:', 'devtools:', 'view-source:'].indexOf(proto) !== -1) return;

  if (document.getElementById('hubs-bar-root')) return; // 防重复注入

  const LOGO_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<defs><linearGradient id="hubs-g" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#6fd6ff"/><stop offset="1" stop-color="#4a7dff"/>' +
    '</linearGradient></defs>' +
    '<rect x="3.5" y="4.5" width="13" height="15" rx="2.6" fill="url(#hubs-g)"/>' +
    '<rect x="18.5" y="8.75" width="2.5" height="6.5" rx="1.3" fill="url(#hubs-g)" opacity=".62"/></svg>';

  const GRIP_SVG =
    '<svg viewBox="0 0 8 16" aria-hidden="true">' +
    '<circle cx="2" cy="3" r="1.2"/><circle cx="6" cy="3" r="1.2"/>' +
    '<circle cx="2" cy="8" r="1.2"/><circle cx="6" cy="8" r="1.2"/>' +
    '<circle cx="2" cy="13" r="1.2"/><circle cx="6" cy="13" r="1.2"/></svg>';

  const CLOSE_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';

  const MINUS_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';

  const BACK_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 5.5L8 12l6.5 6.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const FWD_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 5.5L16 12l-6.5 6.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const DRAWER_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M15.5 4.8v14.4" fill="none" stroke="currentColor" stroke-width="1.9"/></svg>';

  const GEAR_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.6A3.4 3.4 0 1 0 12 15.4 3.4 3.4 0 0 0 12 8.6z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M19.2 12c0-.4 0-.8-.1-1.1l1.9-1.5-1.9-3.3-2.2.9a7.2 7.2 0 0 0-1.9-1.1L14.6 3.6h-5.2L9 5.9a7.2 7.2 0 0 0-1.9 1.1l-2.2-.9-1.9 3.3 1.9 1.5a6.8 6.8 0 0 0 0 2.2l-1.9 1.5 1.9 3.3 2.2-.9a7.2 7.2 0 0 0 1.9 1.1l.4 2.3h5.2l.4-2.3a7.2 7.2 0 0 0 1.9-1.1l2.2.9 1.9-3.3-1.9-1.5c.06-.36.1-.73.1-1.1z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';

  const PLUS_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5.5v13M5.5 12h13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';

  /** 快捷收藏的主题色：按 URL 哈希从色板取，同一站点固定、不同站点彼此区分 */
  const HUBS_ADD_COLORS = ['#0078d4', '#0f6cbd', '#2564cf', '#5b5fc7', '#7a3ba8', '#c2410c', '#0e7a5a', '#b3261e'];

  function colorForUrl(url) {
    let h = 0;
    for (let i = 0; i < url.length; i++) h = (h * 31 + url.charCodeAt(i)) >>> 0;
    return HUBS_ADD_COLORS[h % HUBS_ADD_COLORS.length];
  }

  let host, shadow, bar, dot, drawer, drawerTitle, drawerBody;
  let menu, itemPanel, itemWindow, itemStd, itemDrawer;
  let addMask, addNameInput, addUrlInput, addHintEl, addOkBtn; // 快捷收藏弹窗
  let menuAppId = null; // 右键菜单当前对应的应用
  let apps = [];
  let prefs = { ...HUBS_DEFAULT_PREFS };
  let collapsed = false; // 折叠态只作用于当前页面（内存状态，不进 storage，不同步其他窗口）
  let hoverActive = false; // 当前展开由 hover 触发（移出悬浮条自动收起；点击展开的固定）
  let hoverTimer = null; // hover 收起延迟句柄，期间移回悬浮条则取消
  let dragging = null;
  let dragDistance = 0; // 最近一次拖拽的位移，用于区分「拖拽」与「点击」（圆点/手柄共用）
  let lastDrawerAppId = null; // 上次抽屉打开的应用，悬浮条按钮一键恢复
  const barFrames = new Map(); // appId -> iframe
  const barLoaded = new Set(); // 已触发过 load 的 appId

  /* ---------------- 启动 ---------------- */

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  async function init() {
    // 小窗口（popup）不注入悬浮条：本窗口已是我们自己的小窗，无需再放一条
    try {
      const res = await chrome.runtime.sendMessage({ type: 'is-popup-window' });
      if (res && res.popup) return;
    } catch {} // SW 未就绪时按正常窗口处理

    [apps, prefs] = await Promise.all([HubsStorage.getApps(), HubsStorage.getPrefs()]);
    collapsed = prefs.barExpanded === false; // 管理页关闭「默认展开」→ 初始只显示折叠圆点

    host = document.createElement('div');
    host.id = 'hubs-bar-root';
    shadow = host.attachShadow({ mode: 'open' });

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('content/hubs-bar.css');
    shadow.appendChild(link);

    bar = document.createElement('div');
    bar.className = 'hubs-bar';

    dot = document.createElement('button');
    dot.className = 'hubs-dot';
    dot.type = 'button';
    dot.title = '展开 Hubs（可拖拽移动）';
    dot.innerHTML = LOGO_SVG;
    dot.addEventListener('click', () => {
      if (dragDistance > 4) {
        dragDistance = 0; // 拖拽结束后的 click，不算点击
        return;
      }
      hoverActive = false; // 点击展开 = 固定，移出不再自动收起
      collapsed = false;
      applyPosition();
    });
    bindDrag(dot, dot);

    // hover 模式：移入圆点临时展开，移出悬浮条延迟收起；点击展开的不受影响
    dot.addEventListener('mouseenter', () => {
      if (prefs.hoverExpand === false || !collapsed) return;
      hoverActive = true;
      collapsed = false;
      applyPosition();
    });
    bar.addEventListener('mouseenter', () => {
      if (hoverTimer) {
        clearTimeout(hoverTimer);
        hoverTimer = null;
      }
    });
    bar.addEventListener('mouseleave', () => {
      if (!hoverActive || hoverTimer) return;
      hoverTimer = setTimeout(() => {
        hoverTimer = null;
        hoverActive = false;
        collapsed = true;
        applyPosition();
      }, 250);
    });

    drawer = document.createElement('div');
    drawer.className = 'hubs-drawer';
    drawer.hidden = true;

    drawerTitle = document.createElement('span');
    drawerTitle.className = 'hubs-drawer-title';

    // 后退/前进：抽屉内页面历史导航（目标 iframe 跨域，history 不可直接访问，
    // 经 frame-links.js 通道在 iframe 内部执行）
    const backBtn = document.createElement('button');
    backBtn.className = 'hubs-drawer-nav';
    backBtn.type = 'button';
    backBtn.title = '后退';
    backBtn.innerHTML = BACK_SVG;
    backBtn.addEventListener('click', () => navDrawer('back'));

    const fwdBtn = document.createElement('button');
    fwdBtn.className = 'hubs-drawer-nav';
    fwdBtn.type = 'button';
    fwdBtn.title = '前进';
    fwdBtn.innerHTML = FWD_SVG;
    fwdBtn.addEventListener('click', () => navDrawer('forward'));

    // 收起：仅隐藏抽屉，iframe 状态保留，悬浮条「抽屉」按钮可随时恢复
    const hideBtn = document.createElement('button');
    hideBtn.className = 'hubs-drawer-close';
    hideBtn.type = 'button';
    hideBtn.title = '收起抽屉（保留页面状态）';
    hideBtn.innerHTML = MINUS_SVG;
    hideBtn.addEventListener('click', () => hideDrawer());

    // 关闭：销毁抽屉内所有 iframe，下次打开重新加载
    const closeBtn = document.createElement('button');
    closeBtn.className = 'hubs-drawer-close';
    closeBtn.type = 'button';
    closeBtn.title = '关闭抽屉（销毁页面）';
    closeBtn.innerHTML = CLOSE_SVG;
    closeBtn.addEventListener('click', () => destroyDrawer());

    drawerBody = document.createElement('div');
    drawerBody.className = 'hubs-drawer-body';

    const head = el('div', 'hubs-drawer-head');
    head.title = '拖拽移动抽屉 / 双击恢复跟随悬浮条';
    head.append(drawerTitle, backBtn, fwdBtn, hideBtn, closeBtn);
    drawer.append(head, drawerBody);
    bindDrawerDrag(head); // 拖标题栏自由定位；双击标题栏恢复跟随悬浮条

    // 抽屉内角手柄：拖拽自由调整宽高
    const drawerResize = el('div', 'hubs-drawer-resize');
    drawerResize.title = '拖拽调整大小';
    drawer.append(drawerResize);
    bindDrawerResize(drawerResize);

    // 右键菜单：边栏打开 / 小窗打开
    menu = el('div', 'hubs-menu');
    menu.hidden = true;
    itemPanel = el('button', 'hubs-menu-item');
    itemPanel.type = 'button';
    itemPanel.textContent = '边栏打开';
    itemWindow = el('button', 'hubs-menu-item');
    itemWindow.type = 'button';
    itemWindow.textContent = '小窗打开';
    itemStd = el('button', 'hubs-menu-item');
    itemStd.type = 'button';
    itemStd.textContent = '独立窗口';
    itemDrawer = el('button', 'hubs-menu-item');
    itemDrawer.type = 'button';
    itemDrawer.textContent = '抽屉打开';
    menu.append(itemPanel, itemWindow, itemStd, itemDrawer);
    itemPanel.addEventListener('click', () => {
      const id = menuAppId;
      hideMenu();
      if (id) openPanel(id);
    });
    itemWindow.addEventListener('click', () => {
      const id = menuAppId;
      hideMenu();
      if (id) {
        chrome.runtime.sendMessage({ type: 'open-window', appId: id }).catch(() => {});
      }
    });
    // 独立窗口：正常浏览器窗口（等同 Ctrl+N），只是默认尺寸开小
    itemStd.addEventListener('click', () => {
      const id = menuAppId;
      hideMenu();
      if (id) {
        chrome.runtime.sendMessage({ type: 'open-window', appId: id, windowType: 'normal' }).catch(() => {});
      }
    });
    // 抽屉打开：iframe 收起后状态保留，适合「临时折起、随时恢复」的场景
    itemDrawer.addEventListener('click', () => {
      const id = menuAppId;
      hideMenu();
      if (id) openInBar(id);
    });
    // 快捷收藏弹窗：预填当前站点标题/网址，确认后加入应用列表
    addMask = el('div', 'hubs-dialog-mask');
    addMask.hidden = true;
    const addForm = el('form', 'hubs-dialog');

    const addHeading = el('div', 'hubs-dialog-heading');
    addHeading.textContent = '收藏当前网站';

    const nameField = el('label', 'hubs-dialog-field');
    nameField.textContent = '标题';
    addNameInput = el('input');
    addNameInput.type = 'text';
    addNameInput.placeholder = '站点标题';
    addNameInput.maxLength = 40;
    nameField.appendChild(addNameInput);

    const urlField = el('label', 'hubs-dialog-field');
    urlField.textContent = '网址';
    addUrlInput = el('input');
    addUrlInput.type = 'text';
    addUrlInput.placeholder = 'https://…';
    urlField.appendChild(addUrlInput);

    addHintEl = el('div', 'hubs-dialog-hint');

    const addActions = el('div', 'hubs-dialog-actions');
    const cancelBtn = el('button', 'hubs-dialog-btn');
    cancelBtn.type = 'button';
    cancelBtn.textContent = '取消';
    cancelBtn.addEventListener('click', hideAddDialog);
    addOkBtn = el('button', 'hubs-dialog-btn primary');
    addOkBtn.type = 'submit';
    addOkBtn.textContent = '添加';
    addActions.append(cancelBtn, addOkBtn);

    addForm.append(addHeading, nameField, urlField, addHintEl, addActions);
    addForm.addEventListener('submit', (e) => {
      e.preventDefault();
      submitAddApp();
    });
    addNameInput.addEventListener('input', validateAddDialog);
    addUrlInput.addEventListener('input', validateAddDialog);
    addMask.appendChild(addForm);
    addMask.addEventListener('click', (e) => {
      if (e.target === addMask) hideAddDialog(); // 点遮罩关闭
    });

    shadow.append(link, bar, dot, drawer, menu, addMask);
    (document.documentElement || document.body).appendChild(host);

    applyLayerZIndex();
    renderBar();
    applyPosition();

    HubsStorage.subscribe((changes) => {
      if (changes.apps) {
        apps = changes.apps;
        pruneBarFrames();
        renderBar();
        applyPosition();
      }
      if (changes.prefs) {
        prefs = { ...prefs, ...changes.prefs };
        applyLayerZIndex();
        renderBar();
        applyPosition();
        if (!drawer.hidden) positionDrawer();
        // 「抽屉跳转内部打开」切换 → 推送到已存在的抽屉 iframe（探测早已停止，需主动告知）
        for (const f of barFrames.values()) {
          try {
            f.contentWindow.postMessage({ __hubs_frame_ok: prefs.drawerInternalNav !== false }, '*');
          } catch {}
        }
      }
    });

    window.addEventListener('resize', () => {
      if (!drawer.hidden) positionDrawer();
      hideMenu();
      applyPosition(); // 视口变窄（H5/小窗）整体隐藏，恢复宽度后重新显示
    });
    window.addEventListener('keydown', onKeydown, true);

    // 抽屉 iframe 内 frame-links.js 的探测应答：event.source 与 drawer.contentWindow
    // 引用比对是精确身份校验——只有我们自己的抽屉 iframe 才会收到激活回执，
    // 页面里其他第三方 iframe 探测后无回应，保持原样。
    // 回执值跟随「抽屉跳转内部打开」偏好：true 拦截新窗口原地打开，false 放行
    window.addEventListener('message', (e) => {
      if (!e.data || e.data.__hubs_probe !== true) return;
      for (const f of barFrames.values()) {
        if (e.source === f.contentWindow) {
          e.source.postMessage({ __hubs_frame_ok: prefs.drawerInternalNav !== false }, '*');
          return;
        }
      }
    });
    // 点击菜单/悬浮条之外的地方 → 关菜单（open shadow 可用 composedPath 拿到内部目标）
    window.addEventListener('click', (e) => {
      if (menu.hidden) return;
      const inner = e.composedPath && e.composedPath()[0];
      if (inner && menu.contains(inner)) return; // 菜单项自身点击，交给其 handler
      hideMenu();
    }, true);
  }

  /* ---------------- 渲染辅助 ---------------- */

  function el(tag, className) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    return n;
  }

  function applyLayerZIndex() {
    if (!host) return;
    const base = HubsStorage.clamp(Number(prefs.barZIndex) || HUBS_DEFAULT_PREFS.barZIndex, 1, 2147483647);
    host.style.setProperty('--hubs-bar-z', String(base));
    host.style.setProperty('--hubs-dot-z', String(base));
    host.style.setProperty('--hubs-drawer-z', String(Math.max(0, base - 1)));
    host.style.setProperty('--hubs-menu-z', String(Math.min(2147483647, base + 1)));
  }

  function sep() {
    return el('div', 'hubs-sep');
  }

  /** 图标节点：按 URL 自动取站点 favicon，取不到（error）兜底为主题色底 + 首字母 */
  function iconNode(app) {
    const span = el('span', 'hubs-icon');
    const img = el('img');
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

  function renderBar() {
    bar.textContent = '';

    // 拖拽手柄：点击折叠（抽屉独立，不受影响），拖拽移动可换边
    const grip = el('div', 'hubs-grip');
    grip.title = '点击折叠 / 拖拽移动（可换边）';
    grip.innerHTML = GRIP_SVG;
    grip.addEventListener('click', () => {
      if (dragDistance > 4) {
        dragDistance = 0; // 拖拽结束后的 click，不算点击
        return;
      }
      hoverActive = false; // 收起后，下一次 hover 重新计时
      collapsed = true;
      applyPosition();
    });
    bindDrag(grip, bar);
    bar.appendChild(grip);

    // Logo：切换分屏面板（开 → 再点关；失败兜底抽屉）
    const logo = el('button', 'hubs-btn hubs-logo');
    logo.type = 'button';
    logo.title = '打开/关闭 Hubs 面板';
    logo.innerHTML = LOGO_SVG;
    logo.addEventListener('click', () => togglePanel());
    bar.appendChild(logo);
    bar.appendChild(sep());

    // 应用快捷图标：单独容器，最高 6 格，超出内部滚动
    const list = el('div', 'hubs-apps');
    for (const app of apps) {
      const btn = el('button', 'hubs-btn hubs-app');
      btn.type = 'button';
      btn.title = app.name;
      btn.appendChild(iconNode(app));
      btn.addEventListener('click', () => openPanel(app.id));
      // 右键菜单：边栏打开 / 小窗打开
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showMenu(e.clientX, e.clientY, app.id);
      });
      list.appendChild(btn);
    }
    bar.appendChild(list);

    bar.appendChild(sep());

    // 抽屉开关：收起后一键恢复（iframe 状态保留）
    const drawerBtn = el('button', 'hubs-btn hubs-drawer-toggle');
    drawerBtn.type = 'button';
    drawerBtn.title = '展开/收起抽屉';
    drawerBtn.innerHTML = DRAWER_SVG;
    drawerBtn.addEventListener('click', () => toggleDrawer());
    bar.appendChild(drawerBtn);

    // 设置：打开管理页（openOptionsPage 仅扩展页可用，经 SW 转发）
    const settingsBtn = el('button', 'hubs-btn hubs-settings');
    settingsBtn.type = 'button';
    settingsBtn.title = '设置';
    settingsBtn.innerHTML = GEAR_SVG;
    settingsBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'open-options' }).catch(() => {});
    });
    bar.appendChild(settingsBtn);

    // 快捷收藏：弹窗确认标题/网址，把当前网站加入应用列表
    const addBtn = el('button', 'hubs-btn hubs-add');
    addBtn.type = 'button';
    addBtn.title = '收藏当前网站';
    addBtn.innerHTML = PLUS_SVG;
    addBtn.addEventListener('click', showAddDialog);
    bar.appendChild(addBtn);

    // 底部折叠按钮：右侧朝右收、左侧朝左收（CSS 依 .side-left 翻转）

    // 底部折叠按钮：右侧朝右收、左侧朝左收（CSS 依 .side-left 翻转）
    // const collapse = el('button', 'hubs-btn hubs-collapse');
    // collapse.type = 'button';
    // collapse.title = '折叠';
    // collapse.innerHTML = chevronSVG();
    // collapse.addEventListener('click', () => {
    //   closeDrawer();
    //   collapsed = true;
    //   applyPosition();
    // });
    // bar.appendChild(collapse);
  }

  // function chevronSVG() {
  //   return '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  // }

  /** 点击入口：优先分屏面板，失败/无响应则内嵌抽屉兜底，绝不新开标签页 */
  function openPanel(appId) {
    const app = appId ? apps.find((a) => a.id === appId) : null;
    const target = app ? app.id : (apps[0] && apps[0].id) || null;
    if (!target) return;
    HubsStorage.setPrefs({ lastActiveApp: target }).catch(() => {});
    chrome.runtime.sendMessage({ type: 'open-panel', appId: target })
      .then((res) => {
        if (res && res.ok) {
          hideDrawer(); // 分屏成功，抽屉收起（状态保留，随时可切回）
        } else {
          openInBar(target);
        }
      })
      .catch(() => openInBar(target)); // SW 未就绪/无监听 → 抽屉兜底
  }

  /** Logo 点击：面板开着就关闭，没开就打开（toggle） */
  function togglePanel() {
    const target = prefs.lastActiveApp || (apps[0] && apps[0].id) || null;
    if (!target) return;
    chrome.runtime.sendMessage({ type: 'toggle-panel', appId: target })
      .then((res) => {
        if (res && res.ok && res.opened) hideDrawer();
      })
      .catch(() => openInBar(target)); // SW 未就绪/无监听 → 抽屉兜底
  }

  /** 在悬浮条旁展开内嵌抽屉并切换到指定应用 */
  function openInBar(appId) {
    const app = apps.find((a) => a.id === appId);
    if (!app) return;
    lastDrawerAppId = appId;
    const frame = ensureFrame(app);
    drawerTitle.textContent = app.name;
    drawer.hidden = false;
    for (const [id, f] of barFrames) f.hidden = id !== appId; // display:none 切换，不销毁
    frame.hidden = false;
    positionDrawer();
  }

  function ensureFrame(app) {
    if (barFrames.has(app.id)) return barFrames.get(app.id);
    const frame = document.createElement('iframe');
    frame.className = 'hubs-drawer-frame';
    frame.src = app.url;
    frame.allow = 'clipboard-read; clipboard-write; camera; microphone; autoplay';
    frame.addEventListener('load', () => barLoaded.add(app.id));
    barFrames.set(app.id, frame);
    drawerBody.appendChild(frame);
    return frame;
  }

  /**
   * 抽屉定位：抽屉独立于悬浮条。
   *  - drawerX/Y 为空：跟随悬浮条（侧边偏移 62px + topRatio 垂直位置）
   *  - drawerX/Y 有值：自由定位（拖标题栏后记录），夹紧到当前视口内
   */
  function positionDrawer() {
    const custom = prefs.drawerX != null && prefs.drawerY != null;
    const side = !custom && prefs.side === 'left' ? 'left' : 'right';
    drawer.classList.toggle('side-left', !custom && side === 'left');
    const maxW = custom ? window.innerWidth - 16 : window.innerWidth - 100;
    const w = HubsStorage.clamp(Number(prefs.drawerW) || 400, 280, Math.max(280, maxW));
    let h = Number(prefs.drawerH) || 0;
    const topPx = HubsStorage.clamp(Number(prefs.topRatio) || 0.5, 0.02, 0.94) * window.innerHeight;
    if (!h) h = Math.min(0.72 * window.innerHeight, Math.max(300, window.innerHeight - topPx - 16));
    h = HubsStorage.clamp(h, 300, Math.max(300, window.innerHeight - 16));
    drawer.style.width = w + 'px';
    drawer.style.height = h + 'px';
    if (custom) {
      const x = HubsStorage.clamp(prefs.drawerX, 8, Math.max(8, window.innerWidth - w - 8));
      const y = HubsStorage.clamp(prefs.drawerY, 8, Math.max(8, window.innerHeight - h - 8));
      drawer.style.right = '';
      drawer.style.left = x + 'px';
      drawer.style.top = y + 'px';
    } else {
      drawer.style.left = drawer.style.right = '';
      drawer.style[side] = '62px';
      drawer.style.top = Math.min(topPx, Math.max(8, window.innerHeight - h - 12)) + 'px';
    }
  }

  /** 收起：仅隐藏，iframe 状态保留，悬浮条「抽屉」按钮一键恢复 */
  function hideDrawer() {
    if (!drawer || drawer.hidden) return;
    drawer.hidden = true;
  }

  /**
   * 抽屉内页面后退/前进。目标 iframe 几乎必然跨域，contentWindow.history
   * 直接访问会抛 SecurityError，所以转发 __hubs_nav 给 frame-links.js
   * 在 iframe 自己的世界里执行 history.back()/forward()。
   */
  function navDrawer(dir) {
    if (!drawer || drawer.hidden || !lastDrawerAppId) return;
    const frame = barFrames.get(lastDrawerAppId);
    if (!frame || frame.hidden) return;
    try {
      frame.contentWindow.postMessage({ __hubs_nav: dir }, '*');
    } catch {}
  }

  /** 关闭：真实销毁——移除全部 iframe，清空记忆，下次打开重新加载 */
  function destroyDrawer() {
    if (!drawer) return;
    for (const f of barFrames.values()) f.remove();
    barFrames.clear();
    barLoaded.clear();
    lastDrawerAppId = null;
    drawer.hidden = true;
  }

  /** 悬浮条「抽屉」按钮：开着就收起（保留状态），收着就恢复上次抽屉应用 */
  function toggleDrawer() {
    if (drawer && !drawer.hidden) return hideDrawer();
    const target =
      lastDrawerAppId && apps.some((a) => a.id === lastDrawerAppId)
        ? lastDrawerAppId
        : (apps[0] && apps[0].id) || null;
    if (target) openInBar(target);
  }

  /** 拖抽屉标题栏自由定位（按钮不触发）；双击标题栏恢复「跟随悬浮条」 */
  function bindDrawerDrag(handle) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      e.preventDefault();
      const rect = drawer.getBoundingClientRect();
      const start = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top };
      let moved = false;
      drawer.classList.add('dragging');
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => {
        moved = true;
        const x = HubsStorage.clamp(start.left + ev.clientX - start.x, 8, Math.max(8, window.innerWidth - drawer.offsetWidth - 8));
        const y = HubsStorage.clamp(start.top + ev.clientY - start.y, 8, Math.max(8, window.innerHeight - drawer.offsetHeight - 8));
        drawer.style.right = '';
        drawer.style.left = x + 'px';
        drawer.style.top = y + 'px';
      };
      const up = (ev) => {
        try {
          handle.releasePointerCapture(ev.pointerId);
        } catch {}
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        drawer.classList.remove('dragging');
        if (!moved) return; // 原地点击不算拖拽，保持原定位模式
        const r = drawer.getBoundingClientRect();
        prefs.drawerX = Math.round(r.left);
        prefs.drawerY = Math.round(r.top);
        HubsStorage.setPrefs({ drawerX: prefs.drawerX, drawerY: prefs.drawerY }).catch(() => {});
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
    // 双击标题栏：清除自由定位，恢复跟随悬浮条
    handle.addEventListener('dblclick', (e) => {
      if (e.target.closest('button')) return;
      prefs.drawerX = prefs.drawerY = null;
      HubsStorage.setPrefs({ drawerX: null, drawerY: null }).catch(() => {});
      positionDrawer();
    });
  }

  /** 抽屉角落手柄：拖拽自由调整宽高，松手存 prefs（全局记忆） */
  function bindDrawerResize(handle) {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const start = { x: e.clientX, y: e.clientY, w: drawer.offsetWidth, h: drawer.offsetHeight };
      const move = (ev) => {
        // 手柄在左下角（跟随右侧悬浮条/自由定位）：向左拖变宽；左贴边抽屉手柄在右下角：向右拖变宽
        const isLeft = drawer.classList.contains('side-left');
        const rect = drawer.getBoundingClientRect();
        const dw = isLeft ? ev.clientX - start.x : start.x - ev.clientX;
        const maxW = isLeft ? window.innerWidth - rect.left - 8 : rect.right - 8;
        prefs.drawerW = HubsStorage.clamp(start.w + dw, 280, Math.max(280, maxW));
        prefs.drawerH = HubsStorage.clamp(start.h + (ev.clientY - start.y), 300, window.innerHeight - 20);
        positionDrawer();
      };
      const up = (ev) => {
        try {
          handle.releasePointerCapture(ev.pointerId);
        } catch {}
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        HubsStorage.setPrefs({ drawerW: prefs.drawerW, drawerH: prefs.drawerH }).catch(() => {});
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }

  /** 右键菜单显示/隐藏 */
  function showMenu(x, y, appId) {
    menuAppId = appId;
    menu.hidden = false;
    // 先渲染再测量，避免超出视口
    const w = menu.offsetWidth || 140;
    const h = menu.offsetHeight || 96;
    const nx = Math.min(x, window.innerWidth - w - 8);
    const ny = Math.min(y, window.innerHeight - h - 8);
    menu.style.left = Math.max(8, nx) + 'px';
    menu.style.top = Math.max(8, ny) + 'px';
  }

  function hideMenu() {
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    menuAppId = null;
  }

  /* ---------------- 快捷收藏弹窗 ---------------- */

  /** 打开弹窗：预填当前站点标题与网址，聚焦全选标题便于直接改名 */
  function showAddDialog() {
    hideMenu();
    addNameInput.value = (document.title || '').trim() || location.hostname;
    addUrlInput.value = location.href;
    validateAddDialog();
    addMask.hidden = false;
    requestAnimationFrame(() => {
      addNameInput.focus();
      addNameInput.select();
    });
  }

  function hideAddDialog() {
    if (!addMask || addMask.hidden) return;
    addMask.hidden = true;
  }

  /** 校验：URL 可规范化且未收藏过；不合法/重复时禁用「添加」并提示 */
  function validateAddDialog() {
    const url = HubsStorage.normalizeUrl(addUrlInput.value);
    const dup = !!url && apps.some((a) => a.url === url);
    addUrlInput.classList.toggle('invalid', !url);
    addHintEl.textContent = !url ? '网址无效，仅支持 http(s) 链接' : dup ? '该网站已在快捷方式中' : '';
    addOkBtn.disabled = !url || dup;
  }

  async function submitAddApp() {
    if (addOkBtn.disabled) return;
    const url = HubsStorage.normalizeUrl(addUrlInput.value);
    if (!url) return;
    const name = addNameInput.value.trim() || new URL(url).hostname;
    hideAddDialog();
    try {
      await HubsStorage.addApp({ name, url, color: colorForUrl(url) });
      // 新增项在列表末尾：滚到底部让它立即可见（storage.onChanged → renderBar 之后）
      requestAnimationFrame(() => {
        const list = shadow.querySelector('.hubs-apps');
        if (list) list.scrollTop = list.scrollHeight;
      });
    } catch {}
  }

  /** ESC 关抽屉/菜单（capture 阶段，避免被页面拦截） */
  function onKeydown(e) {
    if (e.key !== 'Escape') return;
    if (addMask && !addMask.hidden) {
      e.stopPropagation();
      e.preventDefault();
      hideAddDialog();
      return;
    }
    if (menu && !menu.hidden) {
      e.stopPropagation();
      e.preventDefault();
      hideMenu();
      return;
    }
    if (drawer && !drawer.hidden) {
      e.stopPropagation();
      e.preventDefault();
      hideDrawer(); // ESC = 收起（保留状态），不销毁
    }
  }

  /** H5/窄视口（移动模式或窗口过窄）不显示悬浮条 */
  function viewportSuppressed() {
    if (/Mobile|Android|iPhone|iPad/i.test(navigator.userAgent)) return true; // H5 移动端渲染
    return window.innerWidth < 480; // 视口过窄，悬浮条会明显遮挡内容
  }

  function applyPosition() {
    const side = prefs.side === 'left' ? 'left' : 'right';
    const off = viewportSuppressed();
    const disabled = off || prefs.showBar === false; // 管理页关闭「快捷导航浮点」→ 整体隐藏
    if (disabled) hideDrawer(); // 悬浮条没了，抽屉也不应残留（仅隐藏，状态保留）
    bar.hidden = collapsed || disabled;
    dot.hidden = !collapsed || disabled;
    bar.classList.toggle('side-left', side === 'left');
    dot.classList.toggle('side-left', side === 'left');
    const topPct = HubsStorage.clamp(Number(prefs.topRatio) || 0.5, 0.02, 0.94) * 100;
    for (const n of [bar, dot]) {
      n.style.left = n.style.right = '';
      n.style[side] = '3px';
      n.style.top = topPct + 'vh';
    }
  }

  function pruneBarFrames() {
    const ids = new Set(apps.map((a) => a.id));
    for (const [id, f] of barFrames) {
      if (!ids.has(id)) {
        f.remove();
        barFrames.delete(id);
        barLoaded.delete(id);
      }
    }
    // 应用 URL 变更时就地重载
    for (const app of apps) {
      const f = barFrames.get(app.id);
      if (f) {
        let current = '';
        try { current = new URL(f.src).toString(); } catch {}
        if (current !== app.url) {
          f.src = app.url;
          barLoaded.delete(app.id);
        }
      }
    }
  }

  /**
   * 拖拽：换边 + 垂直位置，pointerup 时存 chrome.storage.sync。
   * handle = 接收指针事件的元素；node = 实际被移动的元素（手柄拖 bar，圆点拖自身）。
   */
  function bindDrag(handle, node) {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const rect = node.getBoundingClientRect();
      dragging = {
        node,
        px: e.clientX,
        py: e.clientY,
        left: rect.left,
        top: rect.top,
        w: rect.width,
        h: rect.height,
      };
      node.classList.add('dragging');
      handle.setPointerCapture(e.pointerId);
    });

    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const nx = HubsStorage.clamp(dragging.left + (e.clientX - dragging.px), 4, window.innerWidth - dragging.w - 4);
      const ny = HubsStorage.clamp(dragging.top + (e.clientY - dragging.py), 4, window.innerHeight - dragging.h - 4);
      node.style.left = nx + 'px';
      node.style.right = 'auto';
      node.style.top = ny + 'px';
    });

    const finish = (e) => {
      if (!dragging) return;
      node.classList.remove('dragging');
      try {
        handle.releasePointerCapture(e.pointerId);
      } catch {}
      const moved = Math.hypot(e.clientX - dragging.px, e.clientY - dragging.py);
      dragDistance = moved; // 松手后随之而来的 click 用它区分拖拽/点击
      const rect = node.getBoundingClientRect();
      const side = rect.left + rect.width / 2 < window.innerWidth / 2 ? 'left' : 'right';
      const topRatio = HubsStorage.clamp(rect.top / Math.max(1, window.innerHeight), 0.02, 0.94);
      dragging = null;
      HubsStorage.setPrefs({ side, topRatio }).catch(() => {});
      prefs = { ...prefs, side, topRatio };
      applyPosition();
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  }
})();
