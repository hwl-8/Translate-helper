'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {audit, readLibrary} = require('./reading-server.cjs');
const {parseMaterialMarkdown, renderMaterialMarkdown, scanMaterialDirectory} = require('./reading-materials.cjs');
const {executeRetentionCleanup, planGeneratedRetention} = require('./reading-retention.cjs');

const library = readLibrary(__dirname);
const cards = audit(library.html, library.index).names.map(word => ({word}));
const base = parseMaterialMarkdown(fs.readFileSync(path.join(__dirname, 'reading_materials', 'docker-user-v1-0.md'), 'utf8'), cards).material;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'reading-retention-test-'));

function writeMaterial(id, {creationMethod = 'model_generated', reviewStatus = 'approved', retentionPolicy = 'standard', generatedDate = '2026-09-01'} = {}) {
    const material = structuredClone(base);
    Object.assign(material.metadata, {id, title: `Retention ${id}`, creationMethod, reviewStatus, generatedDate});
    if (reviewStatus === undefined) delete material.metadata.reviewStatus;
    if (creationMethod === 'model_generated') material.metadata.retentionPolicy = retentionPolicy;
    else delete material.metadata.retentionPolicy;
    const filename = path.join(temp, `${id}.md`);
    fs.writeFileSync(filename, renderMaterialMarkdown(material, cards));
    return filename;
}

try {
    writeMaterial('manual-anchor', {creationMethod: 'learning_adaptation'});
    writeMaterial('manual-legacy', {creationMethod: 'manual_migration', reviewStatus: undefined});
    writeMaterial('generated-history', {retentionPolicy: 'preserve', generatedDate: '2026-08-01'});
    const oldA = writeMaterial('generated-old-a', {generatedDate: '2026-09-01'});
    const oldB = writeMaterial('generated-old-b', {reviewStatus: 'pending', generatedDate: '2026-09-02'});
    const middle = writeMaterial('generated-middle', {generatedDate: '2026-09-03'});
    const current = writeMaterial('generated-current', {generatedDate: '2026-09-04'});
    const newest = writeMaterial('generated-newest', {reviewStatus: 'pending', generatedDate: '2026-09-05'});
    writeMaterial('generated-rejected', {reviewStatus: 'rejected', generatedDate: '2026-08-30'});

    const visible = scanMaterialDirectory(temp, cards);
    assert(visible.materials.some(item => item.material.metadata.id === 'manual-anchor'));
    assert(visible.materials.some(item => item.material.metadata.id === 'manual-legacy'), '旧版非模型材料缺少审核字段时保持兼容');
    assert(!visible.materials.some(item => item.material.metadata.id === 'generated-old-b'));
    assert(!visible.materials.some(item => item.material.metadata.id === 'generated-rejected'));
    assert(visible.skipped.some(item => item.reason.includes('待人工审核')));
    assert(visible.skipped.some(item => item.reason.includes('审核不通过')));

    const plan = planGeneratedRetention(temp, cards, {limit: 2, protectedMaterialIds: ['generated-old-b']});
    assert(plan.candidates.some(item => item.id === 'generated-old-a'));
    assert(plan.candidates.some(item => item.id === 'generated-middle'));
    assert(!plan.candidates.some(item => item.id === 'generated-current' || item.id === 'generated-newest'));
    assert(plan.kept.some(item => item.id === 'manual-anchor' && item.reason.includes('不参与清理')));
    assert(plan.kept.some(item => item.id === 'generated-history' && item.reason.includes('指定保留')));
    assert(plan.skipped.some(item => item.id === 'generated-old-b' && item.reason.includes('当前正在阅读')));

    const blocked = planGeneratedRetention(temp, cards, {limit: 2, hasPendingWords: true});
    assert.equal(blocked.candidates.length, 0);
    assert(blocked.skipped.some(item => item.reason.includes('待保存错词')));

    const result = executeRetentionCleanup(temp, cards, ['generated-old-a', 'generated-middle', 'manual-anchor'], {
        limit: 2,
        protectedMaterialIds: ['generated-old-b'],
        removeFile(filename) {
            if (path.basename(filename) === path.basename(oldA)) throw Error('simulated cleanup failure');
            fs.unlinkSync(filename);
        }
    });
    assert(result.failed.some(item => item.id === 'generated-old-a'));
    assert(result.cleaned.some(item => item.id === 'generated-middle'));
    assert(result.skipped.some(item => item.id === 'manual-anchor'));
    assert(fs.existsSync(oldA), '清理失败的文件必须保留');
    assert(fs.existsSync(oldB), '受保护的文件必须保留');
    assert(fs.existsSync(current), '当前保留窗口内的文件必须保留');
    assert(fs.existsSync(newest), '最新生成文件不得因旧文件清理失败而损坏');

    console.log(JSON.stringify({
        result: 'PASS',
        checks: ['pending/rejected review states excluded with reasons', 'legacy-compatible approved pool', 'manual and preserved materials protected', 'current and pending-word protection', 'per-slot retention limit', 'confirmation-only cleanup', 'exact eligible IDs', 'cleanup failure leaves new and protected materials intact']
    }, null, 2));
} finally {
    fs.rmSync(temp, {recursive: true, force: true});
}
