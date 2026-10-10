'use strict';

// Layout regression: only temporary data/configuration, never the user's .env.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {once} = require('node:events');
const {PROJECT_ROOT, BROWSER_FILES, copyProjectFiles} = require('./helpers.cjs');
const {startServer} = require('../server/reading-server.cjs');

(async () => {
    const expectedRoot = path.resolve(__dirname, '..');
    assert.equal(PROJECT_ROOT, expectedRoot);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'translate-layout-'));
    let server;
    const originalFetch = globalThis.fetch;
    try {
        copyProjectFiles(root);
        assert.throws(() => copyProjectFiles(root, ['../outside.txt']), /inside its project/);
        const html = fs.readFileSync(path.join(root, 'vocabulary.html'), 'utf8');
        const references = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)].map(match => match[1]);
        assert.equal(references.length, 8, 'All six scripts and two styles must retain explicit local references');
        assert.equal(new Set(references).size, references.length);
        for (const relative of references) {
            assert(BROWSER_FILES.includes(relative), `Browser copy is missing ${relative}`);
            assert(relative.startsWith('modules/reading/') || relative.startsWith('modules/translation/'));
            assert(fs.statSync(path.join(root, relative)).isFile(), relative);
        }
        const entryPoints = [
            ['server/reading-server.cjs', /function startServer\(\{root = PROJECT_ROOT/],
            ['server/reading-server.cjs', /function runServerCLI\(\{root = PROJECT_ROOT/],
            ['server/reading-models.cjs', /function loadModelConfig\(\{root = PROJECT_ROOT/],
            ['modules/reading/reading-search.cjs', /function loadSearchConfig\(\{root = PROJECT_ROOT/],
            ['modules/reading/reading-generate.cjs', /function loadGenerationConfig\(\{root = PROJECT_ROOT/],
            ['modules/reading/reading-generate.cjs', /options\.root \|\| PROJECT_ROOT/],
            ['modules/translation/translation-service.cjs', /function loadTranslationConfig\(\{root = PROJECT_ROOT/],
            ['modules/translation/translation-service.cjs', /function createTranslationService\(\{root = PROJECT_ROOT/],
            ['tools/import-reading.cjs', /function importReading\(filename, root = PROJECT_ROOT\)/]
        ];
        for (const [relative, pattern] of entryPoints) {
            const source = fs.readFileSync(path.join(PROJECT_ROOT, relative), 'utf8');
            assert.match(source, pattern, `${relative} must use the project root, not the current directory`);
            const old = path.join(PROJECT_ROOT, path.basename(relative));
            assert(!fs.existsSync(old), `Obsolete root runtime file remains: ${path.basename(relative)}`);
        }
        const pathModule = path.join(PROJECT_ROOT, 'server/project-paths.cjs');
        const script = `const assert=require('node:assert/strict');const {PROJECT_ROOT}=require(${JSON.stringify(pathModule)});assert.equal(PROJECT_ROOT,${JSON.stringify(PROJECT_ROOT)});process.stdout.write('PASS');`;
        const arbitraryCwd = spawnSync(process.execPath, ['-e', script], {cwd: root, encoding: 'utf8', windowsHide: true});
        assert.equal(arbitraryCwd.status, 0, arbitraryCwd.stderr);
        assert.equal(arbitraryCwd.stdout, 'PASS', 'Project root must stay correct from any cwd');

        // Fake private files must exist, so a 404 proves access control rather than absence.
        for (const relative of ['.env', 'server/reading-server.cjs', 'tools/import-reading.cjs', 'tests/check-layout.cjs', 'input/private.txt', 'output/private.txt', 'docs/private.md', 'reading_materials/private.md']) {
            const target = path.join(root, relative);
            fs.mkdirSync(path.dirname(target), {recursive: true});
            fs.writeFileSync(target, relative === '.env' ? 'READING_ALLOW_EXTERNAL_CALLS=false\nTRANSLATION_ALLOW_EXTERNAL_CALLS=false\nMODEL_USAGE_FILE=off\n' : 'PRIVATE_TEST_SENTINEL');
        }
        server = startServer({root, port: 0});
        await once(server, 'ready');
        const base = `http://127.0.0.1:${server.address().port}`;
        globalThis.fetch = (input, options) => {
            const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
            assert.equal(url.origin, base, 'Layout test cannot make external requests');
            return originalFetch(input, options);
        };
        for (const relative of ['vocabulary.html', ...references]) {
            const response = await fetch(base + '/' + relative);
            assert.equal(response.status, 200, relative);
            assert.deepEqual(Buffer.from(await response.arrayBuffer()), fs.readFileSync(path.join(root, relative)), `Wrong static resource: ${relative}`);
        }
        const blocked = ['.env', '.env.example', 'server/reading-server.cjs', 'server/reading-models.cjs', 'tools/import-reading.cjs', 'tests/check-layout.cjs', 'modules/reading/reading-generate.cjs', 'modules/reading/reading-supplements.json', 'modules/translation/translation-service.cjs', 'learned_words.json', 'input/private.txt', 'output/private.txt', 'docs/private.md', 'reading_materials/private.md', 'modules/%2e%2e/%2e%2e/.env'];
        for (const relative of blocked) {
            const response = await fetch(base + '/' + relative);
            assert.equal(response.status, 404, `Private route exposed: ${relative}`);
            assert(!(await response.text()).includes('PRIVATE_TEST_SENTINEL'));
        }
        const catalog = await (await fetch(base + '/api/reading')).json();
        assert.equal(catalog.generation.enabled, false);
        assert(Array.isArray(catalog.supplements) && catalog.supplements.length > 0, 'Fallback JSON must load from modules/reading');
        const config = await (await fetch(base + '/api/translation/config')).json();
        assert.equal(config.enabled, false);
        assert(!JSON.stringify(config).includes('apiKey'));
        console.log(JSON.stringify({result: 'PASS', checks: ['module layout and default roots', 'arbitrary cwd', 'complete relative browser copy', 'all static resources reachable', 'private/server/tool/test routes blocked', 'fallback JSON path', 'no external requests']}, null, 2));
    } finally {
        globalThis.fetch = originalFetch;
        if (server?.listening) await new Promise(resolve => {server.close(resolve); server.closeAllConnections();});
        fs.rmSync(root, {recursive: true, force: true});
    }
})().catch(error => {console.error(error); process.exitCode = 1;});
