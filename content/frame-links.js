'use strict';
/**
 * Content Script（MAIN world / all_frames）—— 抽屉内 iframe 的「新窗口打开」拦截。
 *
 * 所有页面的所有 iframe 都会注入本脚本，但只有确认自己确实是「Hubs 抽屉里的
 * iframe」才会生效，页面自带的第三方 iframe 一律不受影响：
 *  1. 启动时向父窗口 postMessage 探测（__hubs_probe）；
 *  2. 父级悬浮条脚本比对 event.source === drawerIframe.contentWindow，命中才回 __hubs_frame_ok
 *     （contentWindow 引用比对是精确身份校验，伪造不了）；
 *  3. 激活后：a[target=_blank] / form[target=_blank] 改写为 _self，
 *     JS 的 window.open 改为当前框架内原地导航。
 *  4. 另代执行父级转发的前进/后退（__hubs_nav）——跨域 iframe 的 history
 *     父级碰不了，只能由本脚本在页面自己的世界里调。
 *
 * 必须跑在 MAIN world：window.open 覆盖要作用于页面自己的脚本，ISOLATED 世界改不到。
 */

(() => {
  if (window === window.top) return; // 顶层页面交给悬浮条脚本，这里只管 iframe

  let active = false;
  let confirmed = false; // 收到过父级回执（无论开关值）= 身份确认，是 Hubs 抽屉/面板的 iframe

  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || !e.data) return;
    // 父级回执：true 激活拦截；false 关闭（边栏面板在偏好切换时主动推送）
    if (typeof e.data.__hubs_frame_ok !== 'undefined') {
      confirmed = true;
      active = !!e.data.__hubs_frame_ok;
    }
    // 抽屉头部「前进/后退」按钮：只信已确认身份的父级（页面第三方 iframe 不响应）
    if (confirmed && e.data.__hubs_nav === 'back') history.back();
    else if (confirmed && e.data.__hubs_nav === 'forward') history.forward();
  });

  // 探测父级：悬浮条脚本可能晚就绪（document_idle），带重试
  let tries = 0;
  const probe = () => {
    if (active || tries++ > 15) return;
    try {
      window.parent.postMessage({ __hubs_probe: true }, '*');
    } catch {}
    setTimeout(probe, 400);
  };
  probe();

  /** a[target=_blank / _new] → _self（capture 阶段，在默认行为前改写） */
  const rewriteAnchor = (target) => {
    if (!target || !target.closest) return;
    const a = target.closest('a[target]');
    if (a && (a.target === '_blank' || a.target === '_new')) a.target = '_self';
  };
  document.addEventListener('click', (e) => active && rewriteAnchor(e.target), true);
  document.addEventListener('auxclick', (e) => active && rewriteAnchor(e.target), true); // 中键

  /** form target=_blank → _self */
  document.addEventListener('submit', (e) => {
    if (!active) return;
    const f = e.target;
    if (f && f.tagName === 'FORM' && (f.target === '_blank' || f.target === '_new')) f.target = '_self';
  }, true);

  /** JS window.open → 原地导航（保留原函数，未激活时行为不变） */
  const rawOpen = window.open;
  if (typeof rawOpen === 'function') {
    window.open = function (url) {
      if (active && url) {
        location.href = String(url);
        return null;
      }
      return rawOpen.apply(window, arguments);
    };
  }
})();
