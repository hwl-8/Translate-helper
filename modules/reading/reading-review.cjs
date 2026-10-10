'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {MAX_FILE_BYTES, parseMaterialMarkdown, validateMaterial} = require('./reading-materials.cjs');
const {difficulty} = require('./reading-engine.js');

function failure(status, code, message) {
    return Object.assign(new Error(message), {status, code});
}
const revisionOf = raw => crypto.createHash('sha256').update(raw).digest('hex');

function readOrdinary(filename) {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw Error('不是普通文件或超过 2 MiB');
    return fs.readFileSync(filename);
}

function scanReviews(directory, cards) {
    const materials = [], skipped = [];
    if (!fs.existsSync(directory)) return {materials, skipped};
    if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) {
        throw failure(500, 'REVIEW_READ_FAILED', '资料目录必须是本地普通目录');
    }
    for (const entry of fs.readdirSync(directory, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.name.toLowerCase().endsWith('.md')) continue;
        try {
            if (!entry.isFile()) throw Error('不是普通 Markdown 文件');
            const raw = readOrdinary(path.join(directory, entry.name));
            const parsed = parseMaterialMarkdown(raw.toString('utf8'), cards, entry.name, {checkEligibility: false});
            let eligibilityReason = null;
            try { validateMaterial(parsed.material, cards); }
            catch (error) { eligibilityReason = error.message; }
            if (!eligibilityReason && parsed.material.metadata.level !== difficulty(cards.length).level) eligibilityReason = '材料难度与当前词库档位不匹配，暂不能进入当前随机池';
            materials.push({...parsed, filename: entry.name, revision: revisionOf(raw), eligibilityReason});
        } catch (error) { skipped.push({filename: entry.name, code: 'INVALID_MATERIAL', reason: error.message}); }
    }
    return {materials, skipped};
}

function reviewMaterial(directory, cards, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || input.confirm !== true ||
        typeof input.id !== 'string' || input.id.length > 100 || !/^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/.test(input.id) ||
        typeof input.revision !== 'string' || !/^[a-f0-9]{64}$/.test(input.revision) ||
        !['approved', 'rejected', 'pending'].includes(input.status) ||
        Object.keys(input).some(key => !['confirm', 'id', 'revision', 'status'].includes(key))) {
        throw failure(400, 'INVALID_REVIEW_REQUEST', '需要 confirm:true、有效 id、SHA256 revision 和 approved/rejected/pending status；不接受路径或额外字段');
    }
    const matches = scanReviews(directory, cards).materials.filter(item => item.material.metadata.id === input.id);
    if (!matches.length) throw failure(404, 'MATERIAL_NOT_FOUND', '没有找到结构合格的材料');
    if (matches.length !== 1) throw failure(409, 'DUPLICATE_MATERIAL_ID', '文章 ID 重复，请先处理重复文件');
    const item = matches[0];
    if (item.revision !== input.revision) throw failure(409, 'REVISION_CONFLICT', '材料已变化，请重新读取后审核');
    if (input.status === 'approved' && item.eligibilityReason) throw failure(422, 'MATERIAL_INELIGIBLE', item.eligibilityReason);
    const filename = path.join(directory, item.filename);
    const raw = readOrdinary(filename);
    if (revisionOf(raw) !== input.revision) throw failure(409, 'REVISION_CONFLICT', '材料已变化，请重新读取后审核');
    // Replace only Metadata JSON; preserve article, questions, cards and original line endings.
    const newline = raw.includes(Buffer.from('\r\n')) ? '\r\n' : '\n';
    const metadata = {...item.material.metadata, reviewStatus: input.status};
    const next = raw.toString('utf8').replace(/(## Metadata\r?\n\r?\n```json\r?\n)[\s\S]*?(\r?\n```)/,
        (_, before, after) => before + JSON.stringify(metadata, null, 2).replace(/\n/g, newline) + after);
    const parsed = parseMaterialMarkdown(next, cards, item.filename, {checkEligibility: input.status === 'approved'});
    const temp = path.join(directory, `.review-${crypto.randomUUID()}.tmp`);
    let fd;
    try {
        fd = fs.openSync(temp, 'wx');
        fs.writeFileSync(fd, next, 'utf8');
        fs.fsyncSync(fd);
        fs.closeSync(fd); fd = undefined;
        if (revisionOf(readOrdinary(filename)) !== input.revision) throw failure(409, 'REVISION_CONFLICT', '材料已变化，请重新读取后审核');
        fs.renameSync(temp, filename);
    } catch (error) {
        if (error.code === 'REVISION_CONFLICT') throw error;
        throw Object.assign(failure(500, 'REVIEW_SAVE_FAILED', '审核状态保存失败，原材料未替换'), {cause: error});
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
    return {...parsed, filename: item.filename, revision: revisionOf(Buffer.from(next)), eligibilityReason: item.eligibilityReason,
        id: input.id, status: input.status};
}

module.exports = {scanReviews, reviewMaterial, failure};
