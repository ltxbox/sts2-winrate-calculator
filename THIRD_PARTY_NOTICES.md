# Third-Party Notices

本项目的代码（`server.mjs`、`public/`、`lib/`、`tools/`、`test/`）为 MIT 许可，版权归本仓库作者。

## CombatSolver（离线战斗求解器）

- 项目：https://github.com/Torch1230/CombatSolver
- 许可：MIT License，Copyright (c) 2026 Torch1230 and contributors，
  portions derived from Random Foreseer (Copyright (c) 2026 hotwords123)
- 用途：本项目的网页只负责拼请求和展示结果。真正的战斗模拟由 CombatSolver 的
  `OfflineSearchHarness` 完成。**本仓库不包含它的二进制**；打包版（Releases 里的 zip）
  按 MIT 许可随包分发构建产物，并保留其 LICENSE 与 `THIRD_PARTY_NOTICES.md`。

## Random Foreseer

- 项目：https://github.com/hotwords123/StS2.RandomForeseer
- 说明：CombatSolver 的内置战斗模拟内核使用并改造了 Random Foreseer 的部分实现，
  已获原作者许可（详见 CombatSolver 仓库的 `THIRD_PARTY_NOTICES.md`）。

## RitsuLib

- 创意工坊：Slay the Spire 2 的 RitsuLib（id 3747602295）
- 说明：CombatSolver 运行所需的 Harmony 补丁库，由用户从创意工坊自行订阅，本项目不分发。

## 《杀戮尖塔 2》游戏数据

- 版权：MegaCrit
- 说明：`assets/*.json`（卡牌/遗物索引、初始卡组、恐惧领域表）是从游戏本体导出的数据，
  仅为让工具在你自己的机器上可用；本项目不分发游戏图片、音频与本地化原文。
  若权利方要求，会移除或改为「由用户本地生成」。
