// 017-ui-dialog.js — 站内确认框 / 输入框
// 由原 static/app.js 拆分；本文件只放声明，加载时不产生副作用。
//
// 为什么不直接用原生 confirm / prompt：
//   1) 浏览器在「本页已弹出过多次对话框」后会收起一个「阻止此页面创建更多对话框」的勾选项。
//      用户一旦勾上（或系统的企业策略禁用了对话框），confirm() 就永远返回 false、连弹都不弹，
//      调用方写的是 `if (!confirm(...)) return;` —— 表现就是「按钮点了完全没反应」。
//   2) 页面被塞进没有 allow-modals 的沙箱 iframe（各种预览面板、内嵌容器）时，同样被静默吞掉。
// 所以凡是需要用户二次确认 / 输入一行文字的地方，统一走这里自己画的对话框：
// 行为可控（返回 Promise）、样式跟主题/透明度一致、不阻塞渲染线程，也不会被浏览器环境吞掉。

let _hubDlgCur = null;   // 当前打开的对话框句柄（同一时刻只留一个）

// 通用对话框。返回 Promise：
//   confirm 类型 → true / false
//   input   类型 → 输入字符串（已 trim）/ null
// opt: { title, message, okText, cancelText, danger, input, value, placeholder, wide }
function hubDialog(opt) {
  opt = opt || {};
  const isInput = !!opt.input;
  const cancelValue = isInput ? null : false;

  return new Promise(function (resolve) {
    // 上一个还开着：先按「取消」收掉，避免两个框叠在一起后面那个点不到
    if (_hubDlgCur) _hubDlgCur.finish(cancelValue);

    const wrap = document.createElement('div');
    wrap.className = 'hub-modal' + (opt.danger ? ' danger' : '') + (opt.wide ? ' wide' : '');
    wrap.innerHTML =
      '<div class="hm-mask"></div>' +
      '<div class="hm-box" role="dialog" aria-modal="true" tabindex="-1">' +
        (opt.title ? '<div class="hm-tt"></div>' : '') +
        (opt.message ? '<div class="hm-msg"></div>' : '') +
        (isInput ? '<input class="hm-in" type="text" spellcheck="false" autocomplete="off">' : '') +
        '<div class="hm-acts">' +
          (opt.cancelText === '' ? '' : '<button class="hm-btn hm-cancel" type="button"></button>') +
          '<button class="hm-btn hm-ok primary" type="button"></button>' +
        '</div>' +
      '</div>';

    // 文案一律 textContent 写入：消息里常拼用户数据（文件名、网址、标签数），不能当 HTML 解析
    if (opt.title) wrap.querySelector('.hm-tt').textContent = opt.title;
    if (opt.message) wrap.querySelector('.hm-msg').textContent = opt.message;

    const box = wrap.querySelector('.hm-box');
    const okBtn = wrap.querySelector('.hm-ok');
    const cancelBtn = wrap.querySelector('.hm-cancel');
    const input = wrap.querySelector('.hm-in');
    okBtn.textContent = opt.okText || '确定';
    if (cancelBtn) cancelBtn.textContent = opt.cancelText || '取消';
    if (input) {
      input.value = opt.value == null ? '' : String(opt.value);
      if (opt.placeholder) input.placeholder = opt.placeholder;
    }

    const prevFocus = document.activeElement;
    let done = false;

    function finish(val) {
      if (done) return;
      done = true;
      window.removeEventListener('keydown', onKey, true);
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      if (_hubDlgCur === handle) _hubDlgCur = null;
      // 焦点还回原处：否则关掉对话框后键盘快捷键全部失灵（焦点停在被移除的按钮上）
      try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch (e) { /* 原元素已消失，忽略 */ }
      resolve(val);
    }
    function ok() { finish(input ? String(input.value).trim() : true); }

    // 挂在 window 的捕获阶段：枢纽自己的全局快捷键挂在 document 上，
    // window 捕获先于 document，stopPropagation 之后 Ctrl+W / Esc 就不会误伤后面的窗口
    function onKey(e) {
      const k = e.key;
      if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(cancelValue); return; }
      if (k === 'Enter') { e.preventDefault(); e.stopPropagation(); ok(); return; }
      if (k === 'Tab') {
        const items = [input, cancelBtn, okBtn].filter(Boolean);
        const i = items.indexOf(document.activeElement);
        e.preventDefault();
        const n = items[(i + (e.shiftKey ? -1 : 1) + items.length) % items.length] || okBtn;
        n.focus();
        if (n.tagName === 'INPUT') n.select();
        return;
      }
      if (e.ctrlKey || e.metaKey) e.stopPropagation();   // 模态期间屏蔽 Ctrl 组合键
    }

    const handle = { finish: finish };
    _hubDlgCur = handle;

    okBtn.onclick = (e) => { e.stopPropagation(); ok(); };
    if (cancelBtn) cancelBtn.onclick = (e) => { e.stopPropagation(); finish(cancelValue); };
    wrap.querySelector('.hm-mask').onclick = () => finish(cancelValue);
    // 鼠标在框里按下时不要冒泡到桌面（否则会触发窗口拖动 / 取消选中文本等副作用）
    wrap.addEventListener('mousedown', (e) => { e.stopPropagation(); });
    wrap.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    window.addEventListener('keydown', onKey, true);

    document.body.appendChild(wrap);

    // 焦点：输入框优先（并全选，方便直接覆盖旧值），否则落在「确定」上，回车即可确认
    setTimeout(() => {
      if (!wrap.parentNode) return;
      if (input) { input.focus(); input.select(); } else okBtn.focus();
    }, 30);
  });
}

// 二次确认：返回 true / false
function hubConfirm(message, opt) {
  opt = opt || {};
  return hubDialog({
    title: opt.title || '请确认',
    message: message,
    okText: opt.okText || '确定',
    cancelText: opt.cancelText || '取消',
    danger: !!opt.danger,
    wide: !!opt.wide,
  });
}

// 输入一行文字：返回字符串 / null（取消）
function hubPrompt(message, opt) {
  opt = opt || {};
  return hubDialog({
    title: opt.title || '请输入',
    message: message,
    okText: opt.okText || '确定',
    cancelText: opt.cancelText || '取消',
    input: true,
    value: opt.value || '',
    placeholder: opt.placeholder || '',
    wide: !!opt.wide,
  });
}

// 单纯告知（只有一个「知道了」按钮）
function hubAlert(message, opt) {
  opt = opt || {};
  return hubDialog({
    title: opt.title || '提示',
    message: message,
    okText: opt.okText || '知道了',
    cancelText: '',
    wide: !!opt.wide,
  });
}
