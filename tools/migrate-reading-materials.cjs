'use strict';
const {PROJECT_ROOT} = require('../server/project-paths.cjs');

const fs = require('node:fs');
const path = require('node:path');
const {readLibrary, audit} = require('../server/reading-server.cjs');
const {renderMaterialMarkdown} = require('../modules/reading/reading-materials.cjs');

function migrateSupplements(root = PROJECT_ROOT, generatedDate = '2026-09-15') {
    const library = readLibrary(root);
    const vocabularyCards = audit(library.html, library.index).names.map(word => ({word}));
    const packs = JSON.parse(fs.readFileSync(path.join(root, 'modules/reading/reading-supplements.json'), 'utf8'));
    const target = path.join(root, 'reading_materials');
    fs.mkdirSync(target, {recursive: true});
    const written = [];
    for (const pack of packs) {
        const sources = pack.sources.map((source, index) => ({
            id: `source-${index + 1}`,
            title: source.title,
            url: source.url,
            date: source.date,
            sourceType: pack.origin === 'website' ? 'website' : pack.origin === 'input' ? 'input_file' : 'user_input'
        }));
        const material = {
            metadata: {
                formatVersion: 1,
                id: pack.id,
                title: pack.title,
                materialType: pack.origin,
                creationMethod: 'manual_migration',
                generatedDate,
                minutes: pack.minutes,
                level: pack.level,
                supportHint: pack.supportHint || '',
                sources
            },
            article: pack.paragraphs.map(paragraph => ({
                text: paragraph.text,
                sourceId: sources[0].id,
                contentType: 'learning_adaptation'
            })),
            questions: pack.questions,
            candidateCards: pack.terms
        };
        const filename = path.join(target, `${pack.id}.md`);
        if (fs.existsSync(filename)) throw Error(`目标文件已存在，未覆盖：${path.basename(filename)}`);
        fs.writeFileSync(filename + '.tmp', renderMaterialMarkdown(material, vocabularyCards), {flag: 'wx'});
        fs.renameSync(filename + '.tmp', filename);
        written.push(filename);
    }
    return written;
}

module.exports = {migrateSupplements};

if (require.main === module) {
    try {
        const written = migrateSupplements();
        console.log(`已生成 ${written.length} 个 Markdown 示例：`);
        written.forEach(filename => console.log(path.relative(PROJECT_ROOT, filename)));
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
