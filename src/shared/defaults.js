'use strict';
/**
 * 默认配置（全局脚本，无模块化——Content Script 与经典 Service Worker 共用）
 * 各端通过 <script src> / importScripts 引入后使用全局变量 HUBS_DEFAULT_APPS / HUBS_DEFAULT_PREFS
 */

const HUBS_DEFAULT_APPS = [
  { id: 'preset-feileyu',   name: '非乐鱼导航',   url: 'https://feileyu.cn/', color: '#0f2b46', builtin: true },
  { id: 'preset-bing',    name: '搜索',   url: 'https://www.bing.com', color: '#0078d4', builtin: true },
  { id: 'preset-google', name: 'Google', url: 'https://www.google.com/', color: '#0f6cbd', builtin: true },
  { id: 'preset-deepseek',    name: 'Deepseek Chat',  url: 'https://chat.deepseek.com/', color: '#2564cf', builtin: true },
  { id: 'preset-tinify', name: '熊猫压缩', url: 'https://tinify.cn/',   color: '#5b5fc7', builtin: true },
  { id: 'preset-youku',    name: '优酷',  url: 'https://www.youku.com/', color: '#2564cf', builtin: true },
  { id: 'preset-douyin',    name: '抖音',  url: 'https://www.douyin.com/', color: '#2564cf', builtin: true },
  { id: 'preset-tiktok',    name: '抖音Tok',  url: 'https://www.tiktok.com/', color: '#2564cf', builtin: true },
];

/** 悬浮条/面板偏好：side 悬浮条固定侧，topRatio 垂直位置（0~1），collapsed 折叠圆点，headerPosition 面板头部吸附边 */
const HUBS_DEFAULT_PREFS = {
  side: 'right',
  topRatio: 0.5,
  collapsed: false,
  lastActiveApp: null,
  headerPosition: 'top',
  drawerW: 400, // 抽屉宽度（可拖拽调整，全局记忆）
  drawerH: 0, // 抽屉高度，0 = 自适应（72vh）
  drawerX: null, // 抽屉自由定位（拖标题栏后记录左上角坐标）；null = 跟随悬浮条定位
  drawerY: null,
  showBar: true, // 是否展示页面上的快捷导航浮点（关闭后悬浮条与折叠圆点都不注入显示）
  hoverExpand: true, // hover 模式：移入折叠圆点展开悬浮条，移出自动收起（点击展开的固定不收起）
  barExpanded: true, // 快捷面板默认展开（false = 页面初始只显示折叠圆点，点击才展开）
  drawerInternalNav: true, // 抽屉内新开链接在抽屉 iframe 内原地打开（frame-links 拦截）
  panelInternalNav: false, // 边栏（分屏面板）内新开链接在面板 iframe 内原地打开
};

/**
 * 由应用 URL 生成站点 favicon 图片地址（Chrome 内建 favicon 库，需 manifest 声明 "favicon" 权限；
 * 内容脚本中使用还需把 "_favicon/*" 声明为 web_accessible_resources）。
 * 图标取不到时由 <img> 的 error 事件兜底为首字母色块。
 */
function hubsFaviconUrl(pageUrl, size = 32) {
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', pageUrl);
  u.searchParams.set('size', String(size));
  return u.href;
}
