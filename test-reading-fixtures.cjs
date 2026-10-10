'use strict';

// Offline test data only. Callers write these editions into their own temporary
// directories; no private paper, production material or model request is needed.
const engine = require('./reading-engine.js');
const bank = require('./reading-bank.js');
const nasa = require('./reading-nasa.js');
const {renderMaterialMarkdown} = require('./reading-materials.cjs');

function waterCycleMarkdown(vocabularyCards, minutes) {
    if (![20, 45].includes(minutes)) throw Error('Water-cycle fixtures support only 20/45min.');
    const pack = engine.makeReading(bank, nasa, vocabularyCards, minutes);
    return renderMaterialMarkdown({
        metadata: {
            formatVersion: 1,
            id: `fixture-water-cycle-${minutes}`,
            title: pack.title,
            materialType: 'website',
            creationMethod: 'manual_migration',
            reviewStatus: 'approved',
            generatedDate: '2026-10-10',
            minutes,
            level: pack.level,
            supportHint: 'Offline test fixture based on existing water-cycle material.',
            sources: pack.sources.map(source => ({
                id: source.id, title: source.title, url: source.url,
                date: source.date || 'Historical source', sourceType: 'website'
            }))
        },
        article: pack.paragraphs.map(paragraph => ({
            text: paragraph.text, sourceId: paragraph.source, contentType: paragraph.contentType
        })),
        questions: pack.questions,
        candidateCards: pack.terms.map(({context, ...card}) => card)
    }, vocabularyCards);
}

module.exports = {waterCycleMarkdown};
