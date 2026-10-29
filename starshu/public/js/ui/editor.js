// 富文本编辑器（轻量、零依赖）：工具栏 + contenteditable 区域。
// 基于浏览器原生 execCommand（全平台支持），输出受信任作者撰写的 HTML。
// 用法：const ed = createEditor({ mount, value, minHeight, placeholder, onChange });
//       ed.getValue() / ed.setValue(html) / ed.focus() / ed.destroy()
//
// 安全说明：载入内容（初始 value 与 setValue）一律先经 sanitizeHtml 白名单净化，
// 与后端「写入时净化」构成纵深防御，防止库中残留恶意 HTML 在编辑器中实例化执行。
import { sanitizeHtml } from '../core/sanitize.js';

const SVG = {
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.6"/><path d="M21 15l-5-5L5 21"/></svg>',
  alignL: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="15" y2="12"/><line x1="3" y1="18" x2="18" y2="18"/></svg>',
  alignC: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="6" y1="12" x2="18" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg>',
  alignR: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="6" y1="18" x2="21" y2="18"/></svg>',
};

// 工具栏分组：cmd=execCommand 命令；v=formatBlock 的块标签；t=按钮文字；svg=使用 SVG 图标
const GROUPS = [
  [
    { cmd: 'bold', t: 'B', cls: 'b', title: '加粗 (Ctrl+B)' },
    { cmd: 'italic', t: 'I', cls: 'i', title: '斜体 (Ctrl+I)' },
    { cmd: 'underline', t: 'U', cls: 'u', title: '下划线 (Ctrl+U)' },
    { cmd: 'strikeThrough', t: 'S', cls: 's', title: '删除线' },
  ],
  [
    { cmd: 'formatBlock', v: 'H2', t: 'H2', title: '标题 2' },
    { cmd: 'formatBlock', v: 'H3', t: 'H3', title: '标题 3' },
    { cmd: 'formatBlock', v: 'P', t: '¶', title: '正文段落' },
  ],
  [
    { cmd: 'insertUnorderedList', t: '•', title: '无序列表' },
    { cmd: 'insertOrderedList', t: '1.', title: '有序列表' },
    { cmd: 'formatBlock', v: 'BLOCKQUOTE', t: '❝', title: '引用块' },
  ],
  [
    { cmd: 'formatBlock', v: 'PRE', t: '</>', title: '代码块' },
    { cmd: 'insertHorizontalRule', t: '―', title: '分割线' },
    { cmd: 'createLink', t: SVG.link, svg: true, title: '插入链接' },
    { cmd: 'insertImage', t: SVG.image, svg: true, title: '插入图片（URL）' },
  ],
  [
    { cmd: 'justifyLeft', t: SVG.alignL, svg: true, title: '左对齐' },
    { cmd: 'justifyCenter', t: SVG.alignC, svg: true, title: '居中' },
    { cmd: 'justifyRight', t: SVG.alignR, svg: true, title: '右对齐' },
  ],
  [
    { cmd: 'removeFormat', t: '⌫', title: '清除格式' },
  ],
];

const TOGGLE_CMDS = ['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList', 'justifyLeft', 'justifyCenter', 'justifyRight'];

export function createEditor({ mount, value = '', minHeight = 280, placeholder = '在此撰写正文…', onChange } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'rte';

  const toolbar = document.createElement('div');
  toolbar.className = 'rte-toolbar';

  const area = document.createElement('div');
  area.className = 'rte-area';
  area.setAttribute('contenteditable', 'true');
  area.setAttribute('role', 'textbox');
  area.setAttribute('aria-multiline', 'true');
  area.setAttribute('data-placeholder', placeholder);
  area.style.minHeight = minHeight + 'px';

  GROUPS.forEach((group, gi) => {
    group.forEach((item) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rte-btn' + (item.cls ? ' ' + item.cls : '');
      btn.title = item.title || '';
      btn.dataset.cmd = item.cmd;
      if (item.v) btn.dataset.value = item.v;
      btn.innerHTML = item.svg ? item.t : item.t;
      btn.addEventListener('mousedown', (e) => e.preventDefault()); // 保持选区
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        exec(item, area);
        sync();
        refresh();
      });
      toolbar.appendChild(btn);
    });
    if (gi < GROUPS.length - 1) {
      const sep = document.createElement('span');
      sep.className = 'rte-sep';
      toolbar.appendChild(sep);
    }
  });

  wrap.appendChild(toolbar);
  wrap.appendChild(area);
  mount.appendChild(wrap);

  area.innerHTML = sanitizeHtml(value) || '';

  // 同步隐藏值 + 触发 onChange
  function sync() {
    const html = area.innerHTML;
    if (onChange) onChange(html);
  }
  // 空闲时若只剩空白节点，清空以保持 :empty 占位符
  function normalize() {
    if (!area.textContent.trim() && !area.querySelector('img,hr,blockquote,pre,ul,ol')) area.innerHTML = '';
  }
  function onInput() { normalize(); sync(); refresh(); }
  function refresh() {
    const sel = window.getSelection();
    if (!sel || !sel.anchorNode || !area.contains(sel.anchorNode)) return;
    toolbar.querySelectorAll('.rte-btn').forEach((b) => {
      const cmd = b.dataset.cmd, v = b.dataset.value;
      let active = false;
      try {
        if (cmd === 'formatBlock') active = (document.queryCommandValue('formatBlock') || '').toUpperCase() === (v || '').toUpperCase();
        else if (TOGGLE_CMDS.includes(cmd)) active = document.queryCommandState(cmd);
      } catch (_) { /* 某些浏览器在无选区时抛错，忽略 */ }
      b.classList.toggle('active', active);
    });
  }

  area.addEventListener('input', onInput);
  area.addEventListener('keyup', refresh);
  area.addEventListener('mouseup', refresh);
  const onSelChange = () => refresh();
  document.addEventListener('selectionchange', onSelChange);

  function exec(item, el) {
    el.focus();
    const cmd = item.cmd;
    if (cmd === 'createLink') {
      const url = window.prompt('链接地址（http/https）：', 'https://');
      if (!url) return;
      document.execCommand('createLink', false, url);
      // 给新链接添加安全属性
      const sel = window.getSelection();
      if (sel && sel.anchorNode) {
        const a = sel.anchorNode.parentElement && sel.anchorNode.parentElement.closest ? sel.anchorNode.parentElement.closest('a') : null;
        if (a) { a.setAttribute('rel', 'noopener noreferrer'); a.target = '_blank'; }
      }
      return;
    }
    if (cmd === 'insertImage') {
      const url = window.prompt('图片 URL：', 'https://');
      if (!url) return;
      document.execCommand('insertImage', false, url);
      return;
    }
    if (cmd === 'formatBlock') { document.execCommand('formatBlock', false, item.v); return; }
    document.execCommand(cmd, false, null);
  }

  return {
    el: wrap,
    getValue: () => area.innerHTML,
    setValue: (html) => { area.innerHTML = sanitizeHtml(html) || ''; sync(); },
    focus: () => area.focus(),
    destroy: () => { document.removeEventListener('selectionchange', onSelChange); wrap.remove(); },
  };
}
