// 关键路径 E2E：登录 → 发布内容 → 上传媒体 → 退出。
// 覆盖「每次发布最不能坏」的主链路；细节行为由 tests/ 的 node:test 锁定。
//
// 选择器均按 public/js/main.js 的真实 DOM 校准（2026-10-14 首次真实浏览器运行通过）：
//   登录表单 #email/#password/#auth-submit（main.js renderLogin）
//   侧边导航 a[data-h="#/posts"] / a[data-h="#/media"]（constants.js NAV）
//   新建入口 a[href="#/posts/new"]（renderPosts 工具栏）
//   编辑器 #e-title / #e-editor-mount .rte-area（renderEditor + editor.js createEditor）
//   发布 = #e-status 选 published + 点 #save（admin 自带 post:publish）
//   媒体上传 input#up（renderMedia，隐藏域，setInputFiles 可直接写入）
//   退出 #logout（renderShell 顶栏）
const { test, expect } = require('@playwright/test');

const ADMIN = { email: 'admin@cms.local', password: 'Admin@123456' };

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test('登录 → 发布内容 → 上传媒体 → 退出', async ({ page }) => {
  // 1. 登录（renderLogin：#email / #password / #auth-submit）
  await page.fill('#email', ADMIN.email);
  await page.fill('#password', ADMIN.password);
  await page.click('#auth-submit');
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 10000 });

  // 2. 发布一篇文章（编辑器：标题 / 正文 / 状态=已发布 / 保存）
  await page.click('a[data-h="#/posts"]'); // 侧边栏「内容管理」
  await page.click('a[href="#/posts/new"]'); // 工具栏「+ 新建内容」
  await page.fill('#e-title', 'E2E 冒烟文章');
  await page.fill('#e-editor-mount .rte-area', 'E2E 自动发布的正文');
  await page.selectOption('#e-status', 'published');
  await page.click('#save');
  // 保存成功后 location.hash 回到 '#/posts'，列表应出现该标题
  await expect(page.locator('text=E2E 冒烟文章').first()).toBeVisible({ timeout: 10000 });

  // 3. 上传媒体（1x1 PNG；#up 为隐藏 file input，setInputFiles 可直接写入）
  await page.click('a[data-h="#/media"]');
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f4d0000000049454e44ae426082',
    'hex'
  );
  await page.setInputFiles('#up', { name: 'e2e.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('text=e2e.png').first()).toBeVisible({ timeout: 10000 });

  // 4. 退出登录（顶栏 #logout，退出后回到登录表单）
  await page.click('#logout');
  await expect(page.locator('#password')).toBeVisible({ timeout: 10000 });
});
