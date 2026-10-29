// HTML 净化回归测试（P0 安全基线）。
// 两部分：
//  1) 攻击向量必须被中和、正常排版必须保留；
//  2) 后端（src/lib/sanitize.js）与前端镜像（public/js/core/sanitize.js）
//     对同一组向量的输出必须完全一致——防止两端策略漂移。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeHtml as back } from '../src/lib/sanitize.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 前端镜像为浏览器 ESM（package.json 无 type:module，不能直接 import），
// 以 data: URL 动态载入进行同环境对比。
// 注意路径：镜像文件在 public/js/core/ 下（早先是 public/js/，移动后此处未同步，
// 测试一直因 ENOENT 失败而没人发现）。
const frontSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'core', 'sanitize.js'), 'utf8');
const front = await import('data:text/javascript,' + encodeURIComponent(frontSrc));

// 攻击向量：input 输入，drop 不得出现在输出，keep 必须出现在输出
const VECTORS = [
  { name: 'script 标签连内容移除', input: '<p>ok</p><script>alert(1)</script>', drop: ['alert', 'script'], keep: ['<p>ok</p>'] },
  { name: 'img 内联事件处理器', input: '<img src="/a.png" onerror="alert(1)">', drop: ['onerror', 'alert'], keep: ['src="/a.png"'] },
  { name: 'javascript: 协议（小写）', input: '<a href="javascript:alert(1)">x</a>', drop: ['javascript', 'alert'], keep: ['>x</a>'] },
  { name: 'javascript: 协议（大小写变形）', input: '<a href="JaVaScRiPt:alert(1)">x</a>', drop: ['alert'], keep: ['>x</a>'] },
  { name: 'vbscript: 协议', input: '<a href="vbscript:msgbox(1)">x</a>', drop: ['vbscript', 'msgbox'] },
  { name: '数字实体编码协议', input: '<a href="&#106;avascript:alert(1)">x</a>', drop: ['alert'] },
  { name: '十六进制实体编码协议', input: '<a href="&#x6A;avascript:alert(1)">x</a>', drop: ['alert'] },
  { name: '协议内制表符', input: '<a href="java\tscript:alert(1)">x</a>', drop: ['alert'] },
  { name: '协议内换行与实体混合', input: '<a href="&#x6a;avas\ncript:alert(1)">x</a>', drop: ['alert'] },
  { name: 'data: URL', input: '<img src="data:image/svg+xml,<svg onload=alert(1)>">', drop: ['data:', 'onload'] },
  { name: '协议相对 URL', input: '<a href="//evil.com">x</a>', drop: ['evil.com'] },
  { name: 'svg 挟带 script', input: '<svg><script>alert(1)</script></svg><p>keep</p>', drop: ['alert'], keep: ['<p>keep</p>'] },
  { name: 'math 挟带', input: '<math><mtext><script>alert(1)</script></mtext></math><p>k</p>', drop: ['alert'], keep: ['<p>k</p>'] },
  { name: 'iframe 连内容移除', input: '<iframe src="https://evil.com"></iframe><p>keep</p>', drop: ['iframe', 'evil.com'], keep: ['<p>keep</p>'] },
  { name: 'style 标签', input: '<style>body{display:none}</style><p>keep</p>', drop: ['style', 'display:none'], keep: ['<p>keep</p>'] },
  { name: 'style 属性', input: '<p style="background:url(javascript:alert(1))">t</p>', drop: ['style', 'javascript'], keep: ['<p>t</p>'] },
  { name: 'class/id 属性剥离', input: '<p class="x" id="y" data-z="1">t</p>', drop: ['class', 'id=', 'data-z'], keep: ['<p>t</p>'] },
  { name: 'onclick 属性', input: '<p onclick="alert(1)">text</p>', drop: ['onclick', 'alert'], keep: ['<p>text</p>'] },
  { name: 'HTML 注释挟持', input: '<p>a</p><!-- <script>alert(1)</script> -->', drop: ['alert', '<!--'], keep: ['<p>a</p>'] },
  { name: 'CDATA 挟持', input: '<p>a</p><![CDATA[<script>alert(1)</script>]]>', drop: ['alert'], keep: ['<p>a</p>'] },
  { name: '未闭合 script', input: '<p>a</p><script>alert(1)', drop: ['alert'], keep: ['<p>a</p>'] },
  { name: '大写 SCRIPT', input: '<SCRIPT>alert(1)</SCRIPT><p>k</p>', drop: ['alert'], keep: ['<p>k</p>'] },
  { name: '大小写混合 onclick', input: '<p OnClick="alert(1)">t</p>', drop: ['alert', 'onclick'], keep: ['<p>t</p>'] },
  { name: '未列入白名单的标签去标签保内容', input: '<font color="red">彩色</font><center>居中</center>', keep: ['彩色', '居中'], drop: ['font', 'center'] },
  { name: '布尔属性丢弃', input: '<input disabled value="x"><p>t</p>', drop: ['input', 'disabled'], keep: ['<p>t</p>'] },
];

