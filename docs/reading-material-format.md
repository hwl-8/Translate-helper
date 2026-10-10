# reading_materials Markdown 格式规范

> 路径约定：本文命令均在项目根目录执行；主页面、词库和 `.env` 仍在根目录，现行说明位于 `docs/`。目录调整不改变业务规则、第三方许可或材料上传白名单。


## 1. 适用范围

`reading_materials/` 保存本地精选短文资料，一篇文章对应一个 `.md` 文件。本规范当前版本为 **1**。

资料库已接入精选短文界面。每次进入档位或换文章，优先扫描本目录并按当前正式 HTML 词库重新校验；没有合格材料时才使用 `modules/reading/reading-bank.js`、`modules/reading/reading-nasa.js` 和 `modules/reading/reading-supplements.json` 预置回退。新增合格文件无需修改页面，也无需重启服务。

## 2. 安全边界

- 文件只按 UTF-8 文本、固定 Markdown 标题和 JSON 数据块解析。
- 解析器仅使用字符串匹配与 `JSON.parse`，不使用 `eval`、`Function`、动态 `require`、动态 `import` 或 `innerHTML`。
- 文件中的内容始终是数据，不作为 JavaScript、HTML、模板或命令执行。
- 文件不允许包含 HTML 标签、`javascript:` URI、控制字符、原型污染字段或未知结构字段。
- 单文件最大 2 MiB；目录扫描只读取扩展名为 `.md` 的普通文件，不跟随符号链接。
- 损坏或不合格文件不会阻止其他合格材料加载；扫描结果通过 `skipped` 返回文件名和可理解的原因。

## 3. 固定文档结构

标题、章节名称、顺序和 JSON 围栏必须完全一致：

````markdown
# Featured Reading Material

## Metadata

```json
{ ... }
```

## Article

```json
[
  { ... }
]
```

## Questions

```json
[
  { ... }
]
```

## Candidate Cards

```json
[
  { ... }
]
```
````

章节外不允许添加其他文本。说明文字应放进对应 JSON 字段。

## 4. Metadata

Metadata 必须且只能包含以下字段：

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| `formatVersion` | number | 当前必须为 `1` |
| `id` | string | 稳定文章 ID；小写字母、数字和连字符，最长 100 字符；正文论点、题意或正确答案实质修订时使用新 ID；辅助提示及不改变答案含义的小修保留原 ID |
| `title` | string | 文章标题 |
| `materialType` | string | `website`、`input` 或 `user` |
| `creationMethod` | string | `original_excerpt`、`learning_adaptation`、`user_input`、`model_generated` 或 `manual_migration` |
| `reviewStatus` | string，可选 | `pending`（待人工审核）、`approved`（已人工审核）或 `rejected`（审核不通过）；模型生成材料必须显式填写 |
| `retentionPolicy` | string，可选 | `standard` 或 `preserve`；仅影响模型生成材料的保留候选，历史验收指定材料使用 `preserve` |
| `generatedDate` | string | 有效的 `YYYY-MM-DD` 日期 |
| `minutes` | number | `5`、`20` 或 `45` |
| `level` | number | `0`、`1` 或 `2` |
| `supportHint` | string | 阅读提示；可为空字符串 |
| `sources` | array | 1–20 个来源对象 |

每个来源必须且只能包含：

```json
{
  "id": "source-1",
  "title": "可核对的来源标题",
  "url": "https://example.org/article",
  "date": "YYYY-MM-DD 或来源自身可理解的日期说明",
  "sourceType": "website"
}
```

`sourceType` 只能是：

- `website`：公开网站来源；
- `input_file`：项目 `input/` 或用户提供文件；
- `user_input`：用户在对话或附件中提供的文本/页面。

所有来源都必须提供无账号信息的 HTTPS 链接。迁移材料若来自用户提供的网页，应同时标记 `materialType: "user"` 和 `sourceType: "user_input"`，不能冒充本次实时检索的网站材料。

