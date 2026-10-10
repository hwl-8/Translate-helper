'use strict';
const {PROJECT_ROOT} = require('../server/project-paths.cjs');
// Offline evidence only. Intentionally excluded from npm's mock regression suite.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {once} = require('node:events');
const {chromium} = require('playwright');
const {startServer} = require('../server/reading-server.cjs');
const {createTranslationService} = require('../modules/translation/translation-service.cjs');
const {loadModelConfig} = require('../server/reading-models.cjs');
const {normalizeInput} = require('../modules/translation/translation-input.js');

async function main() {
    const source = PROJECT_ROOT;
    const reportName = 'output/翻译真实验收-2026-10-10.json';
    const protectedNames = ['vocabulary.html', 'learned_words.json', 'translation_skill.md', reportName, 'tools/translation-live-samples.cjs'];
    const originals = new Map(protectedNames.map(name => [name, fs.readFileSync(path.join(source, name))]));
    const report = JSON.parse(originals.get(reportName).toString('utf8'));
    const samples = require('./translation-live-samples.cjs');
    assert.equal(report.mode, 'live');
    assert.equal(report.provider, 'deepseek');
    // Only these small cases contain full translations in the acceptance report.
    const entries = ['word', 'sentence'].map(name => {
        const actual = report.results.find(result => result.sample === name);
        const sample = samples.find(item => item.name === name);
        assert(actual && sample, `Missing actual result/input: ${name}`);
        assert.equal(actual.state, 'complete');
        assert.equal(actual.direction, sample.direction);
        assert.equal(Array.from(sample.text).length, actual.characters);
        const input = normalizeInput({type: 'text', text: sample.text});
        assert.equal(input.paragraphs.length, actual.paragraphs.length);
        const paragraphs = actual.paragraphs.map((paragraph, index) => {
            assert.equal(paragraph.status, 'complete');
            assert.equal(Array.from(input.paragraphs[index]).length, paragraph.characters);
            assert.equal(typeof paragraph.translationPreview, 'string');
            assert.equal(Array.from(paragraph.translationPreview).length, paragraph.translationCharacters,
                `Refusing to replay truncated translation: ${name}/${index}`);
            return {original: input.paragraphs[index], translation: paragraph.translationPreview,
                status: paragraph.status, analyses: paragraph.analyses || []};
        });
        return {id: `live-replay-${name}`, requestId: `offline-${name}`, input: {type: 'text', text: sample.text},
            direction: sample.direction, model: report.model, state: actual.state, stage: actual.stage,
            paragraphs, candidates: structuredClone(actual.candidates).map(candidate => ({...candidate, model: true})),
            error: actual.error, warnings: actual.warnings || [], usage: actual.usage,
            createdAt: `${report.date}T00:00:00.000Z`, selected: {}, reviewed: {}, expanded: {}, viewed: {}, reviewAll: false};
    });
    const tempParent = path.resolve(os.tmpdir());
    const root = fs.mkdtempSync(path.join(tempParent, 'translation-live-replay-'));
    const output = path.join(source, 'output', 'translation-experience');
    const screenshots = [], blocked = [], errors = [], mutations = [];
    let server, browser, modelCalls = 0;
    const originalFetch = globalThis.fetch;
    try {
        // Fixed allowlist: never inspect or copy .env, budgets, logs or user browser state.
        const assets = ['vocabulary.html', 'learned_words.json', 'translation_skill.md',
            'modules/reading/reading.css', 'modules/reading/reading-ui.js', 'modules/reading/reading-engine.js', 'modules/reading/reading-bank.js', 'modules/reading/reading-nasa.js',
            'modules/reading/reading-supplements.json', 'modules/translation/translation.css', 'modules/translation/translation-ui.js', 'modules/translation/translation-input.js'];
        for (const name of assets) { fs.mkdirSync(path.dirname(path.join(root, name)), {recursive: true}); fs.copyFileSync(path.join(source, name), path.join(root, name)); }
        assert(!fs.existsSync(path.join(root, '.env')));
        const tempOriginals = new Map(assets.map(name => [name, fs.readFileSync(path.join(root, name))]));
        globalThis.fetch = () => { blocked.push('server fetch'); throw Error('Offline replay forbids network fetch'); };
        const client = {generate: async () => { modelCalls++; throw Error('mustnotcall'); }};
        server = startServer({root, port: 0, translationFactory: options => createTranslationService({...options,
            config: {enabled: true, modelConfig: loadModelConfig({root, env: {
                DEEPSEEK_API_KEY: 'offline-replay-never-used', DEEPSEEK_MODELS: report.model,
                DEEPSEEK_DEFAULT_MODEL: report.model, MODEL_USAGE_FILE: 'off'}})}, client})});
        await once(server, 'ready');
        const origin = `http://127.0.0.1:${server.address().port}`;
        fs.mkdirSync(output, {recursive: true});
        browser = await chromium.launch({channel: 'msedge', headless: true});
        for (const entry of entries) for (const width of [1280, 390]) {
            const context = await browser.newContext({viewport: {width, height: 1000}, serviceWorkers: 'block'});
            try {
                await context.route('**/*', route => {
                    const req = route.request();
                    if (new URL(req.url()).origin !== origin) { blocked.push(req.url()); return route.abort(); }
                    if (req.method() !== 'GET') { mutations.push(req.url()); return route.abort(); }
                    return route.continue();
                });
                // Exactly one initialization for this fresh browser context.
                await context.addInitScript(({entry, storageKey}) => {
                    localStorage.setItem(storageKey, JSON.stringify({history: [entry], currentId: entry.id,
                        draft: {text: entry.input.text, direction: entry.direction, model: entry.model}}));
                }, {entry, storageKey: 'cet6TranslationHistoryV1'});
                const page = await context.newPage();
                page.on('pageerror', error => errors.push(error.message));
                await page.goto(origin, {waitUntil: 'networkidle'});
                await page.locator('#quizSkipButton').click();
                const learning = await page.evaluate(() => Object.fromEntries(
                    ['cet6VocabularyProgress', 'cet6VocabularyDailyScores', 'cet6FeaturedReadingV1'].map(key => [key, localStorage.getItem(key)])));
                await page.locator('#translationTrigger').click();
                await page.waitForFunction(() => !document.getElementById('translationSubmit').disabled);
                assert.equal(await page.evaluate(() => TranslateHelper.current.id), entry.id);
                const visibleTranslation = await page.locator('.translation-pair > div').nth(1).locator('p').innerText();
                assert.equal(visibleTranslation, entry.paragraphs[0].translation);
                await page.evaluate(() => {
                    const note = document.createElement('small');
                    note.textContent = '真实接口结果回放（无新增调用）';
                    note.style.display = 'block'; note.style.letterSpacing = 'normal';
                    document.querySelector('.translation-topbar h2').after(note);
                });
                const details = entry.paragraphs.some(p => p.analyses.length)
                    ? page.locator('.translation-paragraph details').first()
                    : page.locator('.translation-candidate details').first();
                if (await details.count()) await details.locator('summary').click();
                await page.locator('#translationResults').evaluate(results => {
                    const dialog = document.getElementById('translationDialog');
                    const header = dialog.querySelector('.translation-topbar');
                    dialog.scrollTop += results.getBoundingClientRect().top - dialog.getBoundingClientRect().top - header.offsetHeight - 12;
                });
                await page.evaluate(() => document.fonts.ready);
                const overflow = await page.locator('#translationDialog').evaluate(d => d.scrollWidth - d.clientWidth);
                assert(overflow <= 2, `Horizontal overflow at ${width}: ${overflow}`);
                assert.equal(await page.locator('.translation-candidate input:checked').count(), 0);
                assert(await page.locator('#translationImport').isDisabled());
                assert.deepEqual(await page.evaluate(keys => Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)])), Object.keys(learning)), learning);
                const target = path.join(output, `live-replay-${entry.id.replace('live-replay-', '')}-${width}.png`);
                // Keep existing evidence recoverable if this utility is run again.
                assert(!fs.existsSync(target), `Evidence already exists; refusing overwrite: ${target}`);
                await page.screenshot({path: target}); screenshots.push(target);
            } finally { await context.close(); }
        }
        assert.equal(modelCalls, 0);
        assert.deepEqual(blocked, []);
        assert.deepEqual(mutations, []);
        assert.deepEqual(errors, []);
        for (const [name, bytes] of tempOriginals) assert.deepEqual(fs.readFileSync(path.join(root, name)), bytes, `Temporary asset changed: ${name}`);
        console.log(JSON.stringify({result: 'PASS', mode: 'actual-result-offline-replay', newModelCalls: modelCalls,
            priorLiveCalls: report.budget.calls, priorReservedCny: report.budget.reservedCny,
            screenshots, checks: ['full recorded translations verified', 'actual UI and local server',
                'fresh browser histories', 'no imports or learning changes', 'formal files unchanged']}, null, 2));
    } finally {
        try {
            await browser?.close();
            if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
        } finally {
            globalThis.fetch = originalFetch;
            // Resolve and validate the exact mkdtemp target before recursive removal.
            const target = path.resolve(root);
            assert.equal(path.dirname(target), tempParent);
            assert(path.basename(target).startsWith('translation-live-replay-'));
            fs.rmSync(target, {recursive: true, force: true});
            for (const [name, bytes] of originals) assert.deepEqual(fs.readFileSync(path.join(source, name)), bytes, `Formal file changed: ${name}`);
        }
    }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = {main};
