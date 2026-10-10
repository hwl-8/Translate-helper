'use strict';
const {PROJECT_ROOT} = require('./helpers.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createModelClient, loadModelConfig, validateJsonSchema} = require('../server/reading-models.cjs');
const {createSearchClient, loadSearchConfig} = require('../modules/reading/reading-search.cjs');
const {createReadingGenerator} = require('../modules/reading/reading-generate.cjs');
const {generationSchema} = require('../modules/reading/reading-generation-schema.cjs');
const {readLibrary, audit, appendWord} = require('../server/reading-server.cjs');
const {parseMaterialMarkdown} = require('../modules/reading/reading-materials.cjs');

(async () => {
    const original = readLibrary(PROJECT_ROOT), cards = audit(original.html, original.index).names.map(word => ({word}));
    const material = parseMaterialMarkdown(fs.readFileSync(path.join(PROJECT_ROOT, 'reading_materials', 'docker-user-v1-0.md'), 'utf8'), cards).material;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reading-acceptance-'));
    try {
        for (const file of ['vocabulary.html', 'learned_words.json']) fs.copyFileSync(path.join(PROJECT_ROOT, file), path.join(root, file));
        const modelConfig = loadModelConfig({root, env: {DEEPSEEK_API_KEY: 'mock', MODEL_USAGE_FILE: 'off', MODEL_MAX_RETRIES: '1'}});
        const searchConfig = loadSearchConfig({root, env: {TAVILY_API_KEY: 'mock', SEARCH_MAX_RETRIES: '1'}});
        for (const provider of ['deepseek']) for (const failure of ['auth', 'offline', 'rate']) {
            let calls = 0;
            const client = createModelClient({config: modelConfig, recordUsage: () => {}, sleep: async () => {}, fetchImpl: async () => {
                calls++; if (failure === 'offline') throw Error('mock disconnected');
                return new Response('{}', {status: failure === 'auth' ? 401 : 429});
            }});
            await assert.rejects(client.generate({provider, instructions: 'JSON', input: 'test', schema: {type: 'object', properties: {}}}), error => error.code === ({auth: 'authentication', offline: 'network', rate: 'rate_limit'})[failure]);
            assert.equal(calls, failure === 'auth' ? 1 : 2);
        }
        for (const failure of ['auth', 'offline', 'rate']) {
            let calls = 0;
            const client = createSearchClient({config: searchConfig, sleep: async () => {}, fetchImpl: async () => {
                calls++; if (failure === 'offline') throw Error('mock disconnected');
                return new Response('{}', {status: failure === 'auth' ? 401 : 429});
            }});
            await assert.rejects(client.search({provider: 'tavily', query: 'science'}), error => error.code === ({auth: 'authentication', offline: 'network', rate: 'rate_limit'})[failure]);
            assert.equal(calls, failure === 'auth' ? 1 : 2);
        }
        const draft = {title: material.metadata.title, supportHint: '', article: material.article, candidateCards: material.candidateCards, questions: material.questions.map(q => ({...q, word: q.word || '', options: q.options.map(o => ({...o, chinese: o.chinese || ''}))}))};
        validateJsonSchema(draft, generationSchema(['source-1']));
        let calls = 0;
        const generator = createReadingGenerator({root,
            config: {maxSearchRequests: 1, maxArticles: 1, validationRetries: 2, maxSources: 1, maxSourceChars: 10000, usageFile: null},
            searchClient: {search: async () => ({results: [], usage: {requests: 1}})},
            sourceCollector: async () => ({sources: [{...material.metadata.sources[0], content: material.article.map(p => p.text).join(' ')}], websiteCount: 0, auxiliaryCount: 1, skipped: []}),
            modelClient: {generate: async () => { calls++; return {output: draft, usage: {}}; }}
        });
        const rename = fs.renameSync;
        try {
            fs.renameSync = (from, to) => { if (String(to).endsWith('.md')) { const error = Error('simulated disk access denied'); error.code = 'EACCES'; throw error; } return rename(from, to); };
            await assert.rejects(generator.generate({searchProvider: 'tavily', modelProvider: 'deepseek', model: 'deepseek-flash', queries: ['test'], minutes: 5}), error => error.code === 'save_failed');
        } finally { fs.renameSync = rename; }
        assert.equal(calls, 1, 'A disk failure must not cause another paid generation');
        assert.deepEqual(fs.readdirSync(path.join(root, 'reading_materials')), [], 'No partial article or temporary file');
        const before = readLibrary(root);
        let injected = false;
        try {
            fs.renameSync = (from, to) => { if (String(to).endsWith('learned_words.json') && !injected) { injected = true; const error = Error('simulated index write failure'); error.code = 'EACCES'; throw error; } return rename(from, to); };
            assert.throws(() => appendWord(root, material.candidateCards[0]), /simulated/);
        } finally { fs.renameSync = rename; }
        assert(injected);
        assert.equal(readLibrary(root).html, before.html);
        assert.equal(readLibrary(root).indexText, before.indexText);
        assert(!fs.existsSync(path.join(root, '.reading-transaction.json')));
        console.log(JSON.stringify({result: 'PASS', checks: ['DeepSeek: bad key, offline, rate limit', 'search: bad key, offline, rate limit', 'structured draft optional Chinese hints', 'disk failure stops paid retries and cleans incomplete material', 'word-card/index write failure rolls back both files']}, null, 2));
    } finally {
        assert.equal(readLibrary(PROJECT_ROOT).html, original.html);
        assert.equal(readLibrary(PROJECT_ROOT).indexText, original.indexText);
        fs.rmSync(root, {recursive: true, force: true});
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
