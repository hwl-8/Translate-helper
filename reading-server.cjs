'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const parse5 = require('parse5');
const bank = require('./reading-bank.js');
const engine = require('./reading-engine.js');
const {loadModelConfig, publicModelConfig} = require('./reading-models.cjs');
const {loadSearchConfig, publicSearchConfig} = require('./reading-search.cjs');
const {scanMaterialDirectory} = require('./reading-materials.cjs');
const {executeRetentionCleanup} = require('./reading-retention.cjs');
const {scanReviews, reviewMaterial, failure} = require('./reading-review.cjs');
const {createTranslationService, validateTranslationCard, evaluateCandidates} = require('./translation-service.cjs');

function openVocabulary(filename, {spawn = require('node:child_process').spawn} = {}) {
    // An encoded, fixed command keeps Chinese paths and shell metacharacters out of PowerShell source.
    const command = "$ErrorActionPreference = 'Stop'; try { $startInfo = New-Object System.Diagnostics.ProcessStartInfo; $startInfo.FileName = $env:TRANSLATE_HELPER_PAGE; $startInfo.UseShellExecute = $true; [System.Diagnostics.Process]::Start($startInfo) | Out-Null; exit 0 } catch { exit 1 }";
    return new Promise(resolve => {
        const child = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
            stdio: 'ignore', windowsHide: true,
            env: {...process.env, TRANSLATE_HELPER_PAGE: path.resolve(filename)},
            timeout: 15000
        });
        const fail = () => { console.error('自动打开页面失败，请手动打开 vocabulary.html；词库服务仍在运行。'); resolve(false); };
        child.once('error', fail);
        child.once('exit', code => { if (code === 0) resolve(true); else fail(); });
    });
}