为保持格式版本 1 兼容，旧非模型材料缺少 `reviewStatus` 时按 `approved` 处理；旧模型材料缺少该字段时按 `pending` 处理。缺少 `retentionPolicy` 时按 `standard` 处理。新增模型材料不得依赖默认值，必须明确写出两个字段。

## 5. Article

正文是段落对象数组。每段必须且只能包含：

```json
{
  "text": "完整英文段落",
  "sourceId": "source-1",
  "contentType": "learning_adaptation"
}
```

`sourceId` 必须引用 Metadata 中存在的来源。`contentType` 必须逐段明确标记：

- `original_excerpt`：经许可或适当范围使用的原文摘录；
- `learning_adaptation`：基于来源制作的学习用改写；
- `user_input`：用户输入原文。

自编导读、综合转述或模型生成的改写必须标记为 `learning_adaptation`，不得标记为 `original_excerpt`。标记只说明材料出处和处理方式，不自动授予转载权。

## 6. Questions

必须有 1–5 道题，且至少一道 `vocabulary` 词义题。每题只有一个正确答案，选项数量为 3–4 个。

词义题：

```json
{
  "kind": "vocabulary",
  "word": "repository",
  "prompt": "What does ... mean in the passage?",
  "options": [
    {"text": "correct explanation", "chinese": "正确中文提示", "correct": true},
    {"text": "distractor", "chinese": "干扰项中文提示", "correct": false},
    {"text": "distractor", "chinese": "干扰项中文提示", "correct": false}
  ],
  "explanation": "基于正文证据的答案解析"
}
```

理解题不含 `word`；选项可以省略 `chinese`。所有问题都必须有非空 `explanation`。

## 7. Candidate Cards

候选词卡数组至少包含 2 项。每项必须且只能包含以下字段：

```json
{
  "word": "repository",
  "uk": "rɪˈpɒz.ɪ.tər.i",
  "us": "rɪˈpɑː.zə.tɔːr.i",
  "pos": "名词",
  "chinese": "存储库；保存代码或资料的地方",
  "english": "a place where code or other material is stored",
  "example": "The students store their code in a shared repository.",
  "translation": "学生们把代码存放在共享仓库中。",
  "source": "https://dictionary.cambridge.org/dictionary/english/repository"
}
```

本文的阅读候选词卡不是正式词库；词义题答错并经本地服务成功写入 `vocabulary.html` 后，才成为正式词卡。项目另有独立的翻译候选核对确认入库路径，不使用本文阅读格式和资格规则。`learned_words.json` 始终只从正式 HTML 派生。

同篇文章的新词逐渐收录后，文章可能不再满足“两新词”，因此不进入下一次随机池；当前题目的其余候选词仍可通过服务端完整结构校验及事务保存入库。前端不得上传任意词卡内容来绕过本地来源校验。

## 8. 资格校验

格式校验通过后，解析器会把材料转换成现有阅读包结构，并复用 `modules/reading/reading-engine.js#validatePack` 检查：

- 当前正式词库中至少 4 个不同已收录词出现在正文；
- 至少 2 个不同未收录候选词出现在正文；
- 词汇按完整词边界匹配，不使用子串冒充；
- 字数与 5/20/45 分钟档位的误差不超过现有 20% 限制；
- 题目数量、唯一正确答案、至少一道词义题及正文语境合格；
- 候选词卡字段完整、词名规范、例句包含目标词并有 HTTPS 参考来源。

目录扫描默认只把 `reviewStatus: "approved"` 的材料加入随机候选池。`pending` 与 `rejected` 文件仍按数据解析并保留在磁盘，但会出现在 `skipped` 中，页面显示“待人工审核”或“审核不通过”的原因。审核状态不代表程序能够证明事实或答案正确。

资料库扫描接口（以下示例从项目根目录调用）：

