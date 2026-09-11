'use strict';
/**
 * 管理页：应用的增、删、改（名称 / URL / 主题色）。
 * 图标不再手填：渲染时按 URL 自动取站点 favicon，取不到兜底为首字母色块。
 * 所有读写走 HubsStorage；保存后 storage.onChanged 会实时驱动
 * 悬浮条与分屏面板刷新，本页不需要任何自定义广播。
 */

const COLOR_PRESETS = ['#0078d4', '#5b5fc7', '#7719aa', '#c42b1c', '#ca5010', '#0f7b0f', '#038387', '#b146c2'];

let apps = [];
let dragRow = null; // 正在拖动排序的列表行

const els = {
  list: document.getElementById('app-list'),
  emptyTip: document.getElementById('empty-tip'),
  formCard: document.getElementById('form-card'),
  formTitle: document.getElementById('form-title'),
  form: document.getElementById('app-form'),
  fId: document.getElementById('f-id'),
  fName: document.getElementById('f-name'),
  fUrl: document.getElementById('f-url'),
  fColor: document.getElementById('f-color'),
  swatches: document.getElementById('swatches'),
  formError: document.getElementById('form-error'),
  btnAdd: document.getElementById('btn-add'),
  btnRestore: document.getElementById('btn-restore'),
  btnCancel: document.getElementById('btn-cancel'),
  segPos: document.getElementById('seg-pos'),
  chkShowBar: document.getElementById('chk-showbar'),
  inpZIndex: document.getElementById('inp-zindex'),
  chkHover: document.getElementById('chk-hover'),
  chkExpand: document.getElementById('chk-expand'),
  chkDrawerNav: document.getElementById('chk-drawer-nav'),
  chkPanelNav: document.getElementById('chk-panel-nav'),
};

function normalizeZIndexInput(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return HUBS_DEFAULT_PREFS.barZIndex;
  return HubsStorage.clamp(Math.round(num), 1, 2147483647);
}

/* ---------------- 列表渲染 ---------------- */

/** 图标：按 URL 自动取站点 favicon，取不到（error）兜底为首字母色块 */
function iconNode(app) {
  const span = document.createElement('span');
  span.className = 'row-icon';
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

function renderList() {
  els.list.textContent = '';
  els.emptyTip.hidden = apps.length > 0;

  for (const app of apps) {
    const li = document.createElement('li');
    li.className = 'app-item';
    li.dataset.id = app.id;
    li.draggable = true;

    // 上下拖动排序，松手后按 DOM 顺序保存
    li.addEventListener('dragstart', (e) => {
      dragRow = li;
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', app.id);
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('dragging');
      if (dragRow) persistOrder();
      dragRow = null;
    });
    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!dragRow || dragRow === li) return;
      const r = li.getBoundingClientRect();
      els.list.insertBefore(dragRow, e.clientY < r.top + r.height / 2 ? li : li.nextSibling);
    });

    li.appendChild(iconNode(app));

    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = app.name;
    if (app.builtin) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = '内置';
      name.appendChild(badge);
    }
    const url = document.createElement('div');
    url.className = 'url';
    url.textContent = app.url;
    meta.append(name, url);
    li.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'row-actions';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'small-btn';
    edit.textContent = '编辑';
    edit.addEventListener('click', () => openForm(app));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'small-btn danger';
    del.textContent = '删除';
    del.addEventListener('click', () => removeApp(app));
    actions.append(edit, del);
    li.appendChild(actions);

    els.list.appendChild(li);
  }
}

/** 按当前列表 DOM 顺序保存应用排序（storage.onChanged 驱动三端同步） */
async function persistOrder() {
  const order = [...els.list.children].map((li) => li.dataset.id);
  const next = order.map((id) => apps.find((a) => a.id === id)).filter(Boolean);
  if (next.length !== apps.length) return;
  await HubsStorage.saveApps(next);
}

/* ---------------- 表单 ---------------- */

function renderSwatches() {
  els.swatches.textContent = '';
  for (const c of COLOR_PRESETS) {
    const s = document.createElement('button');
    s.type = 'button';
    s.className = 'swatch' + (c.toLowerCase() === els.fColor.value.toLowerCase() ? ' selected' : '');
    s.style.background = c;
    s.title = c;
    s.addEventListener('click', () => {
      els.fColor.value = c;
      renderSwatches();
    });
    els.swatches.appendChild(s);
  }
}

function openForm(app) {
  els.formTitle.textContent = app ? '编辑应用' : '添加应用';
  els.fId.value = app ? app.id : '';
  els.fName.value = app ? app.name : '';
  els.fUrl.value = app ? app.url : '';
  els.fColor.value = (app && app.color) || '#0078d4';
  els.formError.textContent = '';
  renderSwatches();
  els.formCard.hidden = false;
  els.fName.focus();
}

function closeForm() {
  els.formCard.hidden = true;
  els.form.reset();
}

