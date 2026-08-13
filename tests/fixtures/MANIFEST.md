# 合成 Fixture 清单

## 说明

- 本目录包含阶段 1 已批准的 Schema 无关纯文本输入，以及阶段 2 已批准的合成项目目录。
- 所有内容均为重新创作的 2098 或 2099 年虚构材料，`synthetic: yes`。
- 未复制或轻量改写 `news` 中的纪要、稿件、检索正文、培训 PPT 原文或二进制文件。
- 所有机构、团队、人物、地点和活动名称均为合成数据，不来自任何真实项目。
- 创建者隐私自检日期：2026-08-09。
- 创建者自检：fixture coding agent。
- 独立隐私复核：已通过。
- 独立复核日期：2026-08-09。
- 独立复核角色：fixture/privacy review agent（非创建者）。
- 复核证据：清单与磁盘文件双向一致；矩阵编号均有效；严格 UTF-8、LF、NUL、`U+FFFD`、敏感模式、绝对路径和禁止类型扫描均通过；与只读 `news` 文本进行归一化连续 16 汉字比对，无匹配；fixture 之间无同长度长句重复。

## 文件清单

| Fixture ID | 文件 | 功能矩阵 | 目的 | synthetic | 允许固定机构名 |
| --- | --- | --- | --- | --- | --- |
| GF-01 | `minutes/gf-01-official-complete.md` | P06、F04、F05、F09、A01 | 完整学院稿纪要和事实提示输入 | yes | 合成机构 |
| GF-02 | `minutes/gf-02-official-external-organizer.md` | P06、F04、F09 | 外部主办、学院参与和主体边界 | yes | 合成机构 |
| GF-03 | `minutes/gf-03-official-missing-location.md` | F05、F06、F07、D02 | 仅缺地点的学院稿纪要 | yes | 合成机构 |
| GF-04 | `minutes/gf-04-other-channel-material-priority.md` | P07、P08、F04、A09 | other 主体、公众号渠道和辅助材料优先级 | yes | 无 |
| GF-06 | `retrieval/no-match-query.txt` | R08 | 合法、非空且在固定 ASCII + Han tokenizer 下预期无命中的合成 ASCII 查询 | yes | 无 |
| GF-07-R01 | `retrieval/documents/r01-digital-source-check-workshop.md` | R01、R04、R05、R07 | 与 GF-01 主题接近的检索源 | yes | 合成机构 |
| GF-07-R02 | `retrieval/documents/r02-weather-observation-open-day.md` | R01、R04、R05、R07 | 与 GF-02 主题接近且外部主办的检索源 | yes | 合成机构 |
| GF-07-R03 | `retrieval/documents/r03-community-energy-observation.md` | R01、R04、R05、R07 | 与 GF-04 场景接近的 other 检索源 | yes | 无 |
| GF-07-R04 | `retrieval/documents/r04-campus-space-safety-check.md` | R01、R04、R05、R07 | 共享地点词但主题不同的检索源 | yes | 合成机构 |
| GF-07-R05 | `retrieval/documents/r05-campus-chorus-open-session.md` | R01、R04、R05、R07 | 无关主题检索源 | yes | 无 |
| GF-13-IN | `text/gf-13-normalization.input.txt` | F01 | HTML 实体、横向空白和连续空行输入 | yes | 无 |
| GF-13-OUT | `text/gf-13-normalization.expected.txt` | F01 | 规范化后的精确期望文本 | yes | 无 |
| GD-SINGLE | `documents/source/single-page.md` | D05、D06、D07、D09、D10 | 未来单页 DOCX 的纯文本来源 | yes | 合成机构 |
| GD-MULTI | `documents/source/multi-page.md` | D05、D06、D07、D09、D10 | 未来跨页 DOCX 的纯文本来源 | yes | 合成机构 |
| GD-LONG-TITLE | `documents/source/long-title.md` | D05、D06、D07、D09、D10 | 未来超长标题 DOCX 的纯文本来源 | yes | 合成机构 |
| GP-LINEAR | `projects/linear/` | P01、P02、P09、P11、P12、F13、D12 | 两个版本的线性项目，含任务、Prompt、检索和导出记录 | yes | 无 |
| GP-BRANCH | `projects/branch/` | P11、P12、F11、F12、F13 | 三个版本的分支项目，含回溯、批注修订和两个子分支 | yes | 无 |
| GP-CORRUPT | `projects/corrupt/` | P02、P03 | 从线性项目复制后仅篡改最新版正文，用于 hash 损坏拒绝测试 | yes | 无 |

## 使用限制

- 阶段 1 纯文本文件不是 Prompt 黄金、项目 Schema、检索索引、AI wire 响应或 DOCX 模板。
- `projects/` 由 `scripts/generate-stage2-project-fixtures.mjs` 通过正式 domain/project API 生成；不得手工改写其 commit、snapshot、record 或 hash。
- 当前没有历史项目 Schema，因此不得新增伪造 V0 或 migration fixture。
- retrieval 模块评审前不得把五篇 Markdown 固化为 JSONL、tokens、分数或排序黄金。
- documents 模块评审和排版批准前不得从三份正文素材生成受认可的 DOCX/PDF/PNG 黄金。
- 测试运行产生的文件必须写入临时目录，不得回写本目录。

## 阶段 3 retrieval 黄金输出

以下黄金文件由 `packages/retrieval/src/generate-synthetic-golden.ts` 从 GF-07 的五篇 Markdown 和审查中的规则卡源确定性生成。五篇 Markdown 仍是唯一 corpus 事实源；黄金文件不是第二份手写索引输入。

| 文件 | 作用 | 审查边界 |
| --- | --- | --- |
| `tests/golden/retrieval/mini-corpus.jsonl` | 严格 corpus Schema、document ID 和 content hash 黄金 | 全合成，不得替换为真实旧稿 |
| `tests/golden/retrieval/mini-index.json` | tokenizer/BM25 postings 与确定性构建黄金 | 只能由生成器更新 |
| `tests/golden/retrieval/mini-metadata.json` | artifact hash、算法版本和构建元数据黄金 | 使用固定合成时间和版本 |
| `tests/golden/retrieval/query-reports.json` | 明确命中、排序、六位分数和合法无命中报告黄金 | excerpt 仅来自五篇合成稿 |

合成规则卡位于 `tests/fixtures/retrieval/training-rules.txt`，不复制任何旧培训材料；公开仓库的 `resources/institution/knowledge` 只由这些合成 fixture 构建。
