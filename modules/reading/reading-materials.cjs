'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {validatePack} = require('./reading-engine.js');

const FORMAT_VERSION = 1;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const DOCUMENT_PATTERN = /^# Featured Reading Material\n\n## Metadata\n\n```json\n([\s\S]*?)\n```\n\n## Article\n\n```json\n([\s\S]*?)\n```\n\n## Questions\n\n```json\n([\s\S]*?)\n```\n\n## Candidate Cards\n\n```json\n([\s\S]*?)\n```\n?$/;
const HTML_PATTERN = /<\s*\/?\s*[a-z][^>]*>/i;
const DANGEROUS_URI_PATTERN = /javascript\s*:/i;

class MaterialValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'MaterialValidationError';
    }
}

function fail(message) {
    throw new MaterialValidationError(message);
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, allowed, label, {optional = []} = {}) {
    if (!isObject(value)) fail(`${label} 必须是对象`);
    const keys = Object.keys(value);
    const unknown = keys.filter(key => !allowed.includes(key));
    const missing = allowed.filter(key => !optional.includes(key) && !keys.includes(key));
    if (unknown.length) fail(`${label} 含未知字段：${unknown.join(', ')}`);
    if (missing.length) fail(`${label} 缺少字段：${missing.join(', ')}`);
}

function safeText(value, label, {allowEmpty = false, max = 20000} = {}) {
    if (typeof value !== 'string') fail(`${label} 必须是字符串`);
    if (!allowEmpty && !value.trim()) fail(`${label} 不能为空`);
    if (value.length > max) fail(`${label} 超过长度限制`);
    if (/\0|[\u0001-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) fail(`${label} 含控制字符`);
    if (HTML_PATTERN.test(value) || DANGEROUS_URI_PATTERN.test(value)) fail(`${label} 不允许包含 HTML 或脚本 URI`);
    return value;
}

function oneOf(value, choices, label) {
    if (!choices.includes(value)) fail(`${label} 必须是：${choices.join('、')}`);
}

function positiveChoice(value, choices, label) {
    if (!Number.isInteger(value) || !choices.includes(value)) fail(`${label} 必须是：${choices.join('、')}`);
}

function httpsUrl(value, label) {
    safeText(value, label, {max: 2048});
    let parsed;
    try { parsed = new URL(value); } catch (_) { fail(`${label} 不是有效网址`); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) fail(`${label} 必须是无账号信息的 HTTPS 网址`);
}

function rejectUnsafeKeys(value, label = 'JSON') {
    if (!value || typeof value !== 'object') return;
    for (const key of Object.keys(value)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) fail(`${label} 含不安全字段：${key}`);
        rejectUnsafeKeys(value[key], label);
    }
}

function parseJson(text, label) {
    let value;
    try { value = JSON.parse(text); }
    catch (error) { fail(`${label} 不是有效 JSON：${error.message}`); }
    rejectUnsafeKeys(value, label);
    return value;
}

function validateMetadata(metadata) {
    exactKeys(metadata, ['formatVersion', 'id', 'title', 'materialType', 'creationMethod', 'generatedDate', 'minutes', 'level', 'supportHint', 'sources', 'reviewStatus', 'retentionPolicy'], 'Metadata', {optional: ['reviewStatus', 'retentionPolicy']});
    if (metadata.formatVersion !== FORMAT_VERSION) fail(`不支持格式版本 ${metadata.formatVersion}，当前仅支持 ${FORMAT_VERSION}`);
    safeText(metadata.id, '文章 ID', {max: 100});
    if (!/^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/.test(metadata.id)) fail('文章 ID 只能使用小写字母、数字和连字符');
    safeText(metadata.title, '标题', {max: 300});
    oneOf(metadata.materialType, ['website', 'input', 'user'], '材料类型');
    oneOf(metadata.creationMethod, ['original_excerpt', 'learning_adaptation', 'user_input', 'model_generated', 'manual_migration'], '制作方式');
    if (metadata.reviewStatus !== undefined) oneOf(metadata.reviewStatus, ['pending', 'approved', 'rejected'], '审核状态');
    if (metadata.retentionPolicy !== undefined) oneOf(metadata.retentionPolicy, ['standard', 'preserve'], '保留策略');
    if (typeof metadata.generatedDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(metadata.generatedDate) || Number.isNaN(Date.parse(metadata.generatedDate + 'T00:00:00Z'))) fail('生成日期必须是有效的 YYYY-MM-DD');
    positiveChoice(metadata.minutes, [5, 20, 45], '阅读档位');
    positiveChoice(metadata.level, [0, 1, 2], '难度');
    safeText(metadata.supportHint, '阅读提示', {allowEmpty: true, max: 3000});
    if (!Array.isArray(metadata.sources) || !metadata.sources.length || metadata.sources.length > 20) fail('来源链接必须是 1–20 项数组');
    const ids = new Set();
    metadata.sources.forEach((source, index) => {
        const label = `来源 ${index + 1}`;
        exactKeys(source, ['id', 'title', 'url', 'date', 'sourceType'], label);
        safeText(source.id, `${label} ID`, {max: 100});
        if (!/^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/.test(source.id)) fail(`${label} ID 格式不合格`);
        if (ids.has(source.id)) fail(`来源 ID 重复：${source.id}`);
        ids.add(source.id);
        safeText(source.title, `${label}标题`, {max: 500});
        httpsUrl(source.url, `${label}链接`);
        safeText(source.date, `${label}日期`, {max: 100});
        oneOf(source.sourceType, ['website', 'input_file', 'user_input'], `${label}类型`);
    });
}

