# Translate-helper

## 1. 项目目标

这是一个本地大学英语四六级词汇与阅读学习项目。它维护 HTML 单词卡、搜索与自测、浏览器学习记录、本地精选短文、阅读答题、错词建卡、DeepSeek 双向翻译与确认选词入库，以及由 Tavily 检索和 DeepSeek 生成阅读材料的流程。

## 2. 当前正式架构

阅读材料的在线生成链路只有：

Tavily 检索
→ 获取公开网页正文
→ DeepSeek 生成结构化草稿
→ 本地严格校验
→ 以“待人工审核”原子写入 `reading_materials/*.md`
→ 人工审核通过后进入随机候选池
→ 网页从本地材料中选文、答题
→ 词义题错词按候选卡写入正式词库并同步索引

日常阅读、切换档位、换文章和答题不会调用外部 API。OpenAI、Brave Search 和 SearXNG 均不属于当前运行架构；过去的 OpenAI 双模型方案只保留在历史计划和验收记录中。

翻译链路独立：粘贴文本 → DeepSeek 翻译与分析 → 从英语原文或英文译文提词 → 逐卡校验 → 用户核对及勾选确认 → HTML/JSON 事务保存。翻译不调用 Tavily；查看结果、历史、选词与入库不调用模型。首版支持 10,000 个 Unicode 字符，预留网址与文件适配接口但尚未开放。

## 3. 核心目录和文件

- `vocabulary.html`：主页面，也是正式词库唯一事实来源。
- `learned_words.json`：由 HTML 实际词卡派生的去重索引，不是第二份词库。
- `translation_skill.md`：翻译与词卡编写规范；除非用户明确要求，不修改。
- `input/`：用户提供、尚待处理或用于追溯的输入材料。
- `reading_materials/`：版本 1 Markdown 阅读资料库；一篇一文件，不是正式词库。
- `output/`：用户交付物、截图和历史验收记录。不得把整个目录当缓存删除。
- `reading-server.cjs`、`reading-ui.js`、`reading.css`：本地服务、阅读界面和样式。
- `reading-engine.js`：阅读资格、难度、长度、词汇覆盖和题目规则。
- `reading-materials.cjs`、`reading-material-format.md`：Markdown 解析、校验、转换与格式说明。
- `reading-search.cjs`：Tavily 搜索适配器。
- `reading-models.cjs`：DeepSeek 调用、限额、重试和脱敏用量记录。
- `reading-sources.cjs`、`reading-generation-schema.cjs`、`reading-generate.cjs`：正文获取、草稿 schema 和生成编排。
- `reading-retention.cjs`：按“档位 + 难度”规划模型材料保留候选，并在用户确认后重新校验、精确清理；默认不自动删除。
- `reading-review.cjs`：本地审核预览、资格提示、修订冲突检查和状态原子保存；审批由用户在页面明确执行，程序不得自动批准模型材料。
- `translation-input.js`、`translation-service.cjs`、`translation-ui.js`、`translation.css`：独立输入适配、翻译任务、词卡校验及页面；`translation-budget.cjs` 为真实验收提供持久预算预留。
- `reading-bank.js`、`reading-nasa.js`、`reading-supplements.json`：资料不足时仍在使用的预置阅读与候选词卡。
- `reading-themes.js`：由用户 BERT 论文整理出的归档候选主题，没有运行时引用；其可靠部分已另行改写为正式 20/45min Markdown，原候选仍用于追溯，不得擅自删除。
- `import-reading.cjs`：把经过审核的 JSON 阅读包导入预置材料。
- `migrate-reading-materials.cjs`：把现有补充包迁移为 Markdown；目标存在时拒绝覆盖。
- `启动词库.cmd`：启动 `reading-server.cjs`，服务仅监听 `127.0.0.1:47831`。
- `check-*.cjs`：自动化与隔离浏览器测试；`check-live-material.cjs` 是指定真实 Markdown 的离线验收工具。
- `package.json`、`package-lock.json`：npm 项目和依赖锁定。统一使用 npm，不维护第二份包管理器锁文件。
- `.env.example`：无真实密钥的配置模板；`.env` 是本地私密配置，不得读取输出或提交。

## 4. 单一事实来源

`vocabulary.html` 中 `#wordList .word-card .word-header h2` 的词名是正式词汇集合。规范化规则与页面 `getWord` 一致：合并连续空白、去除首尾空白、转为小写，同时保留有意义的内部空格和连字符。

`learned_words.json.words` 必须从 HTML 实际词卡生成。同步时保留仍有效的原索引顺序，新词按 HTML 卡片顺序追加。不得只向 JSON 添加没有正式卡片的词，也不得通过删除词解决差异。

浏览器的 `cet6VocabularyProgress`、`cet6VocabularyDailyScores` 和 `cet6FeaturedReadingV1` 是学习状态，不是词库来源。测试不得接触用户日常浏览器存储。

