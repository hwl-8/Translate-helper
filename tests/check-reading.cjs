'use strict';
const {PROJECT_ROOT, copyProjectFiles} = require('./helpers.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {once} = require('node:events');
const {pathToFileURL} = require('node:url');
const {chromium} = require('playwright');
const {startServer, audit, readLibrary, appendWord, recover} = require('../server/reading-server.cjs');
const engine = require('../modules/reading/reading-engine.js');
const bank = require('../modules/reading/reading-bank.js');
const nasa = require('../modules/reading/reading-nasa.js');
const {importReading} = require('../tools/import-reading.cjs');

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vocabulary-reading-test-'));
    const original = readLibrary(PROJECT_ROOT);
    const originalAudit = audit(original.html, original.index);
    copyProjectFiles(root);
    // Never use the real library or the user's browser profile for mutations.
    const server = startServer({root, port: 0}); await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({channel: 'msedge', headless: true});
    try {
        for (const count of [30, 100, 500]) {
            const cards = originalAudit.names.map(word => ({word}));
            while (cards.length < count) cards.push({word: 'testword' + cards.length});
            for (const minutes of [5, 20, 45]) for (let attempt = 0; attempt < 10; attempt++) {
                const reading = engine.makeReading(bank, nasa, cards, minutes);
                assert(reading.knownWords.length >= 4 && reading.newWords.length >= 2);
                assert(reading.questions.length >= 1 && reading.questions.length <= 5);
                assert(reading.questions.some(q => q.kind === 'vocabulary'));
                assert(Math.abs(reading.wordCount / reading.wpm - minutes) < minutes * .2);
                assert.equal(new Set(reading.paragraphs.map(p => p.text)).size, reading.paragraphs.length, 'No duplicated padding');
            }
        }
        for (const pack of require('../modules/reading/reading-supplements.json')) engine.validatePack(pack, originalAudit.names.map(word => ({word})));
        assert.throws(() => engine.makeReading(bank, nasa, [], 5), /4/);
        assert.throws(() => engine.makeReading(bank, nasa, [...originalAudit.names, ...bank.terms.map(t => t.word)].map(word => ({word})), 5), /不足 2/);
        const page = await browser.newPage({viewport: {width: 1280, height: 900}});
        const errors = []; page.on('pageerror', e => errors.push(e.message));
        // Make primary-source selection deterministic; fresh word order remains valid.
        await page.addInitScript(() => { Math.random = () => .5; });
        await page.goto(url); await page.locator('#quizSkipButton').click();
        const beforeButton = await page.locator('#readingTrigger').boundingBox();
        await page.locator('#readingTrigger').click();
        const afterButton = await page.locator('#readingLevels').boundingBox();
        assert.equal(beforeButton.x, afterButton.x); assert.equal(beforeButton.y, afterButton.y); assert(afterButton.width > beforeButton.width);
        for (const minutes of [5, 20, 45]) {
            await page.locator(`[data-minutes="${minutes}"]`).click();
            await page.waitForSelector('.reading-prose');
            const reading = await page.evaluate(() => FeaturedReading.current());
            assert.equal(reading.minutes, minutes); assert(reading.sources.length > 0);
            assert.equal(await page.locator('.reading-question').count(), minutes === 5 ? 2 : minutes === 20 ? 3 : 5);
            await page.locator('#readingClose').click();
        }
        await page.locator('[data-minutes="45"]').click(); await page.waitForSelector('.reading-prose');
        const passage = await page.evaluate(() => FeaturedReading.current());
        const baseline = await page.evaluate(() => JSON.stringify(progress));
        const comprehension = page.locator('.reading-question[data-kind="comprehension"]').first();
        await comprehension.locator('[data-correct="true"]').click();
        await page.waitForFunction(() => document.querySelector('.reading-question[data-kind="comprehension"] .quiz-option').disabled);
        assert.equal(await page.evaluate(() => JSON.stringify(progress)), baseline, 'Comprehension never changes word progress');
        assert.deepEqual(await page.evaluate(() => getTodayScoreRecord()), {score: 1, questions: 1});
        const knownQ = page.locator('.reading-question[data-word="capacity"]');
        await knownQ.locator('[data-correct="true"]').click();
        await page.waitForFunction(() => document.querySelector('.reading-question[data-word="capacity"] .quiz-option').disabled);
        assert.equal(await page.evaluate(() => getWordProgress('capacity').reviews), .5);
        assert.equal(readLibrary(root).index.words.length, original.index.words.length);
        const freshWord = passage.newWords[0];
        const freshQ = page.locator(`.reading-question[data-word="${freshWord}"]`);
        await freshQ.locator('.reading-help').click();
        assert(await freshQ.locator('.quiz-option').first().textContent());
        await freshQ.locator('[data-correct="false"]').first().click();
        await page.waitForFunction(w => document.querySelector(`.reading-question[data-word="${w}"] .quiz-option`).disabled, freshWord);
        await page.waitForFunction(() => FeaturedReading.pending().length === 0);
        const written = readLibrary(root), writtenAudit = audit(written.html, written.index);
        assert.equal(writtenAudit.names.length, originalAudit.names.length + 1);
        assert(writtenAudit.names.includes(freshWord)); assert.deepEqual(writtenAudit.htmlOnly, []);
        // Every existing card's exact source bytes are retained.
        for (const card of originalAudit.cards) { const loc = card.sourceCodeLocation; assert(written.html.includes(original.html.slice(loc.startOffset, loc.endOffset))); }
        assert.equal(await page.evaluate(w => getWordProgress(w).mistakes, freshWord), 1);
        assert.deepEqual(await page.evaluate(() => getTodayScoreRecord()), {score: 2, questions: 3});
        const apiState = await (await fetch(url + '/api/reading')).json();
        const headers = {'Content-Type': 'application/json', 'X-Reading-Token': apiState.token};
        const duplicate = await (await fetch(url + '/api/words', {method: 'POST', headers, body: JSON.stringify({word: freshWord})})).json();
        assert.equal(duplicate.added, false); assert.equal(duplicate.count, written.index.words.length);
        assert.equal((await fetch(url + '/api/words', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({word: 'aquifer'})})).status, 403);
        assert.equal((await fetch(url + '/api/reading', {headers: {Origin: 'https://untrusted.example'}})).status, 403);
        assert.equal((await fetch(url + '/api/words', {method: 'POST', headers, body: JSON.stringify({word: '<script>bad</script>'})})).status, 400);
        assert.equal((await fetch(url + '/AGENTS.md')).status, 404);
        await page.locator('#readingClose').click();
        await page.locator('#searchInput').fill(freshWord);
        const added = page.locator('#wordList .word-card').filter({has: page.locator('h2', {hasText: new RegExp('^' + freshWord + '$')})});
        assert(await added.isVisible()); assert.equal(await added.locator('.mistake-count').textContent(), '1');
        await page.reload(); await page.locator('#quizSkipButton').click();
        assert.equal(await page.evaluate(w => getWordProgress(w).mistakes, freshWord), 1);
        // Render the exact answered passage again to verify replay does not award points.
        await page.evaluate(p => { window.__savedPassage = p; ReadingEngine.makeReading = () => p; }, passage);
        await page.locator('#readingTrigger').click(); await page.locator('[data-minutes="45"]').click(); await page.waitForSelector('.reading-prose');
        assert(await page.locator(`.reading-question[data-word="${freshWord}"] .quiz-option`).first().isDisabled());
        assert.deepEqual(await page.evaluate(() => getTodayScoreRecord()), {score: 2, questions: 3});
        fs.mkdirSync(path.join(PROJECT_ROOT, 'output'), {recursive: true});
        await page.screenshot({path: path.join(PROJECT_ROOT, 'output', 'reading-desktop.png')});
        await page.locator('#readingClose').click(); await page.setViewportSize({width: 390, height: 844});
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.locator('[data-minutes="5"]').click(); await page.waitForSelector('.reading-prose');
        assert(await page.evaluate(() => document.getElementById('readingDialog').getBoundingClientRect().width <= innerWidth));
        await page.screenshot({path: path.join(PROJECT_ROOT, 'output', 'reading-mobile.png')});
        await page.keyboard.press('Escape'); assert.equal(await page.locator('#readingDialog').evaluate(d => d.open), false);
        // File-mode operation preserves the file-origin learning store. Redirect only the test port.
        const filePage = await browser.newPage();
        await filePage.addInitScript(testUrl => {
            Math.random = () => .5;
            const originalFetch = window.fetch;
            window.fetch = (input, options) => originalFetch(String(input).replace('http://127.0.0.1:47831', testUrl), options);
        }, url);
        await filePage.goto(pathToFileURL(path.join(root, 'vocabulary.html')).href);
        await filePage.locator('#quizSkipButton').click(); await filePage.locator('#readingTrigger').click(); await filePage.locator('[data-minutes="5"]').click(); await filePage.waitForSelector('.reading-prose');
        assert((await filePage.locator('.reading-status').textContent()).includes('已连接'));
        // Network failure leaves a retryable queue; resuming saves a full card exactly once.
        const pendingWord = await filePage.evaluate(() => FeaturedReading.current().newWords[0]);
        await filePage.route('**/api/words', route => route.abort());
        await filePage.locator('.reading-question[data-kind="vocabulary"] [data-correct="false"]').first().click();
        await filePage.waitForFunction(() => FeaturedReading.pending().length === 1);
        await filePage.waitForFunction(() => document.querySelector('.reading-status').textContent.includes('待写入'));
        await filePage.reload(); await filePage.locator('#quizSkipButton').click();
        await filePage.locator('#readingTrigger').click(); await filePage.locator('[data-minutes="5"]').click(); await filePage.waitForSelector('.reading-prose');
        await filePage.waitForFunction(() => document.querySelector('.reading-status').textContent.includes('待写入'));
        assert(await filePage.getByRole('button', {name: '重试保存'}).isEnabled());
        await filePage.unroute('**/api/words');
        await filePage.getByRole('button', {name: '重试保存'}).click();
        await filePage.waitForFunction(() => FeaturedReading.pending().length === 0);
        assert(await filePage.getByRole('button', {name: '重试保存'}).isDisabled());
        assert(readLibrary(root).index.words.includes(pendingWord));
        // The secondary user-supplied reading is actually selectable, not just a dormant file.
        const secondary = await browser.newPage();
        await secondary.addInitScript(() => { Math.random = () => 0; });
        await secondary.goto(url); await secondary.locator('#quizSkipButton').click();
        await secondary.locator('#readingTrigger').click(); await secondary.locator('[data-minutes="5"]').click();
        await secondary.waitForSelector('.reading-prose');
        assert.equal(await secondary.evaluate(() => FeaturedReading.current().origin), 'user');
        const countBeforeCorrect = readLibrary(root).index.words.length;
        await secondary.locator('.reading-question[data-word="repository"] [data-correct="true"]').click();
        await secondary.waitForFunction(() => document.querySelector('.reading-question[data-word="repository"] .quiz-option').disabled);
        assert.equal(await secondary.evaluate(() => getWordProgress('repository').reviews), .5);
        assert.equal(readLibrary(root).index.words.length, countBeforeCorrect, 'Correct new word does not become an index-only entry');
        await secondary.locator('#readingClose').click(); await secondary.locator('[data-minutes="45"]').click();
        await secondary.waitForSelector('.reading-prose');
        await secondary.locator('.reading-question[data-word="capacity"] [data-correct="false"]').first().click();
        await secondary.waitForFunction(() => document.querySelector('.reading-question[data-word="capacity"] .quiz-option').disabled);
        assert.equal(await secondary.evaluate(() => getWordProgress('capacity').mistakes), 1);
        assert.equal(readLibrary(root).index.words.length, countBeforeCorrect, 'Known wrong word does not duplicate the card');
        // Import validates data before mutation, rejects duplicate packs, and supports input origin.
        const imported = structuredClone(require('../modules/reading/reading-supplements.json')[0]); imported.id = 'test-input-material'; imported.origin = 'input';
        const inputFile = path.join(root, 'input-pack.json'); fs.writeFileSync(inputFile, JSON.stringify(imported));
        assert.equal(importReading(inputFile, root), 1);
        const importSnapshot = fs.readFileSync(path.join(root, 'modules/reading/reading-supplements.json'), 'utf8');
        assert.throws(() => importReading(inputFile, root), /已存在/);
        imported.questions[0].options[1].correct = 'true';
        fs.writeFileSync(inputFile, JSON.stringify(imported));
        assert.throws(() => importReading(inputFile, root), /选项/);
        assert.equal(fs.readFileSync(path.join(root, 'modules/reading/reading-supplements.json'), 'utf8'), importSnapshot);
        // A pre-existing JSON-only word must block writes without deleting it.
        const valid = readLibrary(root);
        fs.writeFileSync(path.join(root, 'learned_words.json'), JSON.stringify({words: [...valid.index.words, 'unresolved']}));
        assert.throws(() => appendWord(root, bank.terms[0]), /先处理差异/);
        assert.equal(fs.readFileSync(path.join(root, 'vocabulary.html'), 'utf8'), valid.html);
        fs.writeFileSync(path.join(root, 'learned_words.json'), valid.indexText);
        // Simulated interrupted transaction is restored without losing existing cards.
        fs.writeFileSync(path.join(root, '.reading-transaction.json'), JSON.stringify(valid));
        fs.writeFileSync(path.join(root, 'vocabulary.html'), 'interrupted'); recover(root);
        assert.equal(readLibrary(root).html, valid.html);
        assert.deepEqual(errors, []);
        assert.equal(readLibrary(PROJECT_ROOT).html, original.html); assert.equal(readLibrary(PROJECT_ROOT).indexText, original.indexText);
        console.log(JSON.stringify({result: 'PASS', originalWords: originalAudit.names.length, originalWordsAfter: readLibrary(PROJECT_ROOT).index.words.length, checks: ['3 durations × 3 difficulty tiers', 'minimum coverage', 'source links', 'no repeated padding', 'anchored expanding button', 'reading score', 'known-word +0.5', 'wrong new word +1 and disk save', 'duplicate prevention', 'original cards retained', 'search new cards', 'reload and answer replay', 'file-origin API', 'offline queue and retry', 'origin/token validation', 'JSON-only protection', 'transaction recovery', 'desktop/mobile screenshots']}, null, 2));
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
