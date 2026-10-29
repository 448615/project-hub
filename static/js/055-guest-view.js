// 055-guest-view.js — 访客视图（未登录只读）
//
// 设计边界：访客**不进桌面**。桌面里每个窗口（文件管理、终端、文档、子应用）
// 背后都需要登录态，半登录状态点哪儿都是 401；与其给一堆点了就报错的入口，
// 不如划一条明确的能力边界：能看项目说明，不能动任何东西。
//
// 数据源只有一个：GET /api/public/projects
// （hub/handlers/routes_get.py 里的白名单接口，只含 name/display_name/
//  description/icon/tags，不含 run/port/docs/preview_url 等内部字段）。
// 本文件不请求任何其它 /api/* —— 这是「访客只能浏览」在代码层面的兑现方式。

let _guestWired = false;
let _guestLoading = false;

function _gEl(id) { return document.getElementById(id); }

// 打开访客视图。刻意不用 hideLogin()：那个会 clearAuthDraft()，
// 访客随手点一下就把用户填了一半的邮箱清掉，回来还得重填。
async function enterGuestMode() {
  const view = _gEl('guestView');
  const veil = _gEl('loginVeil');
  if (!view) return;
  if (veil) veil.hidden = true;
  view.hidden = false;
  wireGuest();
  if (!view.dataset.loaded) await loadGuestProjects();
}

// 回到登录：showLogin 会恢复草稿邮箱、清空表单、按上次模式停在对应页签。
function exitGuestMode() {
  const view = _gEl('guestView');
  if (view) view.hidden = true;
  if (typeof showLogin === 'function') showLogin();
}

function wireGuest() {
  if (_guestWired) return;
  _guestWired = true;
  const btn = _gEl('guestLoginBtn');
  if (btn) btn.addEventListener('click', exitGuestMode);
  // Esc 退出：访客视图是全屏的，没有明显的「关闭」控件，键盘用户需要一个出口
  document.addEventListener('keydown', (e) => {
    const v = _gEl('guestView');
    if (e.key === 'Escape' && v && !v.hidden) exitGuestMode();
  });
}

async function loadGuestProjects() {
  const grid = _gEl('guestGrid');
  if (!grid || _guestLoading) return;
  _guestLoading = true;
  grid.textContent = '';
  const tip = document.createElement('div');
  tip.className = 'guest-empty';
  tip.textContent = '正在读取公开项目…';
  grid.appendChild(tip);
  try {
    const r = await fetch(hubApiUrl('/api/public/projects'), {
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json' },
    });
    // 网关拦截返回 HTML：必须单独识别，否则会把「链接不完整」的整页 HTML
    // 当成 JSON 解析失败，报成一句没头没脑的「读取失败」
    const ctype = (r.headers.get('content-type') || '').toLowerCase();
    if (ctype.indexOf('json') < 0) {
      _guestEmpty(grid, '请求被平台网关拦截（HTTP ' + r.status + '）。', '请用带 sharecode 的分享链接打开本应用。');
      return;
    }
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !body || body.ok === false) {
      _guestEmpty(grid, '读取失败：' + ((body && body.error) || ('HTTP ' + r.status)), '');
      return;
    }
    renderGuestCards(body);
    const view = _gEl('guestView');
    if (view) view.dataset.loaded = '1';
  } catch (err) {
    _guestEmpty(grid, '无法连接服务器：' + ((err && err.message) || err), '请确认服务已启动后重试。');
  } finally {
    _guestLoading = false;
  }
}

function _guestEmpty(grid, line1, line2) {
  grid.textContent = '';
  const box = document.createElement('div');
  box.className = 'guest-empty';
  box.textContent = line1;
  if (line2) {
    box.appendChild(document.createElement('br'));
    box.appendChild(document.createTextNode(line2));
  }
  grid.appendChild(box);
}

function renderGuestCards(body) {
  const grid = _gEl('guestGrid');
  const titleEl = _gEl('guestTitle');
  const subEl = _gEl('guestSubtitle');
  if (titleEl && body.title) titleEl.textContent = body.title;
  if (subEl) subEl.textContent = body.subtitle || '';

  const list = Array.isArray(body.projects) ? body.projects : [];
  if (!list.length) {
    _guestEmpty(grid, '这里还没有可公开浏览的项目。', '登录后可查看全部内容。');
    return;
  }

  grid.textContent = '';
  list.forEach((p) => {
    // 用 DOM API + textContent 而不是拼 innerHTML：
    // 项目名和描述来自 config.json（可被运行期写入），拼字符串等于给自己开 XSS 口子
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'guest-card';

    const icon = document.createElement('div');
    icon.className = 'guest-card-icon';
    icon.textContent = p.icon || '📁';

    const name = document.createElement('div');
    name.className = 'guest-card-name';
    name.textContent = p.display_name || p.name || '未命名项目';

    const desc = document.createElement('div');
    desc.className = 'guest-card-desc';
    desc.textContent = p.description || '';

    card.appendChild(icon);
    card.appendChild(name);
    card.appendChild(desc);

    if (Array.isArray(p.tags) && p.tags.length) {
      const tags = document.createElement('div');
      tags.className = 'guest-card-tags';
      p.tags.slice(0, 4).forEach((t) => {
        const chip = document.createElement('span');
        chip.className = 'guest-tag';
        chip.textContent = String(t);
        tags.appendChild(chip);
      });
      card.appendChild(tags);
    }

    const label = p.display_name || p.name || '该项目';
    card.addEventListener('click', () => {
      toast('访客只能浏览项目说明，登录后才能打开「' + label + '」');
    });
    grid.appendChild(card);
  });
}