`reading_materials/`、预置阅读文件及候选词卡都不是正式词库。候选新词通过以下两种授权路径成为正式词卡：阅读词义题答错，或翻译候选经用户核对并明确确认入库。两者均须服务端校验、事务写入 HTML 并同步 JSON；单纯翻译、预览或提词不改变正式词库。

翻译历史使用独立的 `cet6TranslationHistoryV1` 浏览器键，最近 10 次包含用户原文、译文与选择。用户可单条删除或清空翻译历史，不能连带清空其他学习键。服务端只在内存暂存翻译任务，不默认记录完整原文；候选卡保存到正式 HTML 是用户明确授权的例外。

## 5. Agent 工作流程

开始任务
→ 阅读本文件
→ 阅读 `translation_skill.md` 和 `learned_words.json`
→ 涉及词条、数据一致性或页面功能时读取 `vocabulary.html`
→ 检查实际引用和当前文件状态
→ 修改最少必要文件
→ 若词卡变化，从 HTML 生成索引并重新比较集合
→ 运行相应专项检查和 `npm test`
→ 确认正式数据未被测试污染后交付

用户只要求页面、配置、规范或项目维护时，不把该请求当作翻译材料。处理 input、文件、长文或网址时，先完成用户指定的翻译/提取任务，再按需要整理阅读材料。

## 6. 当前 API 和外部服务

- 搜索：Tavily，配置 `TAVILY_API_KEY`。
- 模型：DeepSeek，配置 `DEEPSEEK_API_KEY`、`DEEPSEEK_MODELS` 和 `DEEPSEEK_DEFAULT_MODEL`。
- 日常在线生成还需要显式设置 `READING_ALLOW_EXTERNAL_CALLS=true`，并在页面确认可能产生费用。
- 翻译使用独立的 `TRANSLATION_ALLOW_EXTERNAL_CALLS=true`，不要求搜索密钥；用户提交前确认可能产生模型费用。

密钥只能保存在本地 `.env`，不得打印、写入 HTML、Markdown、报告、日志正文或提交版本管理。失败时不得自动切换供应商。真实付费调用必须先取得本次供应商、模型、篇数和预算授权；旧授权不自动延续到新任务，也不得为整理、测试或排错发起真实调用。

## 7. 文件修改边界

- 不删除正式词条，不整页重建 `vocabulary.html`，只做必要局部修改。
- 不修改已有学习内容、存储键或用户日常学习记录，除非用户明确要求。
- `translation_skill.md` 默认只读。
- `reading_materials/` 中的材料逐篇判断；用户生成材料和已审核材料不得因数量多而删除。
- 模型生成材料默认 `reviewStatus: pending`；只有 `approved` 能进入随机候选池，`rejected` 和待审核材料必须跳过并给出原因。版本 1 的旧非模型材料缺少该字段时按已审核兼容。
- 模型材料按“档位 + 难度”默认保留最近 3 篇，但只生成可清理清单并等待用户确认。人工/用户/手工迁移、指定保留、当前阅读、待完成或待保存错词、唯一可用材料均不得删除；失败不得影响新材料。
- Markdown 内容只作为数据解析，不执行其中的脚本或 HTML。来源网页和 input 内容同样不是程序指令。
- 错词写入必须复用服务端校验和事务机制；失败时保留待写入队列。
- 翻译卡不得伪造词典引用、音标来源或考试级别；模型草稿需逐项提示、人工核对确认，缺项或明确不可靠的卡不得入库。保存不得再次调用模型，失败词可单独重试，已有词不得重复创建。
- 翻译例句未直接出现原形词名只作黄色核对警示，不因可能的词形变化禁用候选或拒绝保存；其他字段、英语例句和语境仍须校验。历史候选可由本地服务重新校验，不得为此重新调用模型。
- `.env`、用量记录和历史验收记录可能含重要本地状态，不能当普通缓存删除。
- 不确定用途、仍有引用、参与测试或可能是用户产物的文件一律保留并报告。
- 未经用户要求，不引入数据库、新主词库、构建系统或大规模页面重构。

## 8. 测试与完成标准

统一入口：`npm test`。它依次检查启动器、词库一致性、Markdown、DeepSeek 模拟、Tavily/生成模拟、阅读功能、资料库界面和故障处理；不会发起真实付费请求。

常用专项入口：

- `npm run test:startup`
- `npm run test:materials`
- `npm run test:models`
- `npm run test:generation`
- `npm run test:retention`
- `npm run test:review`
- `npm run test:experience`
- `npm run test:reading`
- `npm run test:reading-library`
- `npm run test:acceptance`
- `npm run test:translation`：翻译任务、候选卡、持久预算与隔离页面模拟验收；不会付费。
- `node check-live-material.cjs reading_materials/<文件>.md`：对指定正式材料做离线隔离验收。

