'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {readLibrary, audit} = require('./reading-server.cjs');
const {parseMaterialMarkdown, renderMaterialMarkdown, scanMaterialDirectory} = require('./reading-materials.cjs');
const {difficulty} = require('./reading-engine.js');
const {waterCycleMarkdown} = require('./test-reading-fixtures.cjs');

const library = readLibrary(__dirname);
const vocabularyCards = audit(library.html, library.index).names.map(word => ({word}));
const directory = path.join(__dirname, 'reading_materials');
const result = scanMaterialDirectory(directory, vocabularyCards);

assert.equal(result.skipped.length, 0, JSON.stringify(result.skipped));
const exampleNames = ['docker-user-v1-0.md', 'docker-user-v1-1.md', 'docker-user-v1-2.md'];
assert(exampleNames.every(filename => result.materials.some(item => item.filename === filename)), '应保留三个迁移示例，同时允许新增合格文章');
assert.equal(new Set(result.materials.map(item => item.material.metadata.id)).size, result.materials.length, '文章 ID 必须唯一');
for (const item of result.materials) {
    assert.equal(item.material.metadata.formatVersion, 1);
    assert.equal(item.pack.reviewStatus, 'approved', '随机候选池只允许已人工审核材料');
    if (exampleNames.includes(item.filename)) {
        assert(item.material.article.every(paragraph => paragraph.contentType === 'learning_adaptation'));
        assert(item.material.metadata.sources.every(source => source.sourceType === 'user_input'));
    }
    const rendered = renderMaterialMarkdown(item.material, vocabularyCards);
    assert.deepEqual(parseMaterialMarkdown(rendered, vocabularyCards).material, item.material, '格式应可稳定往返');
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'reading-material-format-test-'));
try {
    const editions = path.join(temp, 'editions');
    fs.mkdirSync(editions);
    for (const minutes of [20, 45]) {
        fs.writeFileSync(path.join(editions, `fixture-water-cycle-${minutes}.md`), waterCycleMarkdown(vocabularyCards, minutes));
    }
    const fixtures = scanMaterialDirectory(editions, vocabularyCards);
    assert.deepEqual(fixtures.skipped, []);
    assert.equal(fixtures.materials.length, 2, '20/45min Markdown 应直接进入资料库，不依赖本地论文文件');
    for (const minutes of [20, 45]) {
        const item = fixtures.materials.find(entry => entry.material.metadata.id === `fixture-water-cycle-${minutes}`);
        assert(item, `${minutes}min 测试材料应可读取`);
        assert.equal(item.pack.minutes, minutes);
        assert.equal(item.pack.level, difficulty(vocabularyCards.length).level);
        assert.equal(item.pack.reviewStatus, 'approved');
        assert(item.pack.knownWords.length >= 4 && item.pack.newWords.length >= 2);
        assert(Math.abs(item.pack.wordCount / item.pack.wpm - minutes) <= minutes * .2);
        assert(item.pack.questions.length >= 1 && item.pack.questions.length <= 5);
        assert(item.pack.questions.some(question => question.kind === 'vocabulary'));
        assert(item.pack.questions.every(question => question.options.filter(option => option.correct).length === 1));
        assert(item.material.article.some(paragraph => paragraph.contentType === 'original_excerpt'));
        assert(item.material.article.some(paragraph => paragraph.contentType === 'learning_adaptation'));
        assert.deepEqual(parseMaterialMarkdown(renderMaterialMarkdown(item.material, vocabularyCards), vocabularyCards).material, item.material);
        const invalid = structuredClone(item.material);
        invalid.article = invalid.article.slice(0, 1);
        assert.throws(() => renderMaterialMarkdown(invalid, vocabularyCards), /现有阅读规则/, '长度或覆盖不足不得入库');
        const pending = structuredClone(item.material);
        pending.metadata.id += '-pending';
        pending.metadata.reviewStatus = 'pending';
        fs.writeFileSync(path.join(editions, `${minutes}-pending.md`), renderMaterialMarkdown(pending, vocabularyCards));
    }
    const reviewed = scanMaterialDirectory(editions, vocabularyCards);
    assert.equal(reviewed.materials.length, 2, '待审核测试材料不得进入随机候选池');
    assert.equal(reviewed.skipped.length, 2);
    assert(reviewed.skipped.every(item => item.reason.includes('待人工审核')));
    const validText = fs.readFileSync(path.join(directory, 'docker-user-v1-0.md'), 'utf8');
    fs.writeFileSync(path.join(temp, 'valid.md'), validText);
    fs.writeFileSync(path.join(temp, 'bad-json.md'), validText.replace('"formatVersion": 1', '"formatVersion":'));
    fs.writeFileSync(path.join(temp, 'unsafe-html.md'), validText.replace('Tools, Teams, and Shared Work', '<script>globalThis.__materialExecuted = true</script>'));
    fs.writeFileSync(path.join(temp, 'bad-version.md'), validText.replace('"formatVersion": 1', '"formatVersion": 99'));
    fs.writeFileSync(path.join(temp, 'bad-coverage.md'), validText.replace(/capacity/gi, 'plainword').replace(/reliable/gi, 'steadyword').replace(/complex/gi, 'hardword').replace(/integrate/gi, 'combineword').replace(/accelerate/gi, 'speedword'));
    globalThis.__materialExecuted = false;
    const damaged = scanMaterialDirectory(temp, vocabularyCards);
    assert.equal(damaged.materials.length, 1);
    assert.equal(damaged.skipped.length, 4);
    assert(damaged.skipped.some(item => item.file === 'bad-json.md' && item.reason.includes('有效 JSON')));
    assert(damaged.skipped.some(item => item.file === 'unsafe-html.md' && item.reason.includes('HTML')));
    assert(damaged.skipped.some(item => item.file === 'bad-version.md' && item.reason.includes('格式版本')));
    assert(damaged.skipped.some(item => item.file === 'bad-coverage.md' && item.reason.includes('现有阅读规则')));
    assert.equal(globalThis.__materialExecuted, false, '材料内容绝不能执行');
} finally {
    fs.rmSync(temp, {recursive: true, force: true});
}

console.log(JSON.stringify({
    result: 'PASS',
    formatVersion: 1,
    validMaterials: result.materials.map(item => item.filename),
    checks: ['strict section order', 'JSON-only data parsing', 'no HTML execution', 'stable round trip', 'unique IDs', 'source/content provenance', 'approved-only random pool', '20/45 minute formal materials', 'legacy coverage/length/question/card validation', 'damaged files skipped with reasons']
}, null, 2));
