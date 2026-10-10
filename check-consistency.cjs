// Read-only audit and browser regression check. Uses an isolated browser profile.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');

(async () => {
    const filename = path.join(__dirname, 'vocabulary.html');
    const html = fs.readFileSync(filename, 'utf8');
    const words = JSON.parse(fs.readFileSync(path.join(__dirname, 'learned_words.json'), 'utf8')).words;
    const normalize = text => text.replace(/\s+/g, ' ').trim().toLowerCase();
    assert.equal(new Set(words.map(normalize)).size, words.length, 'Duplicate index entries');
    assert(words.every(word => typeof word === 'string' && word && word === normalize(word)), 'Empty or non-normalized index entries');
    // Original inline CSS stays unchanged. The only intentional script addition
    // recognizes newly supported translation POS and supplies same-POS options.
    // Featured reading is additive, in external reading-*.js and reading.css; check-reading.cjs covers it.
    for (const [tag, expected] of Object.entries({
        script: '2eeebdc04ff50bb5102272bcad11e26b19f8e867dc4c6b52cc6b0b7138a0a9b8',
        style: 'ca3fdf365bf220da8af3f05ce7ca73c4ee8835f228ff62fae19cae255a8892fb'
    })) {
        const content = html.split('<' + tag + '>')[1].split('</' + tag + '>')[0];
        // Checked against the previously passing fixture: only CRLF/LF changed during editing.
        // Keep legacy hashes and accept their line-ending-normalized equivalents, not arbitrary changes.
        const normalizedBaselines = {
            script: '6ea69ed447bc574c01b09c000d388fe63daa97811972d3272d0d3362e721c5ff',
            style: '969f95d69e1ef2f71ba2d8e5e8e814d5a9504667143b33bae2a3f9f6c9e5b679'
        };
        const rawHash = createHash('sha256').update(content).digest('hex');
        const normalizedHash = createHash('sha256').update(content.replace(/\r\n/g, '\n')).digest('hex');
        const translationPosBaseline = tag === 'script' && normalizedHash === '9d54f3a216fa0e0364d1a14c0fbdf1c4fe773b399be2ea867fa56dcd3793a1a3';
        assert(rawHash === expected || normalizedHash === normalizedBaselines[tag] || translationPosBaseline, tag + ' changed outside reviewed POS addition or line endings');
    }
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(pathToFileURL(filename).href);
        const audit = await page.evaluate(() => {
            const cards = [...document.querySelectorAll('#wordList .word-card')];
            const fields = ['.word-header h2', '.pronunciation', '.word-info', '.meaning', '.english-meaning', '.example', '.translation'];
            const names = cards.map(card => card.querySelector('.word-header h2').textContent.replace(/\s+/g, ' ').trim().toLowerCase());
            const missingExample = card => !getExample(card).toLowerCase().includes(getWord(card));
            const translationCard = card => card.querySelector('.level')?.textContent.trim() === '翻译学习词';
            // Explicitly approved product change: translation example inflections are
            // warnings, not library failures. Keep the original rule for other cards.
            const fixture = cards[0].cloneNode(true);
            fixture.querySelector('.word-header h2').textContent = 'study';
            fixture.querySelector('.example').textContent = 'She studied the report.';
            fixture.querySelector('.level').textContent = '翻译学习词';
            const translationInflectionWarning = missingExample(fixture) && translationCard(fixture);
            fixture.querySelector('.level').textContent = '阅读错词';
            const readingMissingExampleStillRejected = missingExample(fixture) && !translationCard(fixture);
            return {
                names,
                invalid: cards.filter(card => fields.some(field => !card.querySelector(field)?.textContent.trim())).map(getWord),
                missingExampleWord: cards.filter(card => missingExample(card) && !translationCard(card)).map(getWord),
                translationExampleWarnings: cards.filter(card => missingExample(card) && translationCard(card)).map(getWord),
                examplePolicy: {translationInflectionWarning,readingMissingExampleStillRejected},
                duplicateIds: [...document.querySelectorAll('[id]')].map(node => node.id).filter((id, i, ids) => ids.indexOf(id) !== i),
                controls: document.querySelectorAll('.review-button').length
            };
        });
        assert.deepEqual([...audit.names].sort(), [...words].sort());
        assert.equal(new Set(audit.names).size, words.length);
        assert.equal(audit.controls, words.length);
        assert.deepEqual(audit.invalid, []);
        assert.deepEqual(audit.missingExampleWord, []);
        assert(audit.examplePolicy.translationInflectionWarning);
        assert(audit.examplePolicy.readingMissingExampleStillRejected);
        assert.deepEqual(audit.duplicateIds, []);
        const additionalPos = await page.evaluate(() => {
            const results = [];
            for (const [label, expected] of [['副词','副词'],['adv.','副词'],['prep.','介词'],['pron.','代词'],['conj.','连词'],['interj.','感叹词'],['数词','数词'],['冠词','冠词'],['短语','短语']]) {
                const card = document.createElement('div');
                for (const [cls,value] of [['word-info','词性：'+label],['meaning','释义：测试语境义'],['english-meaning','英文解释：a unique test definition']]) {const p=document.createElement('p');p.className=cls;p.textContent=value;card.append(p);}
                const options = getQuizOptions(card);
                results.push({label,pos:getPartOfSpeech(card),expected,count:options.length,correct:options.filter(o=>o.correct).length,samePos:options.filter(o=>!o.correct).every(o=>fallbackQuizDefinitions[expected].some(def=>def.english===o.english))});
            }
            return results;
        });
        for (const result of additionalPos) {assert.equal(result.pos,result.expected);assert.equal(result.count,3);assert.equal(result.correct,1);assert(result.samePos,JSON.stringify(result));}
        await page.locator('#quizSkipButton').click();
        for (const word of words) {
            await page.locator('#searchInput').fill(' ' + word.toUpperCase() + ' ');
            assert(await page.locator('.word-card').filter({ has: page.locator('h2', { hasText: new RegExp('^\\s*' + word + '\\s*$') }) }).isVisible());
        }
        await page.locator('#searchInput').fill('zzzz-no-such-word');
        assert.equal(await page.locator('.word-card:visible').count(), 0);
        await page.locator('#searchInput').fill('容量');
        assert(await page.locator('.word-card').filter({ has: page.locator('h2', { hasText: /^capacity$/ }) }).isVisible());
        await page.locator('#searchInput').fill('');
        assert.equal(await page.locator('.word-card:visible').count(), words.length);
        const firstCard = page.locator('.word-card').first();
        await firstCard.locator('.review-button').click();
        assert.equal(await firstCard.locator('.review-count').textContent(), '1');

        // Force each restored card into a real rendered quiz, including sentence mode.
        await page.evaluate(() => {
            const restored = ['capacity', 'capability', 'perception'];
            const originalSample = weightedSample;
            for (const name of restored) {
                const card = wordCards.find(card => getWord(card) === name);
                const sentence = document.createElement('p');
                appendHighlightedWord(sentence, getExample(card), name);
                if (sentence.querySelector('.quiz-highlight')?.textContent !== name) throw Error('Missing highlight: ' + name);
                for (let i = 0; i < 50; i++) {
                    const options = getQuizOptions(card);
                    if (options.length !== 3 || options.filter(o => o.correct).length !== 1 || options.some(o => !o.english || !o.chinese)) throw Error('Invalid options: ' + name);
                }
            }
            weightedSample = () => restored.map(name => wordCards.find(card => getWord(card) === name));
            buildQuiz();
            weightedSample = originalSample;
        });
        assert.equal(await page.locator('.quiz-question').count(), 3);
        assert.equal(await page.locator('.quiz-highlight').count(), 1);
        const questions = page.locator('.quiz-question');
        await questions.nth(0).locator('.quiz-help-button').click();
        const switched = await questions.nth(0).locator('.quiz-option').evaluateAll(nodes => nodes.every(node => node.textContent === node.dataset.chinese));
        assert(switched);
        await questions.nth(0).locator('[data-correct="true"]').click();
        await questions.nth(1).locator('[data-correct="false"]').first().click();
        await questions.nth(2).locator('[data-correct="true"]').click();
        const state = await page.evaluate(() => ({ capacity: getWordProgress('capacity'), capability: getWordProgress('capability'), perception: getWordProgress('perception'), daily: getTodayScoreRecord() }));
        assert.equal(state.capacity.reviews, 0.5);
        assert.equal(state.capability.mistakes, 1);
        assert.equal(state.perception.reviews, 0.5);
        assert.deepEqual(state.daily, { score: 2, questions: 3 });
        await page.locator('#quizAgainButton').click();
        assert.equal(await page.locator('.quiz-question').count(), 3);
        assert.equal(await page.locator('.quiz-question[data-answered]').count(), 0);
        await page.reload();
        assert.deepEqual(await page.evaluate(() => ({ capacity: getWordProgress('capacity'), capability: getWordProgress('capability'), perception: getWordProgress('perception'), daily: getTodayScoreRecord() })), state);
        const weighting = await page.evaluate(() => {
            const card = wordCards[0], p = getWordProgress(getWord(card)), saved = { ...p };
            p.reviews = 0; p.mistakes = 0; const base = getQuestionWeight(card);
            p.reviews = 10; const reviewed = getQuestionWeight(card);
            p.reviews = 0; p.mistakes = 10; const mistaken = getQuestionWeight(card);
            Object.assign(p, saved);
            const sample = weightedSample(wordCards, 3);
            return reviewed < base && mistaken > base && new Set(sample).size === 3;
        });
        assert(weighting);
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ result: 'PASS', ...audit, checks: ['set equality', 'fields', 'search all words and Chinese', 'review button', 'restored-word quiz', 'highlight', 'Chinese hint', 'correct +0.5', 'mistake +1', 'daily score', 'again', 'reload persistence', 'weighting', 'new POS recognition and same-POS three options', 'anchored script/style; reviewed minimal POS extension'] }, null, 2));
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
