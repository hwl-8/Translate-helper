'use strict';
// Real UI/server integration; every write and browser storage lives in an isolated copy.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {once} = require('node:events');
const {pathToFileURL} = require('node:url');
const {chromium} = require('playwright');
const {startServer, readLibrary, audit} = require('./reading-server.cjs');
const {createTranslationService} = require('./translation-service.cjs');
const {loadModelConfig} = require('./reading-models.cjs');

const english = 'The resilient team can adapt to a complex environment.';
const chinese = '团队具有韧性并能适应复杂环境。';
const historyKey = 'cet6TranslationHistoryV1';
const baseCard = {word:'resilient',uk:'rɪˈzɪliənt',us:'rɪˈzɪliənt',pos:'形容词',chinese:'有韧性的；能恢复的',english:'able to recover after difficulty',example:'A resilient team learns from setbacks.',translation:'有韧性的团队从挫折中学习。',uncertain:false};

(async () => {
    const protectedNames = ['vocabulary.html','learned_words.json','translation_skill.md'];
    const originals = new Map(protectedNames.map(name => [name,fs.readFileSync(path.join(__dirname,name))]));
    const root = fs.mkdtempSync(path.join(os.tmpdir(),'translation-ui-'));
    const evidence = path.join(__dirname,'output','translation-experience');
    const calls = [], external = [], errors = [], screenshots = [];
    let browser, server, failCandidates = false;
    const originalFetch = globalThis.fetch;
    try {
        // Explicit allowlist: never copy or read the real .env or usage records.
        for (const name of fs.readdirSync(__dirname)) {
            if (protectedNames.includes(name) || /^(?:reading|translation)[\w-]*\.(?:js|cjs|css|json)$/.test(name)) {
                fs.copyFileSync(path.join(__dirname,name),path.join(root,name));
            }
        }
        if (fs.existsSync(path.join(__dirname,'reading_materials'))) fs.cpSync(path.join(__dirname,'reading_materials'),path.join(root,'reading_materials'),{recursive:true});
        fs.mkdirSync(evidence,{recursive:true});
        // Defense in depth: even an accidental server-side fetch cannot reach a provider.
        globalThis.fetch = (input, options) => {
            const target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
            if (target.hostname !== '127.0.0.1' || !server || target.port !== String(server.address()?.port)) {
                external.push(target.origin); throw Error('External fetch blocked by isolated translation test');
            }
            return originalFetch(input, options);
        };
        const mockClient = {generate:async args => {
            const input = JSON.parse(args.input); calls.push(input);
            assert.equal(args.provider,'deepseek');
            if (Object.hasOwn(input,'segment')) {
                for (const key of ['direction','nextContext','previousContext','segment']) assert(Object.hasOwn(input,key));
                if (input.segments?.length > 1) return {output:{translations:input.segments.map(segment => ({index:segment.index,translation:input.direction === 'en-zh' ? chinese : english,analyses:[]}))},usage:{inputTokens:10,outputTokens:20}};
                return {output:{translation:input.direction === 'en-zh' ? chinese : english,analyses:[]},usage:{inputTokens:10,outputTokens:20}};
            }
            assert.equal(typeof input.englishText,'string');
            if (failCandidates) { failCandidates = false; throw Object.assign(Error('mock candidate failure'),{code:'rate_limit'}); }
            const evidenceText = input.englishText.match(/[^.!?]*[.!?]/)?.[0].trim() || input.englishText;
            return {output:{candidates:[
                {...baseCard,evidence:evidenceText},
                {...baseCard,word:'complex',uk:'ˈkɒmpleks',us:'kəmˈpleks',chinese:'复杂的',english:'having many connected parts',example:'A complex system needs care.',translation:'复杂的系统需要关注。',evidence:evidenceText},
                {...baseCard,word:'adapt',pos:'动词',uk:'əˈdæpt',us:'əˈdæpt',chinese:'适应；调整',english:'to change to suit new conditions',example:'The team adapted to change.',translation:'团队适应了变化。',evidence:evidenceText},
                {...baseCard,word:'environment',pos:'名词',uk:'',us:'ɪnˈvaɪrənmənt',chinese:'环境',english:'the conditions around a person or thing',example:'The environment changes.',translation:'环境会发生变化。',evidence:evidenceText}
            ]},usage:{inputTokens:10,outputTokens:20}};
        }};
        server = startServer({root,port:0,translationFactory:options => createTranslationService({...options,config:{enabled:true,modelConfig:loadModelConfig({root,env:{DEEPSEEK_API_KEY:'mock-only',MODEL_USAGE_FILE:'off'}})},client:mockClient})});
        await once(server,'ready');
        const url = `http://127.0.0.1:${server.address().port}`;
        browser = await chromium.launch({channel:'msedge',headless:true});
        const library = () => readLibrary(root);
        const initial = library();
        assert(!initial.index.words.includes('resilient') && !initial.index.words.includes('adapt'),'Fixture words must be new');
        assert(initial.index.words.includes('complex'),'Fixture known word must exist');
        const history = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)),historyKey);
        async function contextFor(width, file = false, seed) {
            const context = await browser.newContext({viewport:{width,height:900}});
            if (seed) await context.addInitScript(({key,seed})=>{if(!localStorage.getItem(key))localStorage.setItem(key,JSON.stringify(seed));},{key:historyKey,seed});
            await context.route('**/*',route => {
                const target = route.request().url();
                if (target.startsWith(url + '/') || file && target.startsWith(pathToFileURL(root + path.sep).href)) return route.continue();
                external.push(target); return route.abort();
            });
            const page = await context.newPage();
            page.on('pageerror',error => errors.push(error.message));
            page.on('dialog',dialog => dialog.accept());
            if (file) await page.addInitScript(origin => {
                const fetchOriginal = window.fetch;
                window.fetch = (input,options) => fetchOriginal(String(input).replace('http://127.0.0.1:47831',origin),options);
            },url);
            await page.goto(file ? pathToFileURL(path.join(root,'vocabulary.html')).href : url);
            await open(page);
            return {context,page};
        }
        async function open(page) {
            await page.locator('#quizSkipButton').click();
            await page.locator('#translationTrigger').click();
            await page.waitForFunction(() => !document.getElementById('translationSubmit').disabled);
            assert.equal(await page.locator('#translationSubmit').count(),1);
        }
        async function submit(page, direction = 'en-zh', text = english, expected = 'complete') {
            const previousId = await page.evaluate(() => window.TranslateHelper.current?.id);
            await page.locator('#translationDirection').selectOption(direction);
            await page.locator('#translationInput').fill(text);
            await page.locator('#translationPaid').check();
            await page.locator('#translationSubmit').click();
            await page.waitForFunction(({state,previousId}) => window.TranslateHelper.current?.id !== previousId && window.TranslateHelper.current?.state === state,{state:expected,previousId});
            assert((await page.locator('.translation-paragraph').first().innerText()).includes(direction === 'en-zh' ? chinese : english));
        }
        const candidate = (page,word) => page.locator('.translation-candidate').filter({has:page.locator('label').filter({hasText:new RegExp('^' + word + ' ·')})});
        async function screenshot(page,name) {
            const overflow = await page.locator('#translationDialog').evaluate(dialog => {
                const body = document.getElementById('translationBody');
                return {dialog:dialog.scrollWidth-dialog.clientWidth,body:body.scrollWidth-body.clientWidth,viewport:document.documentElement.scrollWidth-innerWidth};
            });
            assert(overflow.dialog <= 2 && overflow.body <= 2 && overflow.viewport <= 2,JSON.stringify(overflow));
            const target = path.join(evidence,name + '.png');
            await page.screenshot({path:target}); screenshots.push(target);
        }
        const {context,page} = await contextFor(1280);
        // UI input validation must prevent any request, not only backend reject it.
        await page.locator('#translationPaid').check();await page.locator('#translationSubmit').click();
        assert.match(await page.locator('.translation-status').innerText(),/请输入/);assert.equal(calls.length,0);
        await page.locator('#translationInput').fill('😀'.repeat(10001));await page.locator('#translationPaid').check();await page.locator('#translationSubmit').click();
        assert.match(await page.locator('.translation-status').innerText(),/10000/);assert.equal(calls.length,0);
        await submit(page);
        assert.equal(calls.length,2);
        assert.deepEqual(library(),initial,'Translation/preview must not write vocabulary');
        assert.equal(await page.locator('.translation-candidate').count(),4);
        assert(await candidate(page,'complex').locator('input').first().isDisabled());
        assert.match(await candidate(page,'complex').innerText(),/已(?:在|存在于)正式词库/);
        assert(await candidate(page,'environment').locator('input').first().isDisabled());
        assert((await candidate(page,'environment').innerText()).includes('音标'));
        assert(await candidate(page,'adapt').locator('input').last().isEnabled());
        assert.match(await candidate(page,'adapt').locator('.translation-card-warning').innerText(),/仅作警示/);
        assert.equal(await candidate(page,'adapt').locator('.translation-error').count(),0);
        await candidate(page,'resilient').locator('summary').click();
        const cardText = await candidate(page,'resilient').innerText();
        for (const field of ['rɪˈzɪliənt','able to recover after difficulty',baseCard.example,english,'有韧性的']) assert(cardText.includes(field),field);
        await candidate(page,'resilient').locator('input').first().check();
        assert(await page.locator('#translationImport').isDisabled(),'Selected but unreviewed cannot save');
        await candidate(page,'resilient').locator('input').last().check();
        assert(await page.locator('#translationImport').isEnabled());
        assert.equal(calls.length,2,'Review and selection cannot call model');
        await screenshot(page,'desktop-1280-reviewed');
        await page.reload(); await open(page);
        assert(await candidate(page,'resilient').locator('input').first().isChecked());
        assert(await candidate(page,'resilient').locator('input').last().isChecked());
        assert(await candidate(page,'resilient').locator('details').evaluate(node => node.open));
        const saveResponse = page.waitForResponse(response => response.url() === url + '/api/translation/words' && response.request().method() === 'POST');
        await page.locator('#translationImport').click();
        const save = await (await saveResponse).json();
        assert.equal(save.results[0].status,'added',JSON.stringify(save));
        await page.waitForFunction(() => document.querySelector('.translation-status').textContent.includes('词库已同步'));
        assert.equal(calls.length,2,'Explicit save cannot call model');
        assert(await page.locator('#translationImport').isDisabled());
        assert.equal(await page.locator('#translationImport').count(),1);
        assert.equal(await page.locator('#wordList .word-header h2').filter({hasText:/^resilient$/}).count(),1);
        const saved = library();
        assert.equal(saved.index.words.filter(word => word === 'resilient').length,1);
        assert(!saved.index.words.includes('adapt'),'Unchecked candidate must stay outside library');
        assert(!saved.index.words.includes('environment'),'Invalid candidate must stay outside library');
        assert.equal(audit(saved.html,saved.index).names.length,initial.index.words.length+1);
        await submit(page,'zh-en','团队能够适应复杂环境。');
        assert.equal(calls.length,4);
        assert.equal(calls.at(-1).englishText,english,'Chinese direction extracts from English translation');
        assert(await candidate(page,'resilient').locator('input').first().isDisabled());
        assert.equal(library().index.words.filter(word => word === 'resilient').length,1);
        // The server accepted a job but its HTTP response was lost: reuse the id.
        let lost = false;
        await page.route('**/api/translation/jobs',async route=>{
            if(!lost && route.request().method()==='POST'){lost=true;await route.fetch();await route.abort();}else await route.continue();
        });
        await page.locator('#translationInput').fill(english+' Lost response.');await page.locator('#translationPaid').check();await page.locator('#translationSubmit').click();
        await page.waitForFunction(()=>document.querySelector('.translation-status').textContent.includes('同一请求标识'));
        const lostCalls=calls.length;
        await page.locator('#translationPaid').check();await page.locator('#translationSubmit').click();
        await page.waitForFunction(()=>TranslateHelper.current?.input.text.includes('Lost response.') && TranslateHelper.current.state==='complete');
        assert.equal(calls.length,lostCalls,'Lost response retry must not repeat paid work');await page.unroute('**/api/translation/jobs');
        await submit(page,'en-zh','resilient');
        assert.equal(await page.locator('.translation-paragraph').count(),1);
        const longInput=require('./translation-live-samples.cjs').at(-1).text;
        await submit(page,'en-zh',longInput);
        assert.equal(await page.locator('.translation-paragraph').count(),17);
        assert(await page.evaluate(()=>TranslateHelper.current.paragraphs.every(p=>p.status==='complete' && p.translation)));
        failCandidates = true;
        await submit(page,'en-zh',english + ' Retry case.','partial');
        const partialCalls=calls.length;
        assert(await page.locator('#translationRetry').isVisible());
        await screenshot(page,'desktop-1280-partial');
        await page.locator('#translationPaid').check();
        await page.locator('#translationRetry').click();
        await page.waitForFunction(() => TranslateHelper.current?.state === 'complete');
        assert.equal(calls.length,partialCalls+1);
        assert(Object.hasOwn(calls.at(-1),'englishText'),'Retry must only call candidate extraction');
        for (let index=0; index<9; index++) await submit(page,'en-zh',english + ` History ${index}.`);
        assert.equal((await history(page)).history.length,10);
        assert.equal(await page.locator('.translation-history-row').count(),10);
        assert(!(await history(page)).history.some(entry => entry.input.text === english),'Oldest history must be evicted');
        const beforeSelect = calls.length;
        await page.locator('.translation-history-row').last().locator('button').first().click();
        const selectedId = (await history(page)).currentId;
        await page.reload(); await open(page);
        assert.equal((await history(page)).currentId,selectedId);
        assert.equal(calls.length,beforeSelect,'History selection/reload must not call model');
        const learning = await page.evaluate(() => Object.fromEntries(['cet6VocabularyProgress','cet6VocabularyDailyScores','cet6FeaturedReadingV1'].map(key => [key,localStorage.getItem(key)])));
        await page.locator('.translation-history-row').first().locator('button').last().click();
        assert.equal((await history(page)).history.length,9);
        await page.getByRole('button',{name:'清空历史',exact:true}).click();
        assert.equal((await history(page)).history.length,0);
        assert.deepEqual(await page.evaluate(keys => Object.fromEntries(keys.map(key => [key,localStorage.getItem(key)])),Object.keys(learning)),learning);
        await context.close();
        for (const file of [false,true]) {
            const mobile = await contextFor(390,file);
            const before = calls.length;
            await submit(mobile.page,file ? 'zh-en' : 'en-zh',file ? chinese : english);
            assert.equal(calls.length,before+2);
            await candidate(mobile.page,'adapt').locator('summary').click();
            assert((await candidate(mobile.page,'adapt').innerText()).includes('The team adapted to change.'));
            await screenshot(mobile.page,file ? 'file-origin-390' : 'narrow-390');
            await mobile.context.close();
        }
        assert.equal(library().index.words.length,initial.index.words.length+1,'No preview/history operation may save another word');
        // Saved pre-change failures are reclassified locally, without another paid task.
        const legacyCard={...baseCard,word:'adapt',pos:'动词',uk:'əˈdæpt',us:'əˈdæpt',chinese:'适应；调整',english:'to change to suit new conditions',example:'The team adapted to change.',translation:'团队适应了变化。',evidence:english};
        const legacy={id:'legacy-example-warning',direction:'en-zh',model:'deepseek-flash',state:'complete',stage:'candidates',input:{text:english},paragraphs:[],candidates:[{card:legacyCard,valid:false,exists:false,issues:['例句需包含词卡的原形词名；当前例句可能仅用了变形。']},{card:{...legacyCard,word:'environment',uk:'',evidence:english},valid:false,exists:false,issues:['例句需包含词卡的原形词名；当前例句可能仅用了变形。']}],selected:{},reviewed:{},viewed:{},expanded:{}};
        const beforeLegacyCalls=calls.length;
        const legacyBrowser=await contextFor(1280,false,{history:[legacy],currentId:legacy.id});
        await legacyBrowser.page.waitForFunction(()=>TranslateHelper.current?.candidates[0].valid);
        assert(await candidate(legacyBrowser.page,'adapt').locator('input').last().isEnabled());
        assert(await candidate(legacyBrowser.page,'environment').locator('input').last().isDisabled());
        assert.match(await candidate(legacyBrowser.page,'adapt').locator('.translation-card-warning').innerText(),/原形词名/);
        await candidate(legacyBrowser.page,'adapt').locator('summary').click();
        await candidate(legacyBrowser.page,'adapt').locator('input').first().check();
        await candidate(legacyBrowser.page,'adapt').locator('input').last().check();
        await screenshot(legacyBrowser.page,'example-yellow-warning-1280');
        await legacyBrowser.page.locator('#translationImport').click();
        await legacyBrowser.page.waitForFunction(()=>document.querySelector('.translation-status').textContent.includes('词库已同步'));
        assert.equal(library().index.words.filter(word=>word==='adapt').length,1);
        await legacyBrowser.page.reload();await open(legacyBrowser.page);
        assert(await candidate(legacyBrowser.page,'adapt').locator('input').last().isDisabled(),'Saved words remain non-duplicable after reload');
        assert.equal(calls.length,beforeLegacyCalls,'History validation, warning review and saving cannot call a model');
        await legacyBrowser.context.close();
        assert.deepEqual(external,[]); assert.deepEqual(errors,[]);
        console.log(JSON.stringify({result:'PASS',modelCalls:calls.length,screenshots,checks:['actual server and mocked DeepSeek','review gates; explicit save; known/invalid/unchecked candidates','no model calls on review/save/history','two directions; candidate-only retry','history reload/selection/10-entry limit/delete/clear','desktop/mobile overflow and visible card text','file origin; blocked external requests; formal bytes unchanged']},null,2));
    } finally {
        globalThis.fetch = originalFetch;
        await browser?.close();
        if (server) await new Promise(resolve => {server.close(resolve); server.closeAllConnections();});
        for (const [name,bytes] of originals) assert.deepEqual(fs.readFileSync(path.join(__dirname,name)),bytes,`Formal ${name} changed during isolated test`);
        fs.rmSync(root,{recursive:true,force:true});
    }
})().catch(error => {console.error(error);process.exitCode=1;});
