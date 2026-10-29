# 本发行包许可证范围说明

本发行包（starshu-bundle）包含两个独立组件，各自采用 **AGPLv3 / 商业订阅** 双许可证。
本文件仅作聚合说明，**不替代**任何组件的许可证正文；法律效力以各组件目录下的许可证文件为准。

---

## 1. 组件清单

| 组件 | 位置 | 包含内容 | 许可证位置 |
|---|---|---|---|
| **星枢（starshu）** | 发行包根目录 | 源码 + 构建产物 | 根目录 `LICENSE.txt` / `LICENSE.COMMERCIAL.txt` / `agpl-3.0.txt` |
| **桓梦工作台（huandream-workbench）** | `workbench/www/` | 仅构建产物 | `workbench/www/LICENSE.txt` / `LICENSE.COMMERCIAL.txt` / `agpl-3.0.txt` |

> ⚠️ 根目录 `LICENSE.txt` **仅覆盖星枢组件**，不覆盖 `workbench/`。
> 桓梦工作台的许可证见 `workbench/www/LICENSE.txt`，其中保留原作者「晨」的署名与格言文集归属。

---

## 2. 源码获取

### 星枢（starshu）

本发行包已包含星枢完整源码，位于根目录，无需额外获取。

### 桓梦工作台（huandream-workbench）

本发行包为**离线交付**，仅包含桓梦工作台的构建产物（`workbench/www/`）。
根据 GNU AGPLv3 第 6(b) 条，对应源码通过**书面要约**方式提供：

- **联系邮箱**：lzc737507@outlook.com
- **提供方式**：电子源码包（压缩包）或物理介质（U 盘 / 光盘）
- **费用**：不超过提供源码的合理成本（电子交付通常免费）
- **有效期**：自本发行版交付之日起至少 **三年**

详见 [`workbench/www/WRITTEN_OFFER.md`](./workbench/www/WRITTEN_OFFER.md)。
该书面要约不可撤销，且在有效期内持续有效。

---

## 3. 商业订阅覆盖范围

本发行包若作为商业产品交付，商业订阅覆盖范围如下：

- **分别订阅**：星枢与桓梦工作台需分别订阅，以各自 `LICENSE.COMMERCIAL.txt` 为准。

商业订阅的价值是：闭源修改豁免、官方品牌移除、24h 技术支持 SLA、商业责任担保；
**不改变 AGPLv3 赋予用户的任何权利，也不是代码功能阉割。**

---

## 4. 第三方资产

- 星枢的第三方依赖声明见根目录 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。
- 桓梦工作台运行时零第三方依赖（仅构建期使用 Vite），无独立第三方声明文件。

---

## 5. 组件间关系

- 两个组件**数据完全隔离**：星枢使用服务端 SQLite（`data/cms.db`），桓梦使用浏览器 localStorage / IndexedDB。
- 两个组件**可独立运行**，也可通过星枢的 `/workbench/` 子路径静态挂载统一入口。
- 静态挂载属于 AGPLv3 §5 所述“聚合体”，不触发许可传染。

---

## 6. 联系方式

**蓝域星河有限公司集团**
- 系统网站：https://aitanser.github.io/starsea-os/
- 电子邮箱：lzc737507@outlook.com

---

**Developed by 蓝域星河有限公司集团**