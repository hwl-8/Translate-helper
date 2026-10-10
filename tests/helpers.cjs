'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {PROJECT_ROOT} = require('../server/project-paths.cjs');

// An explicit browser-resource allowlist: never discover/copy private configuration.
const BROWSER_FILES = Object.freeze([
    'vocabulary.html', 'learned_words.json',
    'modules/reading/reading.css', 'modules/reading/reading-ui.js',
    'modules/reading/reading-engine.js', 'modules/reading/reading-bank.js',
    'modules/reading/reading-nasa.js', 'modules/reading/reading-supplements.json',
    'modules/translation/translation-input.js', 'modules/translation/translation-ui.js',
    'modules/translation/translation.css'
]);

function copyProjectFiles(root, files = BROWSER_FILES) {
    for (const relative of files) {
        const source = path.resolve(PROJECT_ROOT, relative);
        const target = path.resolve(root, relative);
        for (const [base, resolved] of [[PROJECT_ROOT, source], [path.resolve(root), target]]) {
            const within = path.relative(base, resolved);
            if (!within || within.startsWith('..' + path.sep) || within === '..' || path.isAbsolute(within)) throw Error('Test copy must stay inside its project');
        }
        fs.mkdirSync(path.dirname(target), {recursive: true});
        fs.copyFileSync(source, target);
    }
}

module.exports = {PROJECT_ROOT, BROWSER_FILES, copyProjectFiles};