```js
const {scanMaterialDirectory} = require('./modules/reading/reading-materials.cjs');
const result = scanMaterialDirectory('./reading_materials', vocabularyCards);
// result.materials：合格材料
// result.skipped：[{file, reason}]，损坏或不合格文件及原因
```

## 9. 当前示例

当前三个迁移示例由 `modules/reading/reading-supplements.json` 中已通过既有检查的 Docker 阅读包迁移而来：

- `docker-user-v1-0.md`
- `docker-user-v1-1.md`
- `docker-user-v1-2.md`

它们分别对应难度 0、1、2，均为 5 分钟档。来源明确标记为 `user_input`，正文明确标记为 `learning_adaptation`；没有将学习改写冒充 Docker 官方原文摘录。资料库另有一篇 Tavily + DeepSeek 生成并人工复核的 5 分钟材料。

重新迁移命令是 `node tools/migrate-reading-materials.cjs`。该命令拒绝覆盖已存在的目标文件，避免误删人工修订。

仓库只分发上述三篇及 Docker 网站改写 `generated-e72110938586236e9bcf.md`；本机其他 BERT/正念材料仍保留但不上传。`.gitignore` 对资料目录采用已审查文件白名单。新增 Markdown 可直接被本地服务发现，但是否可上传须另行核对来源与分发许可，审核状态 `approved` 本身不等于取得版权授权。来源与第三方许可见 `THIRD_PARTY_NOTICES.md`。

## 10. 生成、保存与人工审核

页面提供“补充资料 / 审核 → 资料审核与库存”：预览正文、来源、答案解析与词卡，勾选人工核对后明确提交状态。预览不改变分数或词库。服务按稳定 ID 定位普通文件，核对预览时的文件 SHA-256 修订值，只原子修改审核元数据；文件变化需刷新重审。批准前重新检查当前正式 HTML 词库资格，不自动批准模型内容。其他难度和覆盖失效原因在库存中显示。

选文按规范化完整正文去重，忽略标题、ID、空白及段落边界差异；相同正文不增加换文库存。生成时的重复检查也覆盖已失去当前词库资格的旧文件。

阅读答案新增正文摘要与题干标识，并兼容旧文章 ID 答案；换标题或 ID 不会把同正文同题变成新计分机会。仅修正辅助提示、非实质措辞或不改变答案含义的干扰项时可保留原 ID；正文论点、题意或正确答案实质改变时，应使用新 ID 并重新审核，不能把旧作答移用到新题。

模型先输出结构化草稿，程序生成 metadata 和固定 Markdown。模型改写必须使用 `learning_adaptation`；生成 ID 为正文规范化内容的 SHA-256 前 20 位并加 `generated-` 前缀。新文件以 `reviewStatus: "pending"` 和 `retentionPolicy: "standard"` 保存，人工核对来源、事实、题目、正确答案、干扰项、词性、音标、释义和例句后，才能改为 `approved`。审核不通过时标记 `rejected`，不要通过放宽校验让它进入候选池。人工修改正文或题目后应更换 ID，避免旧答题记录误用于新题。

完整文件先写同目录临时文件并同步，再改名。磁盘错误会清理该次不完整文件并停止生成，不因保存失败自动再次付费调用。格式、覆盖、题量通过不等于事实、词性、翻译和答案完全正确；人工审核需逐项核对来源正文、正确项、干扰项、答案解析和词卡义项。来源链接格式合法不等于网页已验证。

模型生成材料的保留上限按“档位 + 难度”分别计算，默认最近 3 篇。当前实现采用确认模式：新材料完整校验并成功落盘后，程序才列出超过上限且可安全清理的旧模型文件；用户确认时服务再次解析文件并核对精确 ID 和路径。人工导入、用户输入、手工迁移、`retentionPolicy: "preserve"`、当前阅读、存在未完成或待保存错词、以及删除后会让该档位无合格材料的文件都不进入清理候选。单个删除失败只返回原因，不回滚或损坏已保存的新材料。
