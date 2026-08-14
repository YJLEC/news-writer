# Prompt Golden 说明

## 状态

- 合约：`docs/baseline/PROMPT_CONTRACT.md`，已批准（2026-08-09）。
- 内容：四份最终 Prompt 文本（`system` + `user` 两段按「稳定规范在前、素材在后」拼接），不是 DeepSeek wire JSON。
- 数据：全部来自已批准的合成 fixture 或本 README 记录的固定合成内嵌输入。
- 独立 review：已通过（2026-08-09）。

### 独立 review 证据

- 四份文本的外层章节名称和顺序与已批准合约逐项一致；嵌入纪要经 LF 规范化后与对应 fixture 逐字一致，generation 的检索标题和首段与 `r01`、`r03` fixture 逐字一致。
- official 与 other 场景边界正确；历史参考仅出现在 generation，review 直接以纪要事实校核初稿，revision 包含父版本和恰好三个当前版本批注。
- 未包含禁止的任务、版本或批注 ID、时间戳、绝对路径、凭据、模板占位符、未替换标记及无关历史；四份文件均为无 BOM 的 UTF-8、LF，无末尾换行。
- 对只读原项目 `news` 的 6305 个文本文件执行连续 16 个汉字复用检查，四份 Prompt 均无匹配。

## 映射

| Golden | 输入 | 固定动态内容 | 主要断言 |
| --- | --- | --- | --- |
| `gf-01-generation.txt` | `tests/fixtures/minutes/gf-01-official-complete.md` | `r01` 检索源首段、学院网站、800字 | generation 章节完整；纪要是唯一事实源；参考稿只作风格；official 落款正确。 |
| `gf-04-other-generation.txt` | `tests/fixtures/minutes/gf-04-other-channel-material-priority.md` | `r03` 检索源首段、实践队公众号、900字 | other 不套用学院主体；区分活动内容、背景和视频创意。 |
| `gf-03-review.txt` | `tests/fixtures/minutes/gf-03-official-missing-location.md` | 内嵌待审稿含无依据人数和夸大评价 | review 无历史参考章节；纪要即事实源；删除无依据内容；输出干净终稿。 |
| `gf-09-revision-with-comments.txt` | `tests/fixtures/minutes/gf-04-other-channel-material-priority.md` | 内嵌父版本；三个固定批注 | revision 无历史参考章节；仅父版本批注；批注不作为事实；删除错误关系、视频引语和夸大评价。 |

## 固定规则

- 四份文本均使用合约批准的可见章节、资料标签和事实边界。
- generation 的固定检索引用只取相应合成 Markdown 的标题和首段，不含路径、分数或完整历史稿。
- review 和 revision 不包含历史参考稿章节。
- Prompt 中不包含任务 ID、版本 ID、批注 ID、时间戳、模型、推理强度或调用配置。
- 每个文件使用 UTF-8、LF，无末尾换行。
- 更新 golden 必须通过显式操作并人工检查 diff；测试不得自动接受新快照。

## 测试方式

后续 Prompt builder 测试必须同时执行：

1. 完整文本精确比较。
2. 合约规定的章节顺序检查。
3. 事实来源、场景和批注归属的语义正向断言。
4. 路径、凭据、无关历史、占位符和内部说明的负向断言。
5. 实际 transport 收到的 `system` 与 `user` 文本按顺序拼接后与对应 golden 逐字一致。
