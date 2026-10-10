'use strict';
const {PROJECT_ROOT, copyProjectFiles} = require('./helpers.cjs');
// Real local inventory, isolated browser and copied library; never use the private .env.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const {once} = require('node:events');
const {pathToFileURL} = require('node:url');
const {chromium} = require('playwright');
const {startServer, readLibrary, audit} = require('../server/reading-server.cjs');
const {parseMaterialMarkdown, renderMaterialMarkdown} = require('../modules/reading/reading-materials.cjs');

(async () => {
    const original = readLibrary(PROJECT_ROOT);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reading-experience-'));
    copyProjectFiles(root);
    fs.cpSync(path.join(PROJECT_ROOT, 'reading_materials'), path.join(root, 'reading_materials'), {recursive: true});
    fs.writeFileSync(path.join(root, '.env'), 'READING_ALLOW_EXTERNAL_CALLS=true\nTAVILY_API_KEY=mock-only\nDEEPSEEK_API_KEY=mock-only\n');
    let generationCalls = 0;
    const server = startServer({root, port: 0, generatorFactory: () => ({generate: async () => {
        generationCalls++;
        const cards = audit(original.html, original.index).names.map(word => ({word}));
        const material = parseMaterialMarkdown(fs.readFileSync(path.join(root, 'reading_materials', 'docker-user-v1-0.md'), 'utf8'), cards).material;
        Object.assign(material.metadata, {id:'experience-generated', title:'A Shared Environment for a School Project', creationMethod:'model_generated', reviewStatus:'pending'});
        material.article[0].text = 'A school team wants a reliable program for sharing course material. Its complex environment combines several services. Students must integrate these tools and accelerate repeated checks before inviting classmates to use their work. This hypothetical project illustrates why sharing a software environment can be useful.';
        fs.writeFileSync(path.join(root, 'reading_materials', 'experience-generated.md'), renderMaterialMarkdown(material, cards));
        return {files:['experience-generated.md'], usage:{cost:{totalUsd:0}}, sources:[], skippedSources:[]};
    }})});
    await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}`;
    let browser;
    const evidence = path.join(PROJECT_ROOT, 'output', 'reading-experience'); fs.mkdirSync(evidence, {recursive: true});
    const report = [], external = [], errors = [];
    try {
        browser = await chromium.launch({channel: 'msedge', headless: true});
        for (const width of [390, 1280]) {
            const context = await browser.newContext({viewport: {width, height: 900}});
            await context.route('**/*', route => { if (!route.request().url().startsWith(url)) { external.push(route.request().url()); return route.abort(); } return route.continue(); });
            const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
            await page.goto(url); await page.locator('#quizSkipButton').click();
            await page.locator('#readingTrigger').click();
            for (const minutes of [5, 20, 45]) {
                await page.locator(`[data-minutes="${minutes}"]`).click(); await page.waitForSelector('.reading-prose');
                const article = await page.evaluate(() => FeaturedReading.current());
                assert(article.knownWords.length >= 4 && article.newWords.length >= 2);
                assert.equal(article.minutes, minutes);
                assert(await page.locator('.reading-prose').evaluate(el => getComputedStyle(el).fontSize === '17px' || getComputedStyle(el).fontSize === '18px'));
                await page.screenshot({path: path.join(evidence, `${process.env.READING_BASELINE ? 'before' : 'after'}-${width}-${minutes}.png`)});
                report.push({width, minutes, id: article.id, title: article.title, words: article.wordCount, known: article.knownWords.length, fresh: article.newWords.length});
                await page.locator('.reading-question[data-kind="comprehension"] [data-correct="true"]').first().click();
                await page.waitForFunction(() => document.querySelector('#readingBody .reading-question[data-kind="comprehension"] .quiz-option').disabled);
                await page.screenshot({path:path.join(evidence, `questions-${width}-${minutes}.png`)});
                const score = await page.evaluate(() => getTodayScoreRecord());
                const next = page.getByRole('button', {name: '换一组阅读', exact: true});
                if (await next.isEnabled()) await next.click();
                else assert((await page.locator('#readingBody').textContent()).includes('1 篇不同正文可读'));
                await page.waitForSelector('.reading-prose');
                report.at(-1).next = await page.evaluate(() => FeaturedReading.current().id);
                report.at(-1).score = score;
                await page.locator('#readingClose').click();
            }
            assert.equal(generationCalls, 0, 'Local reading must never generate');
            if (width === 1280) {
                await page.locator('[data-minutes="5"]').click(); await page.waitForSelector('#readingBody .reading-prose');
                await page.getByRole('button', {name:'补充资料 / 审核', exact:true}).click();
                await page.getByLabel('英文检索词', {exact:false}).fill('learning with shared software');
                await page.locator('.reading-generation-confirm input').check();
                await page.getByRole('button', {name:'检索并生成', exact:true}).click();
                await page.waitForFunction(() => document.querySelector('.reading-generation-status').textContent.includes('已保存 1 篇待人工审核'));
                const catalog = await (await fetch(url + '/api/reading')).json();
                assert(!catalog.materials.some(p => p.id === 'experience-generated'));
                const item = page.locator('.reading-review-item').filter({has:page.locator('summary', {hasText:'A Shared Environment for a School Project'})});
                await item.locator('summary').click();
                const beforePreview = await page.evaluate(() => JSON.stringify({progress, dailyScores}));
                await item.getByRole('button', {name:'审核通过', exact:true}).click();
                assert((await item.textContent()).includes('请先逐项核对'));
                assert.equal(await page.evaluate(() => JSON.stringify({progress, dailyScores})), beforePreview);
                await item.locator('.reading-review-confirm input').check();
                await item.getByRole('button', {name:'审核通过', exact:true}).click();
                await item.getByRole('button', {name:'阅读这篇', exact:true}).waitFor();
                await page.screenshot({path:path.join(evidence, 'review-approved.png')});
                await item.getByRole('button', {name:'阅读这篇', exact:true}).click();
                await page.waitForFunction(() => FeaturedReading.current()?.id === 'experience-generated');
                assert.equal(await page.evaluate(() => FeaturedReading.current().id), 'experience-generated');
                // Interrupt the second learning-store write after the answer journal is durable.
                await page.evaluate(() => {
                    const originalSet = Storage.prototype.setItem;
                    Storage.prototype.setItem = function(key, value) {
                        if (key === 'cet6VocabularyDailyScores') throw Error('simulated storage failure');
                        return originalSet.call(this, key, value);
                    };
                });
                await page.locator('#readingBody .reading-question[data-kind="comprehension"] [data-correct="true"]').click();
                await page.waitForFunction(() => JSON.parse(localStorage.getItem('cet6FeaturedReadingV1')).answerJournal);
                const scoreBeforeReload = await page.evaluate(() => JSON.parse(localStorage.getItem('cet6FeaturedReadingV1')).answerJournal.daily);
                await page.reload(); await page.locator('#quizSkipButton').click();
                assert.deepEqual(await page.evaluate(() => getTodayScoreRecord()), scoreBeforeReload);
                await page.reload(); await page.locator('#quizSkipButton').click();
                assert.deepEqual(await page.evaluate(() => getTodayScoreRecord()), scoreBeforeReload, 'Recovery cannot double-count');
                // Renaming the same prose cannot create a fresh scored attempt.
                const renamed = fs.readFileSync(path.join(root, 'reading_materials', 'experience-generated.md'), 'utf8').replace('"id": "experience-generated"', '"id": "experience-renamed"');
                fs.writeFileSync(path.join(root, 'reading_materials', 'experience-renamed.md'), renamed);
                await page.locator('#readingTrigger').click(); await page.locator('[data-minutes="5"]').click(); await page.waitForSelector('#readingBody .reading-prose');
                await page.getByRole('button', {name:'补充资料 / 审核',exact:true}).click();
                await page.locator('.reading-review > summary').click();
                const renamedItem = page.locator('.reading-review-item').filter({has:page.locator('summary', {hasText:'A Shared Environment for a School Project'})}).last();
                await renamedItem.locator('summary').click(); await renamedItem.locator('.reading-review-confirm input').check();
                await renamedItem.getByRole('button',{name:'审核通过',exact:true}).click();
                await renamedItem.getByRole('button',{name:'阅读这篇',exact:true}).click();
                await page.waitForFunction(() => FeaturedReading.current()?.id === 'experience-renamed');
                assert(await page.locator('#readingBody .reading-question[data-kind="comprehension"] .quiz-option').first().isDisabled());
                assert.deepEqual(await page.evaluate(()=>getTodayScoreRecord()), scoreBeforeReload);
                fs.unlinkSync(path.join(root,'reading_materials','experience-renamed.md'));
                assert.equal(generationCalls, 1);
            }
            await context.close();
        }
        // The actual launcher opens file://, whose Origin is null, not the HTTP origin.
        const fileContext = await browser.newContext();
        await fileContext.route('**/*', route => {
            if (!route.request().url().startsWith(url) && !route.request().url().startsWith('file:')) { external.push(route.request().url()); return route.abort(); }
            return route.continue();
        });
        const filePage = await fileContext.newPage();
        await filePage.addInitScript(testUrl => {
            const originalFetch = window.fetch;
            window.fetch = (input, options) => originalFetch(String(input).replace('http://127.0.0.1:47831', testUrl), options);
        }, url);
        await filePage.goto(pathToFileURL(path.join(root,'vocabulary.html')).href);
        await filePage.locator('#quizSkipButton').click(); await filePage.locator('#readingTrigger').click();
        await filePage.locator('[data-minutes="5"]').click(); await filePage.waitForSelector('#readingBody .reading-prose');
        await filePage.getByRole('button', {name:'补充资料 / 审核', exact:true}).click();
        await filePage.locator('.reading-review > summary').click();
        const reviewed = filePage.locator('.reading-review-item').filter({has:filePage.locator('summary', {hasText:'A Shared Environment for a School Project'})});
        await reviewed.locator('summary').click(); await reviewed.locator('.reading-review-confirm input').check();
        await reviewed.getByRole('button',{name:'审核不通过',exact:true}).click();
        await filePage.waitForFunction(() => [...document.querySelectorAll('.reading-review-status')].some(n => n.textContent.includes('状态已保存')));
        assert(!(await (await fetch(url+'/api/reading')).json()).materials.some(p=>p.id==='experience-generated'));
        assert.deepEqual(await filePage.evaluate(()=>getTodayScoreRecord()), {score:0,questions:0}, 'Preview/review must not score');
        await fileContext.close();
        assert.deepEqual(external, []); assert.deepEqual(errors, []);
        fs.writeFileSync(path.join(evidence, `${process.env.READING_BASELINE ? 'before' : 'after'}.json`), JSON.stringify(report, null, 2));
        console.log(JSON.stringify({result: 'PASS', report}, null, 2));
    } finally {
        await browser?.close(); await new Promise(resolve => {server.close(resolve); server.closeAllConnections();});
        assert.equal(readLibrary(PROJECT_ROOT).html, original.html); assert.equal(readLibrary(PROJECT_ROOT).indexText, original.indexText);
        fs.rmSync(root, {recursive: true, force: true});
    }
})().catch(error => {console.error(error); process.exitCode = 1;});
