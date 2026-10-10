'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {readMaterialFile, reviewStatus, scanMaterialDirectory} = require('./reading-materials.cjs');

const DEFAULT_RETENTION_LIMIT = 3;

function slotOf(metadata) {
    return `${metadata.minutes}:${metadata.level}`;
}

function safeIds(values) {
    if (!Array.isArray(values)) return new Set();
    return new Set(values.filter(value => typeof value === 'string' && /^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/.test(value)));
}

function fileTime(directory, filename) {
    try { return fs.lstatSync(path.join(directory, filename)).mtimeMs || 0; }
    catch (_) { return 0; }
}

function planGeneratedRetention(directory, vocabularyCards, {
    limit = DEFAULT_RETENTION_LIMIT,
    protectedMaterialIds = [],
    hasPendingWords = false
} = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw Error('生成材料保留上限必须是 1–20 的整数');
    const protectedIds = safeIds(protectedMaterialIds);
    const scan = scanMaterialDirectory(directory, vocabularyCards, {includeUnapproved: true});
    const groups = new Map();
    for (const item of scan.materials) {
        const metadata = item.material.metadata;
        const entry = {
            id: metadata.id,
            file: item.filename,
            title: metadata.title,
            minutes: metadata.minutes,
            level: metadata.level,
            generatedDate: metadata.generatedDate,
            creationMethod: metadata.creationMethod,
            retentionPolicy: metadata.retentionPolicy || 'standard',
            reviewStatus: reviewStatus(metadata),
            mtimeMs: fileTime(directory, item.filename)
        };
        const slot = slotOf(metadata);
        if (!groups.has(slot)) groups.set(slot, []);
        groups.get(slot).push(entry);
    }

    const candidates = [];
    const kept = [];
    const skipped = scan.skipped.map(item => ({file: item.file, reason: `文件不合格，未参与清理：${item.reason}`}));
    for (const [slot, entries] of groups) {
        const approved = entries.filter(entry => entry.reviewStatus === 'approved');
        const generated = entries.filter(entry => entry.creationMethod === 'model_generated');
        const standard = generated.filter(entry => entry.retentionPolicy === 'standard')
            .sort((a, b) => b.generatedDate.localeCompare(a.generatedDate) || b.mtimeMs - a.mtimeMs || b.id.localeCompare(a.id));
        const retained = new Set(standard.slice(0, limit).map(entry => entry.id));

        for (const entry of entries.filter(item => item.creationMethod !== 'model_generated')) {
            kept.push({...entry, reason: '人工导入、用户输入或手工迁移材料不参与清理'});
        }
        for (const entry of generated.filter(item => item.retentionPolicy === 'preserve')) {
            kept.push({...entry, reason: '材料标记为指定保留'});
        }
        for (const entry of standard.filter(item => retained.has(item.id))) {
            kept.push({...entry, reason: `属于同档位同难度最近 ${limit} 篇模型材料`});
        }

        let approvedRemaining = approved.length;
        for (const entry of standard.filter(item => !retained.has(item.id)).reverse()) {
            let reason = '';
            if (hasPendingWords) reason = '浏览器仍有待保存错词，本次不允许清理';
            else if (protectedIds.has(entry.id)) reason = '当前正在阅读或存在未完成答题';
            else if (entry.reviewStatus === 'approved' && approvedRemaining <= 1) reason = '删除后该档位和难度将没有合格材料';
            if (reason) {
                skipped.push({...entry, reason});
                continue;
            }
            candidates.push({...entry, reason: `超过同档位同难度最近 ${limit} 篇上限；删除后仍有合格材料覆盖 ${slot}`});
            if (entry.reviewStatus === 'approved') approvedRemaining--;
        }
    }
    return {mode: 'confirm', limit, candidates, kept, skipped};
}

function executeRetentionCleanup(directory, vocabularyCards, requestedIds, options = {}) {
    const requested = safeIds(requestedIds);
    if (!requested.size) throw Error('没有选择需要清理的材料');
    const plan = planGeneratedRetention(directory, vocabularyCards, options);
    const allowed = new Map(plan.candidates.map(item => [item.id, item]));
    const cleaned = [], failed = [], skipped = [];
    const root = path.resolve(directory) + path.sep;
    const removeFile = options.removeFile || (filename => fs.unlinkSync(filename));

    for (const id of requested) {
        const item = allowed.get(id);
        if (!item) {
            skipped.push({id, reason: '该材料已不符合安全清理条件'});
            continue;
        }
        const filename = path.resolve(directory, item.file);
        try {
            if (!filename.startsWith(root)) throw Error('文件路径超出资料目录');
            const stat = fs.lstatSync(filename);
            if (!stat.isFile() || stat.isSymbolicLink()) throw Error('目标不是普通文件');
            const parsed = readMaterialFile(filename, vocabularyCards, {includeUnapproved: true});
            const metadata = parsed.material.metadata;
            if (metadata.id !== id || metadata.creationMethod !== 'model_generated' || (metadata.retentionPolicy || 'standard') !== 'standard') throw Error('文件状态已变化，拒绝清理');
            removeFile(filename);
            cleaned.push({id, file: item.file, title: item.title});
        } catch (error) {
            failed.push({id, file: item.file, reason: error.message});
        }
    }
    return {cleaned, failed, skipped, plan};
}

module.exports = {DEFAULT_RETENTION_LIMIT, executeRetentionCleanup, planGeneratedRetention, slotOf};
