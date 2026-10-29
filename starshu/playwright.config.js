// Playwright 配置：关键路径 E2E（P3-2）。
// webServer 以「临时库 + 固定端口」启动真实服务，跑完即关；
// 用例不触碰开发库 data/starshu.db（与 tests/ 的隔离策略一致）。
const { defineConfig } = require('@playwright/test');

const PORT = 3311;

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 30000,
  retries: 0,
  workers: 1, // 单库单服务，禁并行
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
    // 本地 Windows 无预装 Playwright Chromium（官方 CDN 下载极慢），
    // 驱动系统自带 Edge 零下载；CI（ubuntu-latest）由 job 内
    // `npx playwright install chromium` 提供 bundled 浏览器，不走 channel。
    ...(process.env.CI ? {} : { channel: 'msedge' }),
  },
  webServer: {
    command: `node server.js`,
    env: {
      PORT: String(PORT),
      DB_FILE: `${process.env.TMPDIR || process.env.TEMP || '/tmp'}/cms-e2e/e2e.db`,
    },
    url: `http://127.0.0.1:${PORT}/api/health`,
    timeout: 20000,
    reuseExistingServer: false,
  },
});
