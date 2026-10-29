// HTML 白名单净化器（后端权威版，P0 安全基线）。
// 旧版为「正则黑名单」，可被大小写变形（<SCRIPT>）、属性实体编码
// （href="&#106;avascript:..."）、协议内空白/控制字符（java\tscript:）、
// 注释挟持等手段绕过。本实现改为三重白名单：
//   1) 标签白名单（未列入的标签去标签保内容；危险标签连内容一起移除）；
//   2) 属性白名单（class/id/style 等一律剥离，防样式挟持）；
//   3) URL 协议白名单（http/https/mailto/tel + 相对路径，其余拒绝；
//      校验前先做 HTML 实体解码并剔除控制字符，消除变形绕过）。
// 与前端 public/js/sanitize.js 是同一策略的镜像实现（供编辑器载入内容时
// 做第二道防护），两者由 tests/sanitize.test.mjs 以同一组攻击向量对比校验，
// 防止策略漂移。

const VOID_TAGS = new Set(['br', 'hr', 'img']);
// 危险标签：连标签带内容一起移除（其文本不应作为正文展示）
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'applet', 'noscript', 'template',
  'title', 'textarea', 'xmp', 'noframes', 'frame', 'frameset', 'head',
  'base', 'link', 'meta', 'svg', 'math',
]);
// 允许保留的排版标签
const ALLOWED_TAGS = new Set([
  'p', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del', 'ins',
  'mark', 'small', 'sub', 'sup', 'span', 'div',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'a', 'img', 'figure', 'figcaption',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'caption',
]);
// 每个标签允许的属性（其余一律剥离）
const TAG_ATTRS = {
  a: ['href', 'title', 'target', 'rel'],
  img: ['src', 'alt', 'title', 'width', 'height'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan'],
};
const URL_ATTRS = new Set(['href', 'src']);
const SAFE_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', tab: '\t', newline: '\n',
};

// 解码常见 HTML 实体（含十进制/十六进制数字实体），用于「校验前归一化」
function decodeEntities(s) {
  return String(s).replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (m, body) => {
    if (body[0] === '#') {
      const code = /^#[xX]/.test(body) ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch (e) { return ''; }
      }
      return '';
    }
    const v = NAMED_ENTITIES[body.toLowerCase()];
    return v !== undefined ? v : m;
  });
}

// URL 安全校验：先解码实体，再剔除浏览器会忽略的控制/空白字符，最后校验协议白名单
function safeUrl(raw) {
  const v = decodeEntities(String(raw)).replace(/[\u0000-\u0020\u007f-\u00a0]+/g, '');
  if (!v) return null;
  const scheme = v.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (scheme) {
    return SAFE_SCHEMES.has(scheme[1].toLowerCase()) ? v : null;
  }
  if (v.startsWith('//')) return null; // 协议相对 URL：继承页面协议，禁止
  return v; // 相对路径 / 锚点 / 查询串
}

// 仅转义「孤立的 &」，保留合法实体（&amp;、&#106; 等），避免双重转义
const BARE_AMP = /&(?![a-zA-Z][a-zA-Z0-9]*;|#[0-9]+;|#[xX][0-9a-fA-F]+;)/g;
function escText(s) {
  return String(s).replace(BARE_AMP, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(s) {
  return escText(s).replace(/"/g, '&quot;');
}

// 解析单个开始标签的属性串，按白名单重建
function buildAttrs(tag, attrsStr) {
  const allowed = TAG_ATTRS[tag] || [];
  const seen = new Set();
  const out = [];
  let hasBlank = false;
  let relAdded = false;
  const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))|([a-zA-Z_:][-a-zA-Z0-9_:.]*)/g;
  let m;
  while ((m = ATTR_RE.exec(attrsStr))) {
    const name = (m[1] || m[5] || '').toLowerCase();
    if (!name || seen.has(name) || !allowed.includes(name)) continue;
    if (!m[1]) continue; // 无值布尔属性一律丢弃
    seen.add(name);
    const raw = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
    if (URL_ATTRS.has(name)) {
      const v = safeUrl(raw);
      if (v === null) continue;
      out.push(` ${name}="${escAttr(v)}"`);
      continue;
    }
    const v = decodeEntities(raw).trim();
    if (name === 'target') {
      if (v !== '_blank') continue;
      out.push(' target="_blank"');
      hasBlank = true;
      continue;
    }
    if (name === 'rel') continue; // rel 由 target 逻辑统一生成
    if (name === 'width' || name === 'height') {
      if (!/^\d{1,4}$/.test(v)) continue;
    }
    if (name === 'colspan' || name === 'rowspan') {
      if (!/^\d{1,3}$/.test(v)) continue;
    }
    out.push(` ${name}="${escAttr(v)}"`);
  }
  // target=_blank 的链接统一补 rel="noopener noreferrer"（仅补一次）
  if (tag === 'a' && hasBlank && !relAdded) {
    out.push(' rel="noopener noreferrer"');
    relAdded = true;
  }
  return out.join('');
}

// 标签 token：开始/结束标签（属性部分容忍引号内包含 >）；注释与 CDATA 单独匹配
const TOKEN_RE = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<(\/)?\s*([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)\s*(\/?)>/g;

function sanitizeHtml(html) {
  if (!html) return '';
  const src = String(html);
  let out = '';
  let last = 0;
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(src))) {
    out += escText(src.slice(last, m.index));
    last = TOKEN_RE.lastIndex;
    const whole = m[0];
    if (whole.startsWith('<!--') || whole.startsWith('<![CDATA[')) continue; // 注释/CDATA 丢弃
    const closing = !!m[1];
    const tag = m[2].toLowerCase();
    if (DROP_WITH_CONTENT.has(tag)) {
      if (!closing) {
        // 跳过与之匹配的闭合标签之间的全部内容；找不到闭合则丢弃剩余全部
        const rest = src.slice(last);
        const cm = rest.match(new RegExp('</\\s*' + tag + '\\s*>', 'i'));
        last = cm ? last + cm.index + cm[0].length : src.length;
        TOKEN_RE.lastIndex = last;
      }
      continue;
    }
    if (!ALLOWED_TAGS.has(tag)) continue; // 未列入白名单：去标签、保留内容
    if (closing) {
      if (!VOID_TAGS.has(tag)) out += '</' + tag + '>';
      continue;
    }
    out += '<' + tag + buildAttrs(tag, m[3] || '') + '>';
  }
  out += escText(src.slice(last));
  return out;
}

module.exports = { sanitizeHtml };
