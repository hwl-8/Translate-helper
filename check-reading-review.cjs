'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {once} = require('node:events');
const {startServer, readLibrary, audit} = require('./reading-server.cjs');
const {scanReviews, reviewMaterial} = require('./reading-review.cjs');

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reading-review-test-'));
    const directory = path.join(root, 'reading_materials');
    let server, releaseGeneration, generationError = false;
    try {
        fs.mkdirSync(directory);
        for (const file of ['vocabulary.html', 'learned_words.json']) fs.copyFileSync(path.join(__dirname, file), path.join(root, file));
        const raw = fs.readFileSync(path.join(__dirname, 'reading_materials', 'docker-user-v1-0.md'), 'utf8');
        const target = path.join(directory, 'unrelated-filename.md');
        fs.writeFileSync(target, raw);
        fs.writeFileSync(path.join(directory, 'broken.md'), 'bad JSON');
        fs.writeFileSync(path.join(directory, 'unsafe.md'), raw + '<script>throw Error("executed")</script>');
        fs.mkdirSync(path.join(directory, 'folder.md'));
        const library = readLibrary(root), cards = audit(library.html, library.index).names.map(word => ({word}));
        let item = scanReviews(directory, cards).materials[0];
        const id = item.material.metadata.id;
        assert.equal(item.revision, crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'));
        assert.equal(scanReviews(directory, cards).skipped.length, 3);
        let started;
        const generationStarted = new Promise(resolve => { started = resolve; });
        server = startServer({root, port: 0, generatorFactory: () => ({generate: async () => {
            if (generationError) throw Object.assign(Error('simulated network failure'), {code: 'MODEL_NETWORK_FAILED'});
            started(); await new Promise(resolve => { releaseGeneration = resolve; });
            return {files: [], sources: [], skippedSources: [], usage: {}};
        }})});
        await once(server, 'ready');
        const origin = `http://127.0.0.1:${server.address().port}`;
        const endpoint = origin + '/api/materials/review';
        const listing = await (await fetch(endpoint)).json();
        const token = listing.token;
        const headers = {Origin: origin, 'Content-Type': 'application/json', 'X-Reading-Token': token};
        const post = (body, overrides = {}) => fetch(endpoint, {method: 'POST', headers: {...headers, ...overrides}, body: typeof body === 'string' ? body : JSON.stringify(body)});
        const input = status => ({confirm: true, id, revision: item.revision, status});
        async function error(response, status, code) {
            assert.equal(response.status, status); assert.equal((await response.json()).code, code);
        }
        assert.equal((await post(input('approved'), {Origin: 'null'})).status, 200, 'Launcher file origin must support review with a valid token');
        item = scanReviews(directory, cards).materials[0];
        await error(await post(input('approved'), {Origin: 'https://example.org'}), 403, 'FORBIDDEN_ORIGIN');
        await error(await post(input('approved'), {'X-Reading-Token': 'wrong'}), 403, 'INVALID_TOKEN');
        await error(await post(input('approved'), {'Content-Type': 'text/plain'}), 415, 'JSON_REQUIRED');
        await error(await post('{'), 400, 'INVALID_JSON');
        await error(await post(' '.repeat(8193)), 413, 'BODY_TOO_LARGE');
        for (const body of [null, [], {...input('approved'), confirm: false}, {...input('approved'), id: '../x'}, {...input('approved'), filename: 'x.md'}, input('unknown')]) {
            await error(await post(body), 400, 'INVALID_REVIEW_REQUEST');
        }
        for (const status of ['pending', 'rejected', 'approved']) {
            const old = item.revision;
            const response = await post(input(status)); assert.equal(response.status, 200);
            item = await response.json(); assert.equal(item.status, status); assert.equal(item.pack.reviewStatus, status);
            assert.equal(item.material.metadata.reviewStatus, status);
            assert.equal(scanReviews(directory, cards).materials.length, 1);
            assert.equal(fs.readFileSync(target, 'utf8').split('## Article')[1], raw.split('## Article')[1]);
            await error(await post({...input(status), revision: old}), 409, 'REVISION_CONFLICT');
        }
        fs.copyFileSync(target, path.join(directory, 'duplicate.md'));
        await error(await post(input('pending')), 409, 'DUPLICATE_MATERIAL_ID');
        fs.unlinkSync(path.join(directory, 'duplicate.md'));

        // Current HTML, rather than the index, governs approval eligibility.
        fs.writeFileSync(path.join(root, 'vocabulary.html'), '<div id="wordList"></div>');
        fs.writeFileSync(path.join(root, 'learned_words.json'), '{"words":[]}');
        const invalid = await (await fetch(endpoint)).json();
        assert.equal(invalid.materials.length, 1); assert(invalid.materials[0].eligibilityReason);
        await error(await post(input('approved')), 422, 'MATERIAL_INELIGIBLE');
        item = await (await post(input('rejected'))).json(); assert.equal(item.status, 'rejected');
        for (const file of ['vocabulary.html', 'learned_words.json']) fs.copyFileSync(path.join(__dirname, file), path.join(root, file));

        const pending = fetch(origin + '/api/generate', {method: 'POST', headers, body: '{"confirm":true}'});
        await generationStarted;
        await error(await post(input('pending')), 409, 'MATERIALS_BUSY');
        const cleanup = await fetch(origin + '/api/materials/cleanup', {method: 'POST', headers, body: '{"confirm":true,"ids":[]}'});
        assert.equal(cleanup.status, 409);
        releaseGeneration(); await pending;
        generationError = true;
        await error(await fetch(origin + '/api/generate', {method: 'POST', headers, body: '{"confirm":true}'}), 400, 'MODEL_NETWORK_FAILED');

        // Failed atomic replace leaves original bytes and removes the temporary file.
        const before = fs.readFileSync(target), rename = fs.renameSync;
        try {
            fs.renameSync = () => { throw Error('simulated disk failure'); };
            assert.throws(() => reviewMaterial(directory, cards, input('pending')), e => e.code === 'REVIEW_SAVE_FAILED');
        } finally { fs.renameSync = rename; }
        assert.deepEqual(fs.readFileSync(target), before);
        assert(!fs.readdirSync(directory).some(file => file.endsWith('.tmp')));
        fs.unlinkSync(target);
        await error(await post(input('pending')), 404, 'MATERIAL_NOT_FOUND');
        console.log('PASS: review listing, validation, origin/token/JSON/size, all statuses, revisions, duplicate IDs, current vocabulary, generation exclusion, atomic save failure; temporary files only, no .env or paid calls.');
    } finally {
        if (releaseGeneration) releaseGeneration();
        if (server) await new Promise(resolve => server.close(resolve));
        fs.rmSync(root, {recursive: true, force: true});
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
