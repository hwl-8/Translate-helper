'use strict';
// Offline UI acceptance for a previously generated file; never calls a model.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {once} = require('node:events');
const {chromium} = require('playwright');
const {startServer, readLibrary, audit} = require('./reading-server.cjs');
const {parseMaterialMarkdown} = require('./reading-materials.cjs');
(async () => {
    const original = readLibrary(__dirname);
    const file = path.resolve(process.argv[2]);
    const parsed = parseMaterialMarkdown(fs.readFileSync(file, 'utf8'), audit(original.html, original.index).names.map(word => ({word})));
    const material = parsed.material;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reading-live-review-'));
    for (const name of ['vocabulary.html', 'learned_words.json', 'reading.css', 'reading-ui.js', 'reading-engine.js', 'reading-bank.js', 'reading-nasa.js', 'translation-input.js', 'translation-ui.js', 'translation.css']) fs.copyFileSync(path.join(__dirname, name), path.join(root, name));
    fs.mkdirSync(path.join(root, 'reading_materials'));
    fs.copyFileSync(file, path.join(root, 'reading_materials', path.basename(file)));
    const server = startServer({root, port: 0});
    await once(server, 'listening');
    let browser;
    try {
        const url = `http://127.0.0.1:${server.address().port}`;
        browser = await chromium.launch({channel: 'msedge', headless: true});
        const context = await browser.newContext();
        await context.route('**/*', route => route.request().url().startsWith(url) ? route.continue() : route.abort());
        const page = await context.newPage();
        await page.goto(url);
        await page.locator('#quizSkipButton').click();
        await page.locator('#readingTrigger').click();
        await page.locator(`[data-minutes="${material.metadata.minutes}"]`).click();
        await page.waitForSelector('.reading-prose');
        assert((await page.locator('#readingBody').textContent()).includes(material.metadata.title));
        await page.locator('.reading-question[data-kind="comprehension"] [data-correct="true"]').first().click();
        const word = material.questions.find(q => q.kind === 'vocabulary').word;
        await page.locator(`.reading-question[data-word="${word}"] [data-correct="false"]`).first().click();
        await page.waitForFunction(word => JSON.parse(localStorage.getItem('cet6VocabularyProgress') || '{}')[word]?.mistakes >= 1, word);
        for (let i = 0; i < 100 && !audit(readLibrary(root).html, readLibrary(root).index).names.includes(word); i++) await new Promise(resolve => setTimeout(resolve, 100));
        assert(audit(readLibrary(root).html, readLibrary(root).index).names.includes(word));
        assert.equal(readLibrary(__dirname).html, original.html);
        assert.deepEqual(readLibrary(__dirname).index, original.index);
        console.log(JSON.stringify({result: 'PASS', file: path.basename(file), checks: ['generated Markdown loads without page edits', 'comprehension answer', 'new-word mistake and transaction save', 'original library unchanged']}, null, 2));
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => {console.error(error); process.exitCode = 1;});