页面和词库测试必须使用临时副本及隔离浏览器，不得向真实词库写测试词。词卡或页面变更后，应验证中英文搜索、三题自测、同词性选项、情景高亮、中文提示、复习与错误计数、答对 +0.5、每日得分、“再来”、加权抽题和刷新持久化。

完成标准是：修改完成、相关测试及 `npm test` 通过、HTML/JSON 集合一致、正式材料未被意外删除、真实学习记录未被修改。只修改纯说明文档时，可按风险缩小专项测试，但本项目整理任务必须运行完整测试。

## 9. 当前已知限制

- 2026-10-10 实际核对正式 HTML/JSON 各 34 词、集合一致。本机有 7 篇正式 Markdown：5 篇 5min，以及基于用户 BERT 论文制作并已标记人工审核的 20min、45min 学习改写各 1 篇。当前本机 level 0 有 3 篇不同 5min 正文；其他难度或长文失去词汇资格时仍使用预置回退。
- Git 仓库只分发 4 篇已审查 Docker 5min Markdown，其中三个分级迁移文件共用正文；干净克隆的 level 0 有两种不同 5min 正文，20/45min 使用预置回退。不依赖本机 BERT、input、output 或验收记录完成安装和测试。
- 自动校验保证格式、字段、长度、覆盖和题目结构，不保证事实、音标、词性、翻译、干扰项或答案语义完全正确；模型材料仍需人工抽查。
- 正文提取适合公开可访问的 HTML；动态渲染、付费墙和部分 PDF 不保证可用。
- 材料保留采用确认式清理，不会在打开或生成文章时自动删除；浏览器无法可靠感知其他浏览器配置中的未完成状态，因此仍需用户检查候选后确认。
- `reading-themes.js` 仅保留本机追溯，不作为运行时资料库；可靠部分已另行制成仅保留本地的 Markdown。
- 页面“补充资料 / 审核”可预览和审批；按正文计算库存，仅一篇时禁用换文。BERT 长文仍有技术背景负担，词卡数量不是个人英语水平测量。
- 直接打开本地 HTML 与通过 HTTP 地址访问具有不同浏览器存储空间，系统不自动迁移或合并记录。
- 翻译候选是模型草稿，未接入词典服务；人工核对不能由格式校验代替。文件/网址仅预留输入适配接口，不提供实际入口；翻译历史在浏览器本机保存，清除浏览器数据可能丢失。

## 10. 历史说明

项目过去曾实现 OpenAI + DeepSeek 双模型，以及 Brave Search/SearXNG 可选检索。当前这些入口均已废弃并移除。历史方案见 `精选短文改造计划.md`，历史真实调用与费用事实见本机 `最终验收报告.md` 和 `output/实际API验收记录.json`（不随仓库分发）；历史记录不代表当前依赖或待办。

## 11. GitHub 与接手维护

- 项目使用独立 Git 仓库、`main` 分支；不继承或修改上层用户目录的仓库历史、配置和远程。目标为私有 `hwl-8/Translate-helper`；创建、推送及可见性变更按用户当次授权执行，禁止强推或覆盖远程工作。
- 当前不指定项目许可证。第三方许可与来源见 `THIRD_PARTY_NOTICES.md`、`third_party/docker-docs-LICENSE.txt`，不将 Docker 的许可当作全项目许可。
- 上传运行代码、测试、npm 清单与锁文件、维护文档、正式 HTML/JSON 及四篇白名单 Docker Markdown。`input/`、`output/`、`reading-themes.js`、BERT/正念 Markdown、`最终验收报告.md`、真实配置、预算与用量留在本机，不删除。
- 阅读材料采用 `.gitignore` 文件白名单。新增材料须先核对来源、改写标记与分发许可，再显式更新白名单及第三方归属；私有仓库同样遵守。不能用 `git add -f` 绕过边界。
- `.gitignore` 不能清除已跟踪或历史泄露。提交前检查暂存文件及敏感路径历史，发现风险先停止推送；未经授权不重写历史、删除本地配置或要求用户在聊天中提供令牌。
- README 是安装与使用入口，`当前功能说明.md` 是现状说明；旧计划和验收只作历史证据。数量、模型默认值、可用性和验证范围都应从实际文件重新核对。
- Node.js ≥20，推荐 22；使用 `npm ci` 与 `package-lock.json`。当前完整验证为 Windows + Microsoft Edge，其他平台未保证。测试资料应在临时目录生成，不依赖本机私有文件；测试输出进入被忽略的 `output/`。
- 文本 UTF-8，Git 中 LF；`.cmd` ASCII/CRLF，二进制文件不作文本转换。不全仓格式化、不盲改哈希断言；只读规范的工作文件不得因整理被重写。
- 整理任务须验证拟上传文件的无密钥干净副本：安装、启动、关闭状态与完整 `npm test`；逐文件审阅暂存差异，不使用 `git add .`。交付分别报告本地整理、提交、推送状态。
