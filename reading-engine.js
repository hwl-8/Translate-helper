(function (root) {
    'use strict';
    const normalize = value => value.replace(/\s+/g, ' ').trim().toLowerCase();
    const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const contains = (text, word) => new RegExp('(?<![a-z])' + escapeRegex(word) + '(?![a-z])', 'i').test(text);
    const wordCount = text => (text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || []).length;
    const mix = items => {
        const result = items.slice();
        for (let i = result.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [result[i], result[j]] = [result[j], result[i]]; }
        return result;
    };
    function difficulty(count) {
        return count < 100 ? {level: 0, label: '适中 · 辅助精读', wpm: 70, support: true}
            : count < 500 ? {level: 1, label: '适中 · 独立阅读', wpm: 75, support: true}
            : {level: 2, label: '进阶 · 原文阅读', wpm: 80, support: false};
    }
    function hash(text) { let h = 2166136261; for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0).toString(16); }
    // Identity follows the prose, not a filename, title, paragraph boundary or shuffled question.
    function contentKey(pack) { return normalize(pack.paragraphs.map(p => p.text).join(' ')); }
    function makeReading(bank, nasa, cards, minutes, options = {}) {
        if (![5, 20, 45].includes(minutes)) throw Error('请选择 5、20 或 45 分钟档位。');
        const names = new Set(cards.map(c => normalize(c.word)));
        const d = difficulty(names.size);
        // These are complete editions, never assembled from the learner's sampled words.
        const paragraphs = [
            'Follow a drop of water from the ocean to a field and back. Heat from the Sun supplies the energy for evaporation: liquid water becomes water vapour and enters the air. Winds carry it over land. As moist air rises and cools, condensation changes vapour into small liquid drops that can form clouds. When drops grow large enough, water returns to the surface as precipitation, including rain or snow. The journey has no single starting point, because water keeps moving between these connected places.',
            'On land, the route becomes more complex. Rain may flow over the surface as runoff and join a stream. Some water sinks into the soil, leaving moisture that roots can absorb. Deeper down, an aquifer holds and transmits water through spaces in rock or sand. A well can bring this groundwater to the surface for irrigation when crops need more water than rainfall provides. Plants return some water to the air through transpiration, the release of water vapour from their leaves. Water used by people can also return to rivers, the ground, or the air and continue its journey.',
            'A lake along this route has a limited capacity: it can store only a certain amount of water before the level rises beyond its banks. Yet the amount stored does not tell us how much water passes through. A substantial flow may enter and leave while the level changes little. This distinction helps explain why a river, a lake, and the atmosphere must be studied as parts of one system. Water leaving one place has often entered another, rather than disappeared.',
            'To understand these connections, researchers need reliable observations of both storage and movement. They integrate measurements from the ground with observations from space to build a more comprehensive picture. Their objective is to understand how water travels and how its distribution changes. Following one drop is a useful beginning, but it represents only one possible path. Other drops may remain underground for much longer or return quickly to the atmosphere. Together, these different journeys connect the ocean, the land, plants, and people.'
        ].map((text, i) => ({text, source: i < 3 ? 'usgs' : 'nasa', contentType: 'learning_adaptation'}));
        const appendOriginal = (texts, source) => paragraphs.push(...texts.map(text => ({text, source, contentType: 'original_excerpt'})));
        if (minutes >= 20) {
            appendOriginal(bank.usgs, 'usgs');
            // NASA's opening four paragraphs form a complete overview of water stores
            // and atmospheric heat. Stop before the absent table referenced next.
            appendOriginal(nasa.slice(0, 4), 'nasa');
        }
        if (minutes === 45) {
            // Complete cycle, climate and Aqua sections; omit the missing-table section
            // and end before the separate historical survey of other missions.
            appendOriginal(nasa.slice(6, 33), 'nasa');
        }
        const text = paragraphs.map(p => p.text).join('\n\n');
        const covered = [...names].filter(w => contains(text, w));
        const terms = bank.terms.filter(t => contains(text, t.word));
        const fresh = terms.filter(t => !names.has(t.word));
        if (covered.length < 4) throw Error('当前精选材料不足以覆盖 4 个已收录词，请补充匹配词库的文章。');
        if (fresh.length < 2) throw Error('这组材料中的新词已不足 2 个，请补充精选材料后再读。已学词不会冒充新词。');
        const target = minutes * d.wpm;
        if (wordCount(text) < target * 0.8 || wordCount(text) > target * 1.2) throw Error('该档位的材料长度不匹配，请补充文章。');
        const vocab = term => ({kind: 'vocabulary', word: term.word, prompt: `In the passage, what does “${term.word}” most nearly mean?`, options: mix([{text: term.english, chinese: term.chinese, correct: true}, ...mix(terms.filter(t => t.word !== term.word && t.pos === term.pos && t.english !== term.english)).slice(0, 2).map(t => ({text: t.english, chinese: t.chinese, correct: false}))]), explanation: `${paragraphs.find(p => contains(p.text, term.word)).text}\n语境中的含义：${term.chinese}。`});
        const general = (prompt, right, wrong, explanation) => ({kind: 'comprehension', prompt, options: mix([{text: right, correct: true}, ...wrong.map(text => ({text, correct: false}))]), explanation});
        const main = general('What is the main purpose of this reading?', 'To explain connections between different parts of the water cycle.', ['To compare methods of removing salt from seawater.', 'To explain why groundwater follows only one fixed route.'], '正文追踪水在海洋、空气、土壤、植物和人类活动之间的不同路径。');
        const detail = general('According to the USGS passage, what supplies the energy that first lifts the drop from the ocean?', 'Heat from the Sun.', ['The roots of a crop.', 'An underground water pump.'], 'USGS 第二段描述太阳加热海面上的水滴，使水蒸发。');
        const inference = general('What can we infer about water used by people?', 'It can return to the environment and continue through the cycle.', ['It must remain permanently inside buildings.', 'It can never reach a river again.'], 'USGS 结尾说明水最终回到环境并继续循环。');
        const questions = [vocab(fresh[0]), main];
        if (minutes === 20) questions.push(detail);
        if (minutes === 45) {
            if (names.has('capacity')) {
                questions.push({kind: 'vocabulary', word: 'capacity', prompt: 'What does “capacity” mean when the passage describes a lake?', options: mix([
                    {text: 'the amount of water a lake can hold', chinese: '湖泊能够容纳的水量', correct: true},
                    {text: 'the rate at which water flows into a lake', chinese: '水流入湖泊的速率', correct: false},
                    {text: 'the length of time water stays in a lake', chinese: '水在湖泊中停留的时间', correct: false}
                ]), explanation: `${paragraphs[2].text}\ncapacity 在此表示容量；它与流速、停留时间不同。`});
            } else questions.push(vocab(fresh[1]));
            questions.push(detail, inference);
        }
        const newWords = fresh.map(t => t.word).filter(w => contains(text, w) && !names.has(w));
        if (covered.length < 4 || newWords.length < 2) throw Error('文章词汇覆盖不合格。');
        return {id: `water-v1-${hash(contentKey({paragraphs}))}`, title: 'A Drop of Water, a Connected World', origin: 'website', contentType: 'learning_adaptation', minutes, ...d, paragraphs, questions, terms, knownWords: covered, newWords, wordCount: wordCount(text), estimatedMinutes: Math.round(wordCount(text) / d.wpm), sources: bank.sources.filter(s => paragraphs.some(p => p.source === s.id))};
    }
    function validatePack(pack, cards, {checkEligibility = true} = {}) {
        if (!pack || !['website', 'input', 'user'].includes(pack.origin) || typeof pack.id !== 'string' || !/^[\w-]{1,100}$/.test(pack.id) || ![5, 20, 45].includes(pack.minutes) || ![0, 1, 2].includes(pack.level)) throw Error('阅读包基本字段不合格');
        if (!pack.title || !Array.isArray(pack.paragraphs) || pack.paragraphs.some(p => !p || typeof p.text !== 'string' || !p.text.trim())) throw Error('阅读正文不能为空');
        const text = pack.paragraphs.map(p => p.text).join('\n\n'), names = new Set(cards.map(c => normalize(c.word)));
        const known = [...names].filter(w => contains(text, w));
        if (!Array.isArray(pack.terms)) throw Error('阅读包需要 terms 候选词卡');
        pack.terms.forEach(validateTerm);
        if (new Set(pack.terms.map(t => t.word)).size !== pack.terms.length) throw Error('候选词卡重复');
        const fresh = pack.terms.filter(t => !names.has(t.word) && contains(text, t.word));
        if (checkEligibility && (known.length < 4 || fresh.length < 2)) throw Error('阅读包需要至少 4 个已收录词和 2 个未收录词');
        if (!Array.isArray(pack.questions) || pack.questions.length < 1 || pack.questions.length > 5 || !pack.questions.some(q => q.kind === 'vocabulary')) throw Error('需要 1–5 题并包含词义题');
        for (const q of pack.questions) {
            if (!['vocabulary', 'comprehension'].includes(q.kind) || !q.prompt || !q.explanation || !Array.isArray(q.options) || q.options.length < 3 || q.options.length > 4 || q.options.filter(o => o.correct === true).length !== 1 || q.options.some(o => typeof o.text !== 'string' || !o.text.trim() || typeof o.correct !== 'boolean') || new Set(q.options.map(o => o.text)).size !== q.options.length) throw Error('题目或选项不合格');
            if (q.kind === 'vocabulary' && (!contains(text, q.word || '') || !pack.terms.some(t => t.word === q.word) && !names.has(q.word))) throw Error('词义题缺少正文语境或完整词卡');
        }
        const count = wordCount(text), wpm = difficulty(cards.length).wpm;
        if (checkEligibility && Math.abs(count / wpm - pack.minutes) > pack.minutes * 0.2) throw Error('正文长度与档位不匹配');
        if (!Array.isArray(pack.sources) || !pack.sources.length || pack.sources.some(s => !s.title || !/^https:\/\//.test(s.url) && pack.origin === 'website')) throw Error('缺少可核对来源');
        return {...pack, knownWords: known, newWords: fresh.map(t => t.word), wordCount: count, estimatedMinutes: Math.round(count / wpm), wpm, label: difficulty(cards.length).label, support: difficulty(cards.length).support};
    }
    function validateTerm(term) {
        for (const field of ['word', 'uk', 'us', 'pos', 'chinese', 'english', 'example', 'translation', 'source']) if (typeof term[field] !== 'string' || !term[field].trim() || term[field].length > 2000) throw Error('候选词卡缺少字段：' + field);
        if (normalize(term.word) !== term.word || !/^[a-z]+(?:[ -][a-z]+)*$/.test(term.word) || !contains(term.example, term.word) || !/^https:\/\//.test(term.source)) throw Error('候选词卡格式不合格');
    }
    const api = {normalize, contains, wordCount, difficulty, hash, contentKey, makeReading, validatePack, validateTerm};
    if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ReadingEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
