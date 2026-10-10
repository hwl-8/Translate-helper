// Import a reviewed reading pack prepared from a website, input/ or a user passage.
// Raw text is deliberately not turned into unverified definitions or invented questions.
'use strict';
const {PROJECT_ROOT} = require('../server/project-paths.cjs');
const fs = require('node:fs');
const path = require('node:path');
const {readLibrary, audit} = require('../server/reading-server.cjs');
const {validatePack, hash} = require('../modules/reading/reading-engine.js');
function importReading(filename, root = PROJECT_ROOT) {
    const library = readLibrary(root), names = audit(library.html, library.index).names;
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const incoming = (Array.isArray(value) ? value : [value]).map(pack => validatePack(pack, names.map(word => ({word}))));
    const file = path.join(root, 'modules/reading/reading-supplements.json');
    const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
    for (const pack of incoming) {
        // Freeze content version so changing a pack cannot reuse answer records accidentally.
        const versionedId = pack.id + '-' + hash(JSON.stringify(pack));
        if (existing.some(p => p.id === pack.id || p.id === versionedId)) throw Error('阅读包 ID 已存在，未覆盖：' + pack.id);
        existing.push({...pack, id: versionedId});
    }
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file + '.tmp', JSON.stringify(existing, null, 2) + '\n');
    fs.renameSync(file + '.tmp', file);
    return incoming.length;
}
module.exports = {importReading};
if (require.main === module) {
    try { if (!process.argv[2]) throw Error('用法：node tools/import-reading.cjs <已审核的阅读包.json>'); console.log('已导入阅读包：' + importReading(path.resolve(process.argv[2]))); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
