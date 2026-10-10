# 第三方来源与许可说明

核对日期：2026-10-10。本文件记录拟同步内容的来源、归属和使用边界，不是对全部内容的法律担保。

Translate-helper 暂未指定项目许可证。下列第三方许可只适用于相应第三方内容，不给整个项目、学习改写、题目或词卡统一授予 Apache-2.0 或其他开源许可；私有仓库也不自动获得第三方授权。

## Docker 文档与学习材料

原文归属：Copyright 2016 Docker, Inc.。官方 `docker/docs` 仓库的 [main/LICENSE](https://github.com/docker/docs/blob/main/LICENSE) 为 Apache License 2.0；随附 [完整原文](third_party/docker-docs-LICENSE.txt)，包括上游版权声明，不替换为项目作者。

| 拟同步文件 | 对应官方来源 | 本项目处理 |
| --- | --- | --- |
| `reading_materials/docker-user-v1-0.md` | [Docker Desktop](https://docs.docker.com/desktop/) | 用户输入快照的手工迁移、学习改写 |
| `reading_materials/docker-user-v1-1.md` | [Docker Desktop](https://docs.docker.com/desktop/) | 同一基础正文的另一档学习提示 |
| `reading_materials/docker-user-v1-2.md` | [Docker Desktop](https://docs.docker.com/desktop/) | 同一基础正文的另一档学习提示 |
| `reading_materials/generated-e72110938586236e9bcf.md` | [Docker Desktop](https://docs.docker.com/desktop/)；[Build and share a containerized application](https://docs.docker.com/get-started/tutorials/run-an-app/) | 模型生成后修订的学习改写 |

上述四文件的正文均标为 `learning_adaptation`：经过删改、解释和教学情境扩充，不是网站原文，也不是 Docker 官方教学材料。前三文件共用基础正文，不代表三篇不同文章。`modules/reading/reading-supplements.json` 中对应 Docker 预置包同样是学习改写；题目、中文说明及自编例句不应归为 Docker 原文。

再分发相关 Docker 内容时应保留适用的原版权及归属声明、Apache-2.0 完整许可，并明显说明修改；若所用上游版本附有适用的 NOTICE 或其他第三方声明，也须随其保留。此许可不覆盖 Docker Desktop 软件、Docker Hub 服务条款或标志、商标的任意使用，也不覆盖词卡中另行引用的词典内容。项目与 Docker 无背书关系。

## USGS 水循环预置内容

`modules/reading/reading-bank.js` 的 `usgs` 段落取自 U.S. Geological Survey（美国地质调查局）Water Science School 的 [Follow a Drip Through the Water Cycle](https://www.usgs.gov/water-science-school/science/follow-a-drip-through-water-cycle)，原页面署名 Water Science School，日期 2018-06-06。归属：Credit: U.S. Geological Survey。

USGS 的 [官方版权问答](https://www.usgs.gov/faqs/are-usgs-reportspublications-copyrighted) 说明其自行制作的信息在美国属于公有领域，可使用并应注明来源；但其网站上的第三方信息、照片或图形不因此获得授权。当前预置包收录文字，不收录网页图片、交互图或 USGS/FAO 图表。

这里不将整站或所有美国政府材料认定为全球公有领域，也不把这些文字擅自标为 CC0；USGS 的 [Data Licensing](https://www.usgs.gov/data-management/data-licensing) 另行说明地域和第三方权利边界。新增材料应核对具体作品和用途，而非仅凭 `.gov` 域名判断。

## NASA 水循环预置内容

`modules/reading/reading-nasa.js` 保存 NASA Earth Observatory 的 [The Water Cycle](https://science.nasa.gov/earth/earth-observatory/the-water-cycle/) 文字摘录；`modules/reading/reading-bank.js` 保存来源信息，供阅读回退使用。原文署名 Steve Graham、Claire Parkinson、Mous Chahine；页面设计署名 Robert Simmon。归属：NASA Earth Observatory。本地来源日期为 2010-10-01，文中任务描述是历史资料，不代表卫星任务的当前状态。

NASA Earth Science 的 [官方 FAQ](https://science.nasa.gov/earth/faq/) 说明其地球科学网站的大多数材料可再发布或再使用，但明确标记版权的内容除外，并要求注明 NASA 来源；[媒体使用指引](https://www.nasa.gov/nasa-brand-center/images-and-media/) 进一步区分第三方内容、标志和背书限制。这不是对所有 NASA 或合作机构作品的无限授权。

本项目预置包只保留文字，没有复制原页面的图片、表格或照片；例如原页面带第三方版权标记的照片不在收录范围。NASA 标志、人物形象、合作机构材料和第三方图片的权利不能由文字归属说明代替。项目与 NASA 无背书关系。

阅读引擎还会加入学习导读、词汇语境、问题及释义改写，这些项目编写内容不是 NASA/USGS 原文。原文摘录与学习改写应继续按材料标记区分；不要将整篇组合阅读标成机构原作。

## 词典参考与尚未核实的权利

`modules/reading/reading-bank.js`、`modules/reading/reading-supplements.json`、上述 Markdown 候选词卡及正式 HTML 中存在 Cambridge Dictionary 等词典参考链接。链接用于追溯，不等于获得词典数据库、释义或读音内容的批量复制、再分发授权。学习改写、自编例句和模型草稿也不应标成词典官方原文。

本次没有取得逐条词卡的第三方再分发授权，也未完成逐句表达相似性审查；Docker、NASA 或 USGS 的许可不能替这些内容授权。扩大分发、公开仓库或商品化前，仍须核对实际引用、相关词典条款及必要许可。音标或答案经人工审核，不代表其版权已获授权。

## 本地保留、不在本次同步范围

- `reading_materials/bert-review-learning-20-v1.md`、`bert-review-learning-45-v1.md`、`archive/reading-themes.js`：用户论文的学习改写/归档；[出版方页面](https://link.springer.com/article/10.1007/s10462-025-11162-5) 的 CC BY-NC-ND 4.0 条款不允许据该许可分享改编材料，不据此上传这些文件。
- `reading_materials/generated-6047780d0eb0110e8380.md`：正念学习改写，其涉及来源的再分发条件尚未核实。
- `input/`、`output/`：用户材料、交付物及历史记录，不随本次仓库同步。

这些文件保留本地，不因排除上传而删除。新增或修改第三方材料时，应重新核对具体来源、版本、修改标记和许可；现有清单不是对未来生成内容的授权。
