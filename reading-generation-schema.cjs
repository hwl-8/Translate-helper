'use strict';

const text = (maxLength = 5000) => ({type: 'string', minLength: 1, maxLength});
const closed = (properties, required = Object.keys(properties)) => ({type: 'object', additionalProperties: false, properties, required});

function generationSchema(sourceIds) {
    if (!Array.isArray(sourceIds) || !sourceIds.length) throw Error('生成 Schema 至少需要一个来源 ID');
    const option = closed({text: text(2000), chinese: {type: 'string', maxLength: 2000}, correct: {type: 'boolean'}});
    const question = closed({
        kind: {type: 'string', enum: ['vocabulary', 'comprehension']},
        word: {type: 'string', maxLength: 100},
        prompt: text(3000),
        options: {type: 'array', minItems: 3, maxItems: 4, items: option},
        explanation: text(5000)
    });
    const card = closed({word: text(100), uk: text(200), us: text(200), pos: text(100), chinese: text(2000), english: text(2000), example: text(2000), translation: text(2000), source: text(2048)});
    return closed({
        title: text(300),
        supportHint: {type: 'string', maxLength: 3000},
        article: {type: 'array', minItems: 1, maxItems: 100, items: closed({text: text(30000), sourceId: {type: 'string', enum: sourceIds}, contentType: {type: 'string', enum: ['learning_adaptation']}})},
        questions: {type: 'array', minItems: 1, maxItems: 5, items: question},
        candidateCards: {type: 'array', minItems: 2, maxItems: 20, items: card}
    });
}

module.exports = {generationSchema};