for (const v of VECTORS) {
  test('净化向量：' + v.name, () => {
    const out = back(v.input);
    for (const bad of v.drop || []) {
      assert.ok(!out.toLowerCase().includes(bad.toLowerCase()), `输出不应包含 ${bad} → ${out}`);
    }
    for (const good of v.keep || []) {
      assert.ok(out.includes(good), `输出应保留 ${good} → ${out}`);
    }
  });
}

test('净化：正常排版完整保留', () => {
  const clean = '<h2>标题</h2><p><strong>粗体</strong>与<em>斜体</em>，<a href="https://example.com" title="t">链接</a></p>'
    + '<ul><li>一</li><li>二</li></ul><blockquote><p>引用</p></blockquote><pre><code>const a = 1;</code></pre>'
    + '<img src="/uploads/x.png" alt="图" width="80"><hr>'
    + '<table><thead><tr><th>H</th></tr></thead><tbody><tr><td>D</td></tr></tbody></table>';
  const out = back(clean);
  for (const frag of [
    '<h2>标题</h2>', '<strong>粗体</strong>', '<em>斜体</em>',
    '<a href="https://example.com" title="t">链接</a>',
    '<ul><li>一</li><li>二</li></ul>', '<blockquote><p>引用</p></blockquote>',
    '<pre><code>const a = 1;</code></pre>',
    '<img src="/uploads/x.png" alt="图" width="80">', '<hr>',
    '<th>H</th>', '<td>D</td>',
  ]) {
    assert.ok(out.includes(frag), `应保留 ${frag} → ${out}`);
  }
});

test('净化：相对路径与锚点允许', () => {
  assert.ok(back('<a href="/about">a</a>').includes('href="/about"'));
  assert.ok(back('<a href="#sec">a</a>').includes('href="#sec"'));
  assert.ok(back('<a href="./rel/path">a</a>').includes('href="./rel/path"'));
  assert.ok(back('<img src="https://cdn.example.com/a.png">').includes('src="https://cdn.example.com/a.png"'));
});

test('净化：target=_blank 自动补 rel，其他 target 剥离', () => {
  const out = back('<a href="https://x.com" target="_blank">t</a>');
  assert.ok(out.includes('target="_blank"'));
  assert.ok(out.includes('rel="noopener noreferrer"'));
  assert.equal(out.match(/rel=/g).length, 1, 'rel 只能出现一次');
  assert.ok(!back('<a href="https://x.com" target="_self">t</a>').includes('_self'));
});

test('净化：文本转义与实体保留', () => {
  assert.equal(back('a & b'), 'a &amp; b');
  assert.equal(back('a &amp; b'), 'a &amp; b', '合法实体应保留（不双重转义）');
  assert.equal(back('<p>1 < 2</p>'), '<p>1 &lt; 2</p>');
  assert.equal(back(''), '');
  assert.equal(back(null), '');
  assert.equal(back(undefined), '');
});

test('净化：属性值中的引号被转义，不破坏标签结构', () => {
  const out = back('<a title=\'he said "hi"\'>t</a>');
  assert.ok(out.includes('title="he said &quot;hi&quot;"'), `→ ${out}`);
  assert.ok(!out.includes("'he said"), '单引号属性值应被规范化为双引号');
});

test('净化：畸形输入不崩溃', () => {
  for (const bad of ['<', '<<<', '<p', '<p ', '<a href=', '"', "'", '<>', '</>', '<p></p></p>', '&', '&#xZZ;', '&#999999999;']) {
    assert.doesNotThrow(() => back(bad), `输入 ${JSON.stringify(bad)} 不应抛错`);
  }
});

test('净化：前后端实现输出一致（防策略漂移）', () => {
  for (const v of VECTORS) {
    assert.equal(front.sanitizeHtml(v.input), back(v.input), `向量「${v.name}」前后端输出不一致`);
  }
  const clean = '<h2>标题</h2><p><a href="https://example.com" title="t">链接</a><img src="/a.png" alt="x" width="10"></p><table><tr><td colspan="2">c</td></tr></table>';
  assert.equal(front.sanitizeHtml(clean), back(clean), '正常排版前后端输出不一致');
  assert.equal(front.sanitizeHtml(''), back(''), '空输入前后端输出不一致');
});