function reviewStatus(metadata) {
    if (metadata.reviewStatus) return metadata.reviewStatus;
    return metadata.creationMethod === 'model_generated' ? 'pending' : 'approved';
}

function validateArticle(article, metadata) {
    if (!Array.isArray(article) || !article.length || article.length > 500) fail('Article 必须是 1–500 个段落的数组');
    const sourceIds = new Set(metadata.sources.map(source => source.id));
    article.forEach((paragraph, index) => {
        const label = `正文第 ${index + 1} 段`;
        exactKeys(paragraph, ['text', 'sourceId', 'contentType'], label);
        safeText(paragraph.text, label, {max: 30000});
        safeText(paragraph.sourceId, `${label}来源 ID`, {max: 100});
        if (!sourceIds.has(paragraph.sourceId)) fail(`${label}引用了不存在的来源：${paragraph.sourceId}`);
        oneOf(paragraph.contentType, ['original_excerpt', 'learning_adaptation', 'user_input'], `${label}内容标记`);
    });
}

function validateOptions(options, label) {
    if (!Array.isArray(options) || options.length < 3 || options.length > 4) fail(`${label}选项必须有 3–4 项`);
    options.forEach((option, index) => {
        const optionLabel = `${label}选项 ${index + 1}`;
        const allowed = option.chinese === undefined ? ['text', 'correct'] : ['text', 'chinese', 'correct'];
        exactKeys(option, allowed, optionLabel);
        safeText(option.text, `${optionLabel}文本`, {max: 2000});
        if (option.chinese !== undefined) safeText(option.chinese, `${optionLabel}中文`, {max: 2000});
        if (typeof option.correct !== 'boolean') fail(`${optionLabel} correct 必须是布尔值`);
    });
}

function validateQuestions(questions) {
    if (!Array.isArray(questions) || questions.length < 1 || questions.length > 5) fail('Questions 必须有 1–5 题');
    questions.forEach((question, index) => {
        const label = `题目 ${index + 1}`;
        if (!isObject(question)) fail(`${label}必须是对象`);
        const allowed = question.kind === 'vocabulary' ? ['kind', 'word', 'prompt', 'options', 'explanation'] : ['kind', 'prompt', 'options', 'explanation'];
        exactKeys(question, allowed, label);
        oneOf(question.kind, ['vocabulary', 'comprehension'], `${label}类型`);
        if (question.kind === 'vocabulary') safeText(question.word, `${label}目标词`, {max: 100});
        safeText(question.prompt, `${label}题干`, {max: 3000});
        safeText(question.explanation, `${label}答案解析`, {max: 5000});
        validateOptions(question.options, label);
    });
}

function validateCards(cards) {
    if (!Array.isArray(cards) || cards.length < 2 || cards.length > 100) fail('Candidate Cards 必须有 2–100 项');
    const fields = ['word', 'uk', 'us', 'pos', 'chinese', 'english', 'example', 'translation', 'source'];
    cards.forEach((card, index) => {
        const label = `候选词卡 ${index + 1}`;
        exactKeys(card, fields, label);
        fields.forEach(field => safeText(card[field], `${label}.${field}`, {max: 2000}));
        httpsUrl(card.source, `${label}.source`);
    });
}

function toLegacyPack(material) {
    return {
        id: material.metadata.id,
        title: material.metadata.title,
        origin: material.metadata.materialType,
        minutes: material.metadata.minutes,
        level: material.metadata.level,
        supportHint: material.metadata.supportHint,
        reviewStatus: reviewStatus(material.metadata),
        creationMethod: material.metadata.creationMethod,
        sources: material.metadata.sources.map(({title, url, date}) => ({title, url, date})),
        paragraphs: material.article.map(({text, sourceId, contentType}) => ({text, source: sourceId, contentType})),
        questions: material.questions,
        terms: material.candidateCards
    };
}

