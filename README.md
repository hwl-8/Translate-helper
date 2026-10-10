# Translate-helper

本地英语词汇与精读学习工具。正式词库保存在 `vocabulary.html`，无需构建；本机 Node.js 服务负责资料库、审核、模型调用和词卡事务保存。项目暂未指定开源许可证，第三方材料的许可不代表本项目整体许可。

## 实际功能与架构

- 词卡搜索、加权三题自测、复习与错误次数、每日得分；学习记录保存在当前浏览器。
- 精选短文支持 5/20/45min，本地合格 Markdown 优先、正文避重、预置材料回退。理解题记分；词义题答对复习 +0.5、答错错误 +1，新错词经服务端校验建卡。
- 补充资料：Tavily 检索 → 公开正文 → DeepSeek 结构化草稿 → 本地校验 → Markdown 待审核 → 用户在页面审核 → 可读。普通阅读和换文不调用外部 API。
- 双向翻译：粘贴文本（最多 10,000 个 Unicode 字符）→ DeepSeek 分段翻译与分析 → 最多 8 个英语候选词 → 用户核对并确认入库。翻译不调用 Tavily；预览、历史和保存不调用模型。文件/网址只预留接口，尚未开放。

HTML 是唯一正式词库；`learned_words.json` 是派生索引。阅读候选词不是正式词条，翻译成功也不会自动入库。OpenAI、Brave Search、SearXNG 不在当前运行链路中。

## 安装与启动

需要 Node.js **≥20**（推荐 22 LTS）和 npm。当前完整验证平台为 Windows，浏览器回归需要已安装 **Microsoft Edge**。其他平台可尝试手动启动服务，但启动器、默认浏览器打开与完整测试未作跨平台保证。

在项目目录运行：

```sh
npm ci
npm start
```

Windows 也可双击 `启动词库.cmd`，保持服务窗口开启。启动器优先检查已有本地运行时，再使用 PATH 中的 Node.js；新电脑不需要原作者的工具目录，安装 Node.js 并加入 PATH 即可。

默认打开原 `vocabulary.html`，服务只监听 `127.0.0.1:47831`。也可运行 `node reading-server.cjs --no-open` 后手动打开 HTML 或访问 `http://127.0.0.1:47831/`。**file 与 HTTP 页面使用不同学习存储空间**，请选择固定入口；不会自动迁移或清空记录。更新服务代码后关闭旧窗口再重启。

无 `.env`、无密钥也能启动和阅读本地材料，不需要 `input/`、`output/` 或历史验收文件。测试会自行创建临时数据与输出目录。

## 可选在线配置

仅在需要翻译或补充材料时，将 `.env.example` 复制为本机 `.env`，不要覆盖已有配置，不要把密钥发到聊天或提交 Git。

| 用途 | 必需配置 |
| --- | --- |
| 仅本地阅读/搜索/答题 | 无 |
| 翻译 | `DEEPSEEK_API_KEY`、`TRANSLATION_ALLOW_EXTERNAL_CALLS=true` |
| 在线补充阅读 | `DEEPSEEK_API_KEY`、`TAVILY_API_KEY`、`READING_ALLOW_EXTERNAL_CALLS=true` |

代码及示例的默认模型是 `deepseek-flash`，允许列表为 `deepseek-flash,deepseek-v4-pro`；本机配置可覆盖，实际可用性取决于供应商及账户。配置改动后重启。页面提交前还要确认费用；不自动切换模型或供应商。超时、token、查询数和重试上限不是货币硬限额。翻译关闭自动模型重试，用户仅重试失败阶段。

全部配置项见 [.env.example](.env.example)，调用和生成细节见 [模型调用说明](模型调用说明.md)、[阅读生成流程](阅读生成流程说明.md)。不要为了首次安装运行真实付费验收脚本；历史预算不构成新的授权。

## 使用流程

搜索词卡或完成启动自测；右上角“精选短文”原位展开三个时长按钮。进入后可阅读、答题和换文，库存不足会说明回退；相同正文不算新文章。补充资料保存后先“资料审核与库存”查看正文、出处、题目及词卡，核对并明确批准，才进入随机池。清理只列候选，由用户确认，不会读新文就删旧文。

搜索框旁“双语翻译”选择方向、粘贴文本、确认费用并提交。逐段查看对照和可展开分析，候选采用摘要勾选与完整卡预览。英译中从原文提词，中译英从英文译文提词。完整卡需人工核对；缺项或明确不可靠的卡禁止入库，例句仅用变形的情况是黄色警示。确认词名清单后逐项保存，新词立即可搜索，刷新后仍在；不会增加学习次数或得分。

