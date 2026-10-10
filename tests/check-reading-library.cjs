'use strict';
const {PROJECT_ROOT, copyProjectFiles} = require('./helpers.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {once} = require('node:events');
const {chromium} = require('playwright');
const {startServer, audit, readLibrary} = require('../server/reading-server.cjs');
const {parseMaterialMarkdown, renderMaterialMarkdown} = require('../modules/reading/reading-materials.cjs');
const {waterCycleMarkdown} = require('./test-reading-fixtures.cjs');

(async () => {
    const original = readLibrary(PROJECT_ROOT);
    const cards = audit(original.html, original.index).names.map(word => ({word}));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reading-library-ui-'));
    const directory = path.join(root, 'reading_materials');
    fs.mkdirSync(directory);
    copyProjectFiles(root);
    for (const minutes of [20, 45]) fs.writeFileSync(path.join(directory, `fixture-water-cycle-${minutes}.md`), waterCycleMarkdown(cards, minutes));
    fs.writeFileSync(path.join(root, 'modules/reading/reading-supplements.json'), '[]');
    fs.writeFileSync(path.join(root, '.env'), 'READING_ALLOW_EXTERNAL_CALLS=true\nTAVILY_API_KEY=mock-only\nDEEPSEEK_API_KEY=mock-only\n');
    const base = parseMaterialMarkdown(fs.readFileSync(path.join(PROJECT_ROOT, 'reading_materials', 'docker-user-v1-0.md'), 'utf8'), cards).material;
    const question = (word, english) => ({kind: 'vocabulary', word, prompt: `Meaning of ${word}?`, options: [{text: english, chinese: '正确解释', correct: true}, {text: 'an unrelated meaning', chinese: '无关解释', correct: false}, {text: 'another unrelated meaning', chinese: '另一解释', correct: false}], explanation: 'Test fixture, refer to the paragraph.'});
    base.questions.push(question('automate', base.candidateCards[0].english), question('reliable', 'able to be trusted'));
    const write = (id, type = 'website') => {
        const material = structuredClone(base);
        material.metadata.id = id; material.metadata.title = `Local ${id}`; material.metadata.materialType = type;
        material.metadata.sources[0].sourceType = type === 'website' ? 'website' : 'input_file';
        // Distinct prose is essential: changing only ID/title used to conceal false variety.
        const scenarios = {
            'local-a': 'A laboratory prepares a reliable program for sharing measurements. Its complex environment combines several services. Researchers must integrate the tools and accelerate repeatable checks before sharing their work.',
            'local-b': 'A school prepares a reliable program for managing lessons. Its complex environment connects class lists with a timetable. Teachers integrate the tools and accelerate routine updates before a new term.',
            'local-input': 'A local shop needs a reliable program for stock control. Its complex environment connects orders and deliveries. Staff integrate the tools to accelerate checks before accepting another shipment.',
            'z-hot': 'A library develops a reliable program for tracking loans. Its complex environment joins reader accounts and book records. Staff integrate the tools and accelerate daily checks before opening each morning.'
        };
        material.article[0].text = scenarios[id];
        fs.writeFileSync(path.join(directory, `${id}.md`), renderMaterialMarkdown(material, cards));
    };
    write('local-a'); write('local-b'); write('local-input', 'input');
    fs.writeFileSync(path.join(directory, 'duplicate.md'), fs.readFileSync(path.join(directory, 'local-a.md'), 'utf8').replace('"id": "local-a"', '"id": "same-prose-new-id"').replace('"title": "Local local-a"', '"title": "A renamed duplicate"'));
    fs.writeFileSync(path.join(directory, 'broken.md'), '# malformed material');
    let generationCalls = 0, releaseGeneration;
    const server = startServer({root, port: 0, generatorFactory: () => ({generate: async input => {
        generationCalls++;
        assert.equal(input.modelProvider, 'deepseek'); assert.equal(input.minutes, 20); assert.equal(input.count, 2);
        await new Promise(resolve => { releaseGeneration = resolve; });
        return {files: ['mock-a.md', 'mock-b.md'], sources: [], skippedSources: [], usage: {cost: {totalUsd: 0, actualCostUsd: null}}, retention: {mode: 'confirm', limit: 3, candidates: [{id: 'generated-cleanup-old', title: 'Old generated reading', minutes: 20}], kept: [], skipped: []}};
    }})});
    await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({channel: 'msedge', headless: true});
    const errors = [], external = [];
    try {
        const context = await browser.newContext({viewport: {width: 1280, height: 900}});
        await context.route('**/*', route => {
            if (!route.request().url().startsWith(url)) { external.push(route.request().url()); return route.abort(); }
            return route.continue();
        });
        const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
        await page.addInitScript(() => { Math.random = () => .5; });
        await page.goto(url); await page.locator('#quizSkipButton').click();
        await page.locator('#readingTrigger').click();
        const enter = async minutes => {
            await page.locator(`[data-minutes="${minutes}"]`).click();
            await page.waitForSelector('.reading-prose');
            return page.evaluate(() => FeaturedReading.current());
        };
        const first = await enter(5);
        assert(first.id.startsWith('local-'), 'Markdown is preferred over built-in material');
        assert.equal(first.origin, 'website');
        assert(first.knownWords.length >= 4 && first.newWords.length >= 2);
        assert((await page.locator('#readingBody').textContent()).includes('broken.md'));
        assert((await page.locator('#readingBody').textContent()).includes('相同正文已合并'), 'Different IDs must not fake new content');
        await page.locator('#readingClose').click();
        const second = await enter(5); assert.notEqual(first.id, second.id);
        await page.getByRole('button', {name: '换一组阅读', exact: true}).click();
        await page.waitForFunction(id => FeaturedReading.current()?.id !== id, second.id);
        assert.equal(generationCalls, 0);
        write('z-hot');
        await page.evaluate(() => { Math.random = () => .99; });
        await page.getByRole('button', {name: '换一组阅读', exact: true}).click();
        await page.waitForFunction(() => FeaturedReading.current()?.id === 'z-hot');
        assert.equal(fs.readFileSync(path.join(root, 'vocabulary.html'), 'utf8'), original.html, 'Adding a Markdown file needs no page edit');
        fs.unlinkSync(path.join(directory, 'z-hot.md'));
        await page.locator('#readingClose').click();
        await page.evaluate(() => { Math.random = () => .1; });
        assert.equal((await enter(5)).origin, 'input', '20% source branch remains available');
        await page.locator('#readingClose').click();
        await page.evaluate(() => { Math.random = () => .5; });
        for (const minutes of [20, 45]) {
            const reading = await enter(minutes);
            assert.equal(reading.id, `fixture-water-cycle-${minutes}`);
            assert.equal(reading.minutes, minutes);
            assert(reading.knownWords.length >= 4 && reading.newWords.length >= 2);
            assert.equal(fs.readFileSync(path.join(root, 'vocabulary.html'), 'utf8'), original.html, '20/45min Markdown needs no page edit');
            assert(!(await page.locator('#readingBody').textContent()).includes('已使用预置材料'));
            await page.locator('#readingClose').click();
        }
        for (const minutes of [20, 45]) fs.unlinkSync(path.join(directory, `fixture-water-cycle-${minutes}.md`));
        for (const minutes of [20, 45]) {
            await enter(minutes);
            assert((await page.locator('#readingBody').textContent()).includes('已使用预置材料'));
            await page.locator('#readingClose').click();
        }
        await enter(5);
        // Changes to actual DOM cards must defeat stale server eligibility markers.
        await page.evaluate(() => {
            const card = document.querySelector('#wordList .word-card').cloneNode(true);
            card.querySelector('.word-header h2').textContent = 'automate';
            card.id = 'temporary-known-card'; document.querySelector('#wordList').append(card);
        });
        await page.getByRole('button', {name: '换一组阅读', exact: true}).click();
        await page.waitForFunction(() => FeaturedReading.current()?.id.startsWith('water-v1-'));
        await page.evaluate(() => document.querySelector('#temporary-known-card').remove());
        await page.locator('#readingClose').click(); await enter(5);
        const before = await page.evaluate(() => JSON.stringify(progress));
        await page.locator('.reading-question[data-kind="comprehension"] [data-correct="true"]').click();
        assert.equal(await page.evaluate(() => JSON.stringify(progress)), before);
        await page.locator('.reading-question[data-word="reliable"] [data-correct="true"]').click();
        await page.waitForFunction(() => document.querySelector('.reading-question[data-word="reliable"] .quiz-option').disabled);
        assert.equal(await page.evaluate(() => getWordProgress('reliable').reviews), .5);
        await page.locator('.reading-question[data-word="repository"] .reading-help').click();
        for (const word of ['repository', 'automate']) {
            await page.locator(`.reading-question[data-word="${word}"] [data-correct="false"]`).first().click();
            await page.waitForFunction(w => FeaturedReading.pending().length === 0 && Array.from(document.querySelectorAll('#wordList .word-header h2')).some(n => n.textContent === w), word);
            assert.equal(await page.evaluate(w => getWordProgress(w).mistakes, word), 1);
            const disk = readLibrary(root), report = audit(disk.html, disk.index);
            assert(report.names.includes(word)); assert.deepEqual(report.htmlOnly, []);
        }
        assert.deepEqual(await page.evaluate(() => getTodayScoreRecord()), {score: 2, questions: 4});
        assert(!fs.existsSync(path.join(root, '.reading-transaction.json')));
        const catalog = await (await fetch(url + '/api/reading')).json();
        assert.equal(catalog.materials.length, 0, 'Two new words became known, so article is no longer eligible');
        assert(catalog.warnings.some(item => item.reason.includes('未收录词')));
        await page.reload(); await page.locator('#quizSkipButton').click();
        assert.equal(await page.evaluate(() => getWordProgress('repository').mistakes), 1);
        assert.deepEqual(await page.evaluate(() => getTodayScoreRecord()), {score: 2, questions: 4});
        await page.locator('#readingTrigger').click(); await enter(20);
        await page.locator('#readingGenerator > summary').click();
        assert.deepEqual(await page.locator('#readingGeneratorBody select').nth(0).locator('option').evaluateAll(options => options.map(option => option.value)), ['tavily']);
        assert.deepEqual(await page.locator('#readingGeneratorBody select').nth(1).locator('option').evaluateAll(options => options.map(option => option.value)), ['deepseek']);
        await page.getByLabel('生成篇数', {exact: true}).selectOption('2');
        await page.getByLabel('英文检索词', {exact: false}).fill('science education');
        await page.locator('.reading-generation-confirm input').check();
        await page.getByRole('button', {name: '检索并生成', exact: true}).click();
        await page.waitForFunction(() => document.querySelector('.reading-generation-status').textContent.includes('DeepSeek · 20min · 2 篇'));
        assert.equal(generationCalls, 1);
        assert(await page.getByRole('button', {name: '检索并生成', exact: true}).isDisabled());
        releaseGeneration();
        await page.waitForFunction(() => document.querySelector('.reading-generation-status').textContent.includes('已保存 2 篇待人工审核的文章'));
        await page.getByText('有 1 篇旧模型材料可清理（需要确认）', {exact:true}).click();
        assert(await page.getByRole('button', {name: '确认清理 1 篇', exact: true}).isVisible());
        await page.getByRole('button', {name: '确认清理 1 篇', exact: true}).click();
        await page.waitForFunction(() => document.querySelector('.reading-generation-status').textContent.includes('因状态变化或文件错误保留'));
        // Missing service: keep built-in reading and expose a useful supplement message.
        await page.route('**/api/reading', route => route.abort());
        await page.locator('#readingClose').click(); await enter(5);
        assert((await page.locator('#readingBody').textContent()).includes('本地服务未连接'));
        assert((await page.locator('#readingGeneratorBody').textContent()).includes('启动词库.cmd'));
        await page.evaluate(() => { ReadingEngine.makeReading = () => { throw Error('No material'); }; });
        await page.locator('#readingClose').click(); await page.locator('[data-minutes="45"]').click();
        await page.waitForFunction(() => document.querySelector('#readingBody').textContent.includes('暂时没有匹配的短文'));
        assert.equal(await page.evaluate(() => FeaturedReading.current()), null);
        assert.deepEqual(external, []); assert.deepEqual(errors, []);
        assert.equal(generationCalls, 1, 'Only the explicit generate action invokes the model pipeline');
        console.log(JSON.stringify({result: 'PASS', checks: ['Markdown preference and damage reasons', 'close/reopen and next avoid repeats', 'website/input weighted choice', 'current HTML coverage revalidation', '20/45 minute formal Markdown without page edits', '20/45 minute fallback after formal material removal', 'Markdown comprehension and vocabulary scoring', 'both new words save after eligibility exhaustion', 'transaction and index synchronization', 'reload learning records', 'explicit generation provider/duration/count/status', 'cleanup confirmation UI', 'offline and no-material messages', 'no external requests or real-library writes']}, null, 2));
    } finally {
        if (releaseGeneration) releaseGeneration();
        await browser.close();
        await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
        assert.equal(fs.readFileSync(path.join(PROJECT_ROOT, 'vocabulary.html'), 'utf8'), original.html);
        assert.equal(fs.readFileSync(path.join(PROJECT_ROOT, 'learned_words.json'), 'utf8'), original.indexText);
        fs.rmSync(root, {recursive: true, force: true});
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
