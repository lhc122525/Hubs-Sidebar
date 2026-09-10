# Hubs Sidebar（Chrome/Edge MV3）

复刻 Microsoft Edge 被移除的原生 Hubs Sidebar 体验：右缘悬浮快捷条 + 分屏面板 + 可自定义应用。

## 目录结构

```
manifest.json              MV3 清单（sidePanel / storage / declarativeNetRequestWithHostAccess）
background/service-worker.js   面板打开兜底 + FrameRulesService（iframe 放行规则）
content/hubs-bar.js|css    收起态悬浮条（Shadow DOM，毛玻璃质感）
sidepanel/panel.html|css|js    分屏面板（Tab + iframe，display:none 切换不销毁）
options/options.html|css|js    应用管理页（增删改 + 恢复预设）
src/shared/defaults.js     默认应用与偏好
src/shared/storage.js      StorageService —— 三端唯一的存储读写入口
```

## 架构要点

- **逻辑内核统一**：应用/偏好数据只经 `HubsStorage` 读写 `chrome.storage.sync`，三端通过 `storage.onChanged` 实时同步（不轮询）。
- **iframe 放行**：Service Worker 的 `FrameRulesService` 用 `declarativeNetRequest.updateDynamicRules` 为每个应用域名生成 `sub_frame` 规则，剥除响应头 `X-Frame-Options` / `Frame-Options` / `Content-Security-Policy`；规则 ID = 应用 ID 的 FNV-1a 稳定哈希，增删应用自动清理对应规则。
  - 注意：DNR 只能整头移除，无法只摘 CSP 里的 `frame-ancestors` 指令，故整条移除响应 CSP。
- **面板打开**：悬浮条左键图标 → Service Worker 在消息监听器内**同步**调用 `chrome.sidePanel.open({ tabId })`（保住用户手势，像点工具栏扩展图标一样原生开面板）；工具栏按钮通过 `openPanelOnActionClick` 直接打开；极少数失败场景降级为悬浮条旁内嵌抽屉，绝不新开标签页。
- **右键菜单**：右键悬浮条应用图标 → 自定义菜单「边栏打开 / 小窗打开」，小窗 = `chrome.windows.create({ type: 'popup' })` 独立弹窗。
- **iframe 不销毁**：切换 Tab 用 `display:none`，切回不重新加载；iframe 首次激活才懒创建。

## 安装与验收（开发者模式）

1. 打开 `edge://extensions`（Chrome 为 `chrome://extensions`）。
2. 左下角打开 **开发人员模式**。
3. 点击 **加载解压缩的扩展**，选择本项目根目录（含 `manifest.json`）。
4. 验收清单：
   - 任意普通网页（如 `www.bing.com`）右缘出现竖直毛玻璃悬浮条；
   - `edge://`、`chrome://`、Microsoft 商店页自动无悬浮条且控制台无报错（content script 不匹配受限协议）；
   - 拖动悬浮条顶部手柄到左/右边缘，刷新其他页面位置保持（`chrome.storage.sync` 全局记忆）；
   - 点底部折叠按钮 → 收成小圆点，点圆点展开；
   - 点应用图标 → 侧边分屏面板打开并切到该应用；点 Logo → 打开面板保持上次应用；
   - 工具栏扩展按钮 → 直接打开面板（兜底不可注入页面）；
   - 面板内切换 Tab 不重新加载；刷新按钮重载当前应用；「新标签打开」「管理应用」按钮可用；
   - 管理页增/删/改应用后，悬浮条图标与面板 Tab 立即同步，`edge://extensions` → 扩展详情 → 查看 `declarativeNetRequest` 动态规则随应用增删同步增删；
   - Copilot / DeepL 等 iframe 受限站点能在面板内正常加载（放行规则生效）。

## 已知限制

- `chrome://`、`edge://`、Web Store 等浏览器内部页无法被 iframe 嵌入，也无法注入内容脚本（浏览器安全边界）。
- 少数站点还会用 JS 检测顶層窗口或需要登录 Cookie（第三方 Cookie 拦截时可能要求在新标签页打开）。