翻译历史在本机保存最近 10 次原文和结果，可单条删除或清空，不影响学习记录。共用电脑请注意隐私。详见 [当前功能说明](当前功能说明.md)、[精选短文说明](精选短文说明.md)、[启动与故障处理](启动与故障处理.md)。

## 库存、数据与上传边界

2026-10-10 核对：正式 HTML/JSON **各 34 词且集合一致**。本次维护不新增、删除词条。

本机保留 7 篇 Markdown（5min 五篇、20min/45min 各一篇）；仓库只包含已审查的 **4 篇 Docker 5min**。其中三个难度迁移文件共用正文，另一个是网站学习改写，因此当前 level 0 的仓库库存只有两种不同正文。干净克隆的 20/45min 使用预置水循环回退；本机的 BERT 长文与正念材料不随仓库分发。库存会随已学词、审核状态、难度和新词覆盖变化，文件数不等于可读主题数。

`input/`、`output/`、`reading-themes.js`、`最终验收报告.md`、真实配置、用量和预算账本均保留本地。阅读目录采用 `.gitignore` **四文件白名单**：新增材料必须先审核内容与分发许可，再显式更新白名单、测试与归属说明，不能直接强制添加整个目录。

Docker 学习改写保留来源与 Apache 2.0 归属；政府科普预置内容保留 USGS/NASA 署名及原文/改写标记。BERT 改写因原论文许可中的禁止分享改编限制不上传，正念材料因分发条件尚未确认不上传。细节见 [第三方来源与许可](THIRD_PARTY_NOTICES.md)。私有仓库也不是忽略第三方许可的理由。

## 测试与维护

```sh
npm test
```

完整检查包括词库一致性、启动、Markdown、DeepSeek/Tavily 模拟、审核与清理、阅读/翻译界面、计分、建卡事务和故障恢复。测试使用临时词库和隔离 Edge，不清空或写入日常学习记录，不调用真实付费 API。20/45min 资料库测试从已署名的水循环预置内容生成临时 Markdown，不依赖本机 BERT 文件。

专项命令见 `package.json`，如 `npm run test:translation`、`npm run test:reading-library`。单篇离线验收：`node check-live-material.cjs reading_materials/<文件名>.md`。截图和报告写入被忽略的 `output/`，不进入提交。`check-translation-live.cjs` 是独立付费工具，不在 `npm test` 内；`preview-translation-result.cjs` 仅供本机回放历史验收，需要不随仓库分发的报告，不是日常入口。

| 分类 | 维护入口 |
| --- | --- |
| 正式数据/主页面 | `vocabulary.html`、`learned_words.json` |
| 本地服务与阅读 | `reading-server.cjs`、`reading-ui.js`、`reading.css`、`reading-engine.js` |
| Markdown/审核/保留 | `reading-materials.cjs`、`reading-review.cjs`、`reading-retention.cjs`、`reading_materials/` |
| 检索/生成/模型 | `reading-search.cjs`、`reading-sources.cjs`、`reading-generate.cjs`、`reading-models.cjs` |
| 翻译 | `translation-input.js`、`translation-service.cjs`、`translation-ui.js`、`translation-budget.cjs` |
| 测试/依赖 | `check-*.cjs`、`test-reading-fixtures.cjs`、`package.json`、`package-lock.json` |
| 规范 | `AGENTS.md`、只读 `translation_skill.md`、`reading-material-format.md` |
| 历史设计（非当前配置） | `精选短文改造计划.md` |
| 本地私有产物 | `input/`、`output/`、`.env`、用量/预算文件 |

统一 npm 与 `package-lock.json`，不维护第二套锁文件。文本采用 UTF-8、Git 中 LF；Windows `.cmd` 保持 ASCII 与 CRLF；图片/PDF 按二进制处理。不要全仓格式化、整页重建 HTML、改测试基线掩盖差异，或以删词消除索引不一致。Agent 接手先完整阅读 [AGENTS.md](AGENTS.md) 与 [translation_skill.md](translation_skill.md)。

## 限制

格式检查不能保证翻译、事实、音标、释义或题目答案准确，模型内容始终需要人工审核。词卡数仅是辅助难度启发式，不是个人英语水平测量；主题库存仍有限。动态网页、付费墙和 PDF 正文提取不保证可用。浏览器存储被禁用或清除时，学习/翻译历史可能无法恢复；系统不提供跨浏览器同步。第三方 API 的模型、价格与账户限制可能变化，以官方服务为准。