const attr = (node, name) => node.attrs?.find(a => a.name === name)?.value;
const hasClass = (node, name) => (attr(node, 'class') || '').split(/\s+/).includes(name);
const children = node => node.childNodes || [];
function findAll(node, predicate) { return [...(predicate(node) ? [node] : []), ...children(node).flatMap(n => findAll(n, predicate))]; }
const text = node => node.nodeName === '#text' ? node.value : children(node).map(text).join('');
function audit(html, index) {
    const doc = parse5.parse(html, {sourceCodeLocationInfo: true});
    const lists = findAll(doc, n => attr(n, 'id') === 'wordList');
    if (lists.length !== 1 || !lists[0].sourceCodeLocation?.endTag) throw Error('正式词卡区域结构异常');
    const cards = findAll(lists[0], n => hasClass(n, 'word-card'));
    const names = cards.map(card => {
        const headers = findAll(card, n => hasClass(n, 'word-header'));
        const headings = headers.flatMap(header => findAll(header, n => n.tagName === 'h2'));
        if (headings.length !== 1) throw Error('词卡标题结构异常');
        return engine.normalize(text(headings[0]));
    });
    if (names.some(n => !n) || new Set(names).size !== names.length) throw Error('HTML 含空词名或重复词卡，请先人工核对');
    if (!index || !Array.isArray(index.words) || index.words.some(w => typeof w !== 'string' || !w || w !== engine.normalize(w)) || new Set(index.words).size !== index.words.length) throw Error('索引格式异常');
    const htmlOnly = names.filter(w => !index.words.includes(w)), jsonOnly = index.words.filter(w => !names.includes(w));
    if (jsonOnly.length) throw Error('索引存在无正式词卡的词，先处理差异：' + jsonOnly.join(', '));
    return {names, htmlOnly, jsonOnly, cards, list: lists[0], insertion: lists[0].sourceCodeLocation.endTag.startOffset};
}
const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
function cardHTML(term, {kind = 'reading'} = {}) {
    if (kind === 'translation') term = validateTranslationCard(term);
    else engine.validateTerm(term);
    const t = Object.fromEntries(Object.entries(term).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, escape(v)]));
    const label = kind === 'translation' ? '翻译学习词' : '阅读错词';
    const provenance = kind === 'translation'
        ? '翻译提取的 DeepSeek 模型学习草稿，经用户核对确认；非词典引文，例句自编。考试级别未核定。'
        : `精选短文词义题错词。释义为学习用改写，例句自编；<a href="${t.source}">释义与读音参考</a>。考试级别未核定。`;
    return `<div class="word-card">
    <div class="word-header"><h2>${t.word}</h2><span class="level">${label}</span></div>
    <p class="pronunciation">英 /${t.uk}/ 美 /${t.us}/</p>
    <p class="word-info"><strong>词性：</strong>${t.pos}</p>
    <p class="meaning"><strong>释义：</strong>${t.chinese}</p>
    <p class="english-meaning"><strong>英文解释：</strong>${t.english}</p>
    <p class="example"><strong>例句：</strong>${t.example}</p>
    <p class="translation">中文：${t.translation}</p>
    <p class="translation">${provenance}</p>
</div>\n\n`;
}
function readLibrary(root) {
    const html = fs.readFileSync(path.join(root, 'vocabulary.html'), 'utf8');
    const indexText = fs.readFileSync(path.join(root, 'learned_words.json'), 'utf8');
    return {html, indexText, index: JSON.parse(indexText)};
}
function recover(root) {
    const journal = path.join(root, '.reading-transaction.json');
    if (!fs.existsSync(journal)) return;
    const saved = JSON.parse(fs.readFileSync(journal, 'utf8'));
    audit(saved.html, JSON.parse(saved.indexText));
    fs.writeFileSync(path.join(root, 'vocabulary.html'), saved.html);
    fs.writeFileSync(path.join(root, 'learned_words.json'), saved.indexText);
    fs.unlinkSync(journal);
}
function appendWord(root, term, options) {
    const before = readLibrary(root), check = audit(before.html, before.index);
    let html = before.html, card;
    const exists = check.names.includes(term.word);
    if (!exists) {
        card = cardHTML(term, options);
        html = before.html.slice(0, check.insertion) + card + before.html.slice(check.insertion);
    } else {
        const n = check.cards[check.names.indexOf(term.word)].sourceCodeLocation;
        card = html.slice(n.startOffset, n.endOffset);
    }
    const after = audit(html, before.index);
    const words = [...before.index.words, ...after.names.filter(w => !before.index.words.includes(w))];
    const nextIndex = JSON.stringify({...before.index, words}, null, 2) + '\n';
    const journal = path.join(root, '.reading-transaction.json');
    fs.writeFileSync(journal, JSON.stringify({html: before.html, indexText: before.indexText}), {flag: 'wx'});
    try {
        fs.writeFileSync(path.join(root, 'vocabulary.html.reading-tmp'), html);
        fs.writeFileSync(path.join(root, 'learned_words.json.reading-tmp'), nextIndex);
        fs.renameSync(path.join(root, 'vocabulary.html.reading-tmp'), path.join(root, 'vocabulary.html'));
        fs.renameSync(path.join(root, 'learned_words.json.reading-tmp'), path.join(root, 'learned_words.json'));
        const saved = readLibrary(root), verified = audit(saved.html, saved.index);
        if (verified.htmlOnly.length || saved.index.words.length !== verified.names.length) throw Error('写入后集合校验失败');
        fs.unlinkSync(journal);
    } catch (error) { recover(root); throw error; }
    return {word: term.word, added: !exists, count: words.length, html: card};
}
function loadSupplements(root) {
    const file = path.join(root, 'reading-supplements.json');
    if (!fs.existsSync(file)) return [];
    const packs = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(packs)) throw Error('补充阅读包须为数组');
    return packs;
}
function scanMarkdownMaterials(root, options) {
    const library = readLibrary(root), names = audit(library.html, library.index).names;
    try { return scanMaterialDirectory(path.join(root, 'reading_materials'), names.map(word => ({word})), options); }
    catch (_) { return {materials: [], skipped: [{file: 'reading_materials', reason: '资料目录无法读取，请检查文件及访问权限。'}]}; }
}
function loadMarkdownMaterials(root) { return scanMarkdownMaterials(root).materials.map(item => item.pack); }
function readingCatalog(root) {
    const scan = scanMarkdownMaterials(root);
    let supplements = [], generation = null;
    const warnings = scan.skipped;
    try { supplements = loadSupplements(root); } catch (_) { warnings.push({file: '预置补充材料', reason: '文件损坏，已跳过。'}); }
    try { generation = generationPublicConfig(root); } catch (_) { warnings.push({file: '补充资料', reason: '生成服务配置有误，本地阅读仍可使用。'}); }
    return {materials: scan.materials.map(item => item.pack), supplements, warnings, generation};
}
function generationPublicConfig(root) {
    const {loadGenerationConfig} = require('./reading-generate.cjs');
    const generation = loadGenerationConfig({root});
    return {
        enabled: generation.allowExternalCalls,
        limits: {maxSearchRequests: generation.maxSearchRequests, maxArticles: generation.maxArticles, validationRetries: generation.validationRetries, maxSources: generation.maxSources, maxSourceChars: generation.maxSourceChars, generatedRetentionPerSlot: generation.generatedRetentionPerSlot},
        search: publicSearchConfig(loadSearchConfig({root})),
        models: publicModelConfig(loadModelConfig({root}))
    };
}
function startServer({root = __dirname, port = 47831, generatorFactory = options => require('./reading-generate.cjs').createReadingGenerator(options), translationFactory = createTranslationService} = {}) {
    root = path.resolve(root);
    const token = crypto.randomBytes(24).toString('hex');
    const staticFiles = new Set(['vocabulary.html', 'reading.css', 'reading-ui.js', 'reading-engine.js', 'reading-bank.js', 'reading-nasa.js', 'translation.css', 'translation-ui.js', 'translation-input.js']);
    let ready = false, generating = false;
    let translator;
    const translation = () => translator || (translator = translationFactory({root, getWords: () => {
        const library = readLibrary(root); return audit(library.html, library.index).names;
    }}));
    const server = http.createServer(async (req, res) => {
        const host = `127.0.0.1:${server.address().port}`;
        const origin = req.headers.origin;
        const allowed = !origin || origin === 'null' || origin === `http://${host}`;
        const send = (status, data) => { res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'}); res.end(JSON.stringify(data)); };
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (req.headers.host !== host || !allowed) return send(403, {code: 'FORBIDDEN_ORIGIN', error: '仅允许本地词库访问'});
        if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
        if (req.method === 'OPTIONS') {
            res.writeHead(204, {'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type, X-Reading-Token'}); return res.end();
        }
        if (!ready) return send(503, {code: 'SERVICE_NOT_READY', error: '正在核对本地词库'});
        try {
            const url = new URL(req.url, `http://${host}`);
            if (url.pathname.startsWith('/api/translation/')) {
                if (url.pathname === '/api/translation/config' && req.method === 'GET') {
                    try { return send(200,{token,...translation().publicConfig()}); }
                    catch (_) { return send(503,{code:'TRANSLATION_CONFIG_INVALID',error:'翻译配置无法读取，请检查本机 .env 的模型与数值设置；不会显示密钥。'}); }
                }
                if (req.headers['x-reading-token'] !== token) return send(403,{code:'INVALID_TOKEN',error:'本地请求令牌已失效，请重新打开翻译面板。'});
                const match = url.pathname.match(/^\/api\/translation\/jobs\/([\w-]+)(\/retry)?$/);
                if (req.method === 'GET' && match && !match[2]) return send(200,translation().get(match[1]));
                if (req.method !== 'POST') return send(405,{code:'METHOD_NOT_ALLOWED',error:'不支持此翻译请求。'});
                if (origin !== 'null' && origin !== `http://${host}`) return send(403,{code:'FORBIDDEN_ORIGIN',error:'翻译提交必须来自本地词库页面。'});
                if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) return send(415,{code:'JSON_REQUIRED',error:'请求须使用 JSON。'});
                let size = 0; const chunks = [];
                for await (const chunk of req) { size += chunk.length; if (size <= 256*1024) chunks.push(chunk); }
                if (size > 256*1024) return send(413,{code:'BODY_TOO_LARGE',error:'翻译请求过大，请减少内容后重试。'});
                let input;
                try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
                catch (_) { return send(400,{code:'INVALID_JSON',error:'请求不是有效 JSON，请重新提交。'}); }
                if (url.pathname === '/api/translation/jobs') return send(202,translation().start(input));
                if (match && match[2]) return send(202,translation().retry(match[1],input));
                if (url.pathname === '/api/translation/candidates/validate') {
                    if (!input || !Array.isArray(input.cards) || input.cards.length > 8 || typeof input.englishText !== 'string' || input.englishText.length > 160000) return send(400,{code:'INVALID_CANDIDATES',error:'候选词或英语语境格式不合格，请重新打开翻译记录。'});
                    const library = readLibrary(root), names = audit(library.html,library.index).names;
                    return send(200,{candidates:evaluateCandidates(input.cards,input.englishText,names)});
                }
                if (url.pathname === '/api/translation/words') {
                    if (!input || input.confirm !== true || !Array.isArray(input.items) || !input.items.length || input.items.length > 8) return send(400,{code:'CONFIRM_REQUIRED',error:'请明确确认要保存的 1–8 张候选词卡。'});
                    const results = input.items.map(item => {
                        const word = engine.normalize(typeof item?.card?.word === 'string' ? item.card.word : '');
                        try {
                            if (item?.reviewed !== true) throw failure(400,'REVIEW_REQUIRED','请先核对该词卡的释义、音标和例句。');
                            const library = readLibrary(root);
                            if (audit(library.html,library.index).names.includes(word)) return {...appendWord(root,{word}),status:'exists'};
                            const card = validateTranslationCard(item.card);
                            return {...appendWord(root,card,{kind:'translation'}),status:'added'};
                        } catch (err) {
                            const validationError = ['REVIEW_REQUIRED','INVALID_CARD','UNCERTAIN_CARD'].includes(err.code);
                            return {word,status:'failed',code:validationError ? err.code : 'SAVE_FAILED',error:validationError ? err.message : '本地词卡保存失败。请检查文件权限或磁盘空间后重试；已成功的词不会重复创建。'};
                        }
                    });
                    return send(200,{results});
                }
                return send(404,{code:'NOT_FOUND',error:'未找到翻译接口，请重启旧服务。'});
            }
            if (url.pathname === '/api/materials/review') {
                try {
                    if (!['GET', 'POST'].includes(req.method)) throw failure(405, 'METHOD_NOT_ALLOWED', '仅支持 GET 和 POST');
                    if (req.method === 'POST') {
                        if (origin !== 'null' && origin !== `http://${host}`) throw failure(403, 'FORBIDDEN_ORIGIN', '审核写入必须来自本地词库页面');
                        if (req.headers['x-reading-token'] !== token) throw failure(403, 'INVALID_TOKEN', '请求令牌失效，请重新读取审核列表');
                        if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) throw failure(415, 'JSON_REQUIRED', '审核请求必须使用 application/json');
                        const chunks = []; let size = 0;
                        // Drain oversized bodies without buffering, so clients receive a JSON error.
                        for await (const chunk of req) { size += chunk.length; if (size <= 8192) chunks.push(chunk); }
                        if (size > 8192) throw failure(413, 'BODY_TOO_LARGE', '审核请求不得超过 8 KiB');
                        let input;
                        try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
                        catch (_) { throw failure(400, 'INVALID_JSON', '请求不是有效 JSON'); }
                        // No await below: review and cleanup commits are synchronous. Generation
                        // holds generating through all its asynchronous work and final writes.
                        if (generating) throw failure(409, 'MATERIALS_BUSY', '材料正在生成，请完成后再审核');
                        const library = readLibrary(root), cards = audit(library.html, library.index).names.map(word => ({word}));
                        return send(200, reviewMaterial(path.join(root, 'reading_materials'), cards, input));
                    }
                    const library = readLibrary(root), cards = audit(library.html, library.index).names.map(word => ({word}));
                    return send(200, {token, ...scanReviews(path.join(root, 'reading_materials'), cards)});
                } catch (error) { return send(error.status || 500, {code: error.status ? error.code : 'REVIEW_READ_FAILED', error: error.status ? error.message : '无法读取或校验本地资料库'}); }
            }
            if (req.method === 'GET' && url.pathname === '/api/health') return send(200, {service: 'translate-helper', libraryId: libraryId(root)});
            if (req.method === 'GET' && url.pathname === '/api/reading') return send(200, {token, ...readingCatalog(root)});
            if (req.method === 'POST' && url.pathname === '/api/generate') {
                if (req.headers['x-reading-token'] !== token || req.headers['content-type'] !== 'application/json') return send(403, {code: 'INVALID_GENERATION_REQUEST', error: '请求校验失败，请重新打开阅读窗口'});
                if (generating) return send(409, {code: 'MATERIALS_BUSY', error: '已有一项生成任务正在进行，请等待完成'});
                let body = '';
                for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body, 'utf8') > 512 * 1024) return send(413, {code: 'BODY_TOO_LARGE', error: '生成请求超过 512 KiB 限制'}); }
                const input = JSON.parse(body);
                if (!input || input.confirm !== true) return send(400, {code: 'CONFIRM_REQUIRED', error: '请先确认本次可能产生搜索和模型费用'});
                if (generating) return send(409, {code: 'MATERIALS_BUSY', error: '已有一项生成任务正在进行，请等待完成'});
                generating = true;
                try {
                    const result = await generatorFactory({root}).generate({searchProvider: input.searchProvider, modelProvider: input.modelProvider, model: input.model, queries: input.queries, minutes: input.minutes, count: input.count, supplements: input.supplements || [], protectedMaterialIds: input.protectedMaterialIds || [], hasPendingWords: input.hasPendingWords === true});
                    return send(201, {files: result.files.map(file => path.basename(file)), sources: result.sources, skippedSources: result.skippedSources, usage: result.usage, retention: result.retention || null});
                } finally { generating = false; }
            }
            if (req.method === 'POST' && url.pathname === '/api/materials/cleanup') {
                if (req.headers['x-reading-token'] !== token || req.headers['content-type'] !== 'application/json') return send(403, {error: '请求校验失败，请重新打开阅读窗口'});
                if (generating) return send(409, {error: '材料生成尚未结束，暂不清理'});
                let body = '';
                for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body, 'utf8') > 32 * 1024) return send(413, {error: '清理请求过大'}); }
                const input = JSON.parse(body);
                if (input.confirm !== true) return send(400, {error: '请先确认清理候选'});
                if (generating) return send(409, {code: 'MATERIALS_BUSY', error: '材料生成尚未结束，暂不清理'});
                const library = readLibrary(root), names = audit(library.html, library.index).names;
                const generation = require('./reading-generate.cjs').loadGenerationConfig({root});
                const result = executeRetentionCleanup(path.join(root, 'reading_materials'), names.map(word => ({word})), input.ids, {limit: generation.generatedRetentionPerSlot || 3, protectedMaterialIds: input.protectedMaterialIds || [], hasPendingWords: input.hasPendingWords === true});
                return send(200, result);
            }
            if (req.method === 'POST' && url.pathname === '/api/words') {
                if (req.headers['x-reading-token'] !== token || req.headers['content-type'] !== 'application/json') return send(403, {error: '请求校验失败，请重新打开阅读窗口'});
                let body = '';
                for await (const chunk of req) { body += chunk; if (body.length > 2048) return send(413, {error: '请求过大'}); }
                const {word} = JSON.parse(body);
                const library = readLibrary(root);
                if (audit(library.html, library.index).names.includes(word)) return send(200, appendWord(root, {word}));
                let supplements = [];
                try { supplements = loadSupplements(root); } catch (_) { /* Other validated sources remain usable. */ }
                // Learning can exhaust an article's new words midway through answering.
                // Recheck its structure and cards, not its eligibility for a NEW reading.
                const markdown = scanMarkdownMaterials(root, {checkEligibility: false});
                const candidates = [...markdown.materials.flatMap(item => item.pack.terms), ...bank.terms, ...supplements.flatMap(p => p.terms || [])];
                const term = candidates.find(t => t.word === word);
                if (!term) return send(400, {error: '该词缺少经过审核的完整词卡，未写入'});
                engine.validateTerm(term);
                return send(200, appendWord(root, term));
            }
            if (req.method !== 'GET') return send(405, {error: '不支持的请求'});
            const filename = url.pathname === '/' ? 'vocabulary.html' : url.pathname.slice(1);
            if (!staticFiles.has(filename)) return send(404, {error: '未找到'});
            res.writeHead(200, {'Content-Type': filename.endsWith('.html') ? 'text/html; charset=utf-8' : filename.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8'});
            res.end(fs.readFileSync(path.join(root, filename)));
        } catch (error) { send(error.status || 400, {code: error.code || (error instanceof SyntaxError ? 'INVALID_JSON' : 'REQUEST_FAILED'), error: error.message}); }
    });
    server.on('listening', () => {
        try { recover(root); const state = readLibrary(root); audit(state.html, state.index); ready = true; server.emit('ready'); }
        catch (error) { console.error(error.message); server.close(); server.emit('startup-failed', error); }
    });
    server.listen(port, '127.0.0.1');
    return server;
}
function libraryId(root) { return crypto.createHash('sha256').update(path.resolve(root).toLowerCase()).digest('hex'); }
function runServerCLI({root = __dirname, port = 47831, open = false, opener = openVocabulary} = {}) {
    const server = startServer({root, port});
    server.on('ready', () => {
        console.log(`精选短文服务已启动：http://127.0.0.1:${server.address().port}`);
        console.log('请保持此窗口开启。直接打开原 vocabulary.html 可沿用原浏览器学习记录。');
        if (open) opener(path.join(root, 'vocabulary.html'));
    });
    server.on('startup-failed', () => { process.exitCode = 1; });
    server.on('error', async error => {
        if (error.code === 'EADDRINUSE') {
            try {
                const response = await fetch(`http://127.0.0.1:${port}/api/health`, {signal: AbortSignal.timeout(2000)});
                const health = await response.json();
                if (response.ok && health.service === 'translate-helper' && health.libraryId === libraryId(root)) {
                    console.log('此词库服务已经运行，正在复用；请保留原服务窗口。');
                    if (open) await opener(path.join(root, 'vocabulary.html'));
                    server.emit('reused');
                    return;
                }
            } catch (_) { /* A busy port is never assumed to belong to this library. */ }
            console.error('端口被其他程序或另一份词库占用，无法启动本词库。');
        } else console.error(error.message);
        process.exitCode = 1;
    });
    return server;
}
module.exports = {startServer, runServerCLI, audit, appendWord, cardHTML, generationPublicConfig, loadMarkdownMaterials, openVocabulary, recover, readLibrary};
if (require.main === module) runServerCLI({open: process.argv.includes('--open') && !process.argv.includes('--no-open')});