els.btnAdd.addEventListener('click', () => openForm(null));
els.btnCancel.addEventListener('click', closeForm);

els.fColor.addEventListener('input', renderSwatches);

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = els.fName.value.trim();
  const url = HubsStorage.normalizeUrl(els.fUrl.value);
  if (!name) return showError('请填写名称');
  if (!url) return showError('URL 无效，需为 http(s) 链接');

  const data = {
    name,
    url,
    color: els.fColor.value,
  };
  try {
    if (els.fId.value) {
      await HubsStorage.updateApp(els.fId.value, data);
    } else {
      await HubsStorage.addApp(data);
    }
    closeForm();
  } catch (err) {
    showError('保存失败：' + (err && err.message));
  }
});

function showError(msg) {
  els.formError.textContent = msg;
}

/* ---------------- 删除 / 恢复 ---------------- */

async function removeApp(app) {
  if (!confirm(`删除应用「${app.name}」？对应的 iframe 放行规则会一并清理。`)) return;
  await HubsStorage.removeApp(app.id);
  if (!els.formCard.hidden && els.fId.value === app.id) closeForm();
}

els.btnRestore.addEventListener('click', async () => {
  const n = await HubsStorage.restorePresets();
  if (!n) alert('内置预设均已存在。');
});

/* ---------------- 面板偏好：头部吸附位置 ---------------- */

function renderSegPos(pos) {
  const cur = pos || 'top';
  for (const b of els.segPos.querySelectorAll('.seg-btn')) {
    b.classList.toggle('selected', b.dataset.pos === cur);
    b.setAttribute('aria-pressed', b.dataset.pos === cur ? 'true' : 'false');
  }
}

els.segPos.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (btn) HubsStorage.setPrefs({ headerPosition: btn.dataset.pos }).catch(() => {});
});

/* ---------------- 面板偏好：快捷导航浮点 ---------------- */

// 关闭后：页面上的悬浮条与折叠圆点全部隐藏（storage.onChanged 实时同步到所有标签页）
els.chkShowBar.addEventListener('change', () => {
  HubsStorage.setPrefs({ showBar: els.chkShowBar.checked }).catch(() => {});
});

function renderShowBar(show) {
  els.chkShowBar.checked = show !== false; // 缺省视为开启
}

els.inpZIndex.addEventListener('change', () => {
  const value = normalizeZIndexInput(els.inpZIndex.value);
  els.inpZIndex.value = String(value);
  HubsStorage.setPrefs({ barZIndex: value }).catch(() => {});
});

/* ---------------- 面板偏好：悬浮条交互 / 跳转方式 ---------------- */

// hover 模式：移入折叠圆点展开悬浮条，移出自动收起（点击展开的固定不收起）
els.chkHover.addEventListener('change', () => {
  HubsStorage.setPrefs({ hoverExpand: els.chkHover.checked }).catch(() => {});
});

// 快捷面板默认展开：关闭后页面初始只显示折叠圆点
els.chkExpand.addEventListener('change', () => {
  HubsStorage.setPrefs({ barExpanded: els.chkExpand.checked }).catch(() => {});
});

// 抽屉跳转内部打开：抽屉内新开链接原地加载，不另开标签页
els.chkDrawerNav.addEventListener('change', () => {
  HubsStorage.setPrefs({ drawerInternalNav: els.chkDrawerNav.checked }).catch(() => {});
});

// 边栏跳转内部打开：分屏面板内新开链接在面板 iframe 内原地打开
els.chkPanelNav.addEventListener('change', () => {
  HubsStorage.setPrefs({ panelInternalNav: els.chkPanelNav.checked }).catch(() => {});
});

function renderTogglePrefs(prefs) {
  if (!prefs) return;
  els.inpZIndex.value = String(normalizeZIndexInput(prefs.barZIndex));
  els.chkHover.checked = prefs.hoverExpand !== false; // hover/默认展开/抽屉跳转缺省视为开启
  els.chkExpand.checked = prefs.barExpanded !== false;
  els.chkDrawerNav.checked = prefs.drawerInternalNav !== false;
  els.chkPanelNav.checked = prefs.panelInternalNav === true; // 边栏跳转缺省关闭
}

/* ---------------- 启动 / 订阅 ---------------- */

(async () => {
  apps = await HubsStorage.getApps();
  renderList();
  const prefs = await HubsStorage.getPrefs();
  renderSegPos(prefs.headerPosition);
  renderShowBar(prefs.showBar);
  renderTogglePrefs(prefs);
})();

HubsStorage.subscribe((changes) => {
  if (changes.apps) {
    apps = changes.apps;
    renderList();
  }
  if (changes.prefs) {
    renderSegPos(changes.prefs.headerPosition);
    renderShowBar(changes.prefs.showBar);
    renderTogglePrefs(changes.prefs);
  }
});