function validateMaterial(material, vocabularyCards, options) {
    exactKeys(material, ['metadata', 'article', 'questions', 'candidateCards'], '阅读材料');
    validateMetadata(material.metadata);
    validateArticle(material.article, material.metadata);
    validateQuestions(material.questions);
    validateCards(material.candidateCards);
    let pack;
    try { pack = validatePack(toLegacyPack(material), vocabularyCards, options); }
    catch (error) { fail(`现有阅读规则校验失败：${error.message}`); }
    return {material, pack};
}

function parseMaterialMarkdown(raw, vocabularyCards, filename = '<memory>', options) {
    if (typeof raw !== 'string') fail(`${filename} 内容必须是字符串`);
    if (Buffer.byteLength(raw, 'utf8') > MAX_FILE_BYTES) fail(`${filename} 超过 2 MiB 限制`);
    const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    if (HTML_PATTERN.test(normalized) || DANGEROUS_URI_PATTERN.test(normalized)) fail(`${filename} 含 HTML 或脚本 URI；材料文件只允许固定 Markdown 与 JSON 数据`);
    const match = normalized.match(DOCUMENT_PATTERN);
    if (!match) fail(`${filename} 章节、顺序或 JSON 围栏不符合 reading-material-format v${FORMAT_VERSION}`);
    const material = {
        metadata: parseJson(match[1], 'Metadata'),
        article: parseJson(match[2], 'Article'),
        questions: parseJson(match[3], 'Questions'),
        candidateCards: parseJson(match[4], 'Candidate Cards')
    };
    return validateMaterial(material, vocabularyCards, options);
}

function renderMaterialMarkdown(material, vocabularyCards) {
    validateMaterial(material, vocabularyCards);
    const block = value => JSON.stringify(value, null, 2);
    return `# Featured Reading Material\n\n## Metadata\n\n\`\`\`json\n${block(material.metadata)}\n\`\`\`\n\n## Article\n\n\`\`\`json\n${block(material.article)}\n\`\`\`\n\n## Questions\n\n\`\`\`json\n${block(material.questions)}\n\`\`\`\n\n## Candidate Cards\n\n\`\`\`json\n${block(material.candidateCards)}\n\`\`\`\n`;
}

function readMaterialFile(filename, vocabularyCards, options) {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`${path.basename(filename)} 不是普通文件`);
    if (stat.size > MAX_FILE_BYTES) fail(`${path.basename(filename)} 超过 2 MiB 限制`);
    return parseMaterialMarkdown(fs.readFileSync(filename, 'utf8'), vocabularyCards, path.basename(filename), options);
}

function scanMaterialDirectory(directory, vocabularyCards, options) {
    const materials = [], skipped = [];
    if (!fs.existsSync(directory)) return {materials, skipped: [{file: path.basename(directory), reason: '资料库目录不存在'}]};
    for (const entry of fs.readdirSync(directory, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.name.toLowerCase().endsWith('.md')) continue;
        const filename = path.join(directory, entry.name);
        try {
            if (!entry.isFile()) fail('不是普通 Markdown 文件');
            const parsed = readMaterialFile(filename, vocabularyCards, options);
            materials.push({...parsed, filename: entry.name});
        } catch (error) {
            skipped.push({file: entry.name, reason: error.message});
        }
    }
    const seen = new Set();
    for (let index = materials.length - 1; index >= 0; index--) {
        const id = materials[index].material.metadata.id;
        if (seen.has(id)) {
            skipped.push({file: materials[index].filename, reason: `文章 ID 重复：${id}`});
            materials.splice(index, 1);
        } else seen.add(id);
    }
    if (!options?.includeUnapproved) {
        for (let index = materials.length - 1; index >= 0; index--) {
            const status = reviewStatus(materials[index].material.metadata);
            if (status === 'approved') continue;
            const label = status === 'pending' ? '待人工审核' : '审核不通过';
            skipped.push({file: materials[index].filename, reason: `审核状态为“${label}”，未进入随机候选池`});
            materials.splice(index, 1);
        }
    }
    return {materials, skipped};
}

module.exports = {
    FORMAT_VERSION,
    MAX_FILE_BYTES,
    MaterialValidationError,
    parseMaterialMarkdown,
    renderMaterialMarkdown,
    readMaterialFile,
    scanMaterialDirectory,
    toLegacyPack,
    validateMaterial,
    reviewStatus
};
