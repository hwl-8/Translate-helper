(function () {
    'use strict';
    const engine = window.ReadingEngine;
    const bank = window.ReadingBank;
    const dialog = document.getElementById('readingDialog');
    const body = document.getElementById('readingBody');
    const trigger = document.getElementById('readingTrigger');
    const levels = document.getElementById('readingLevels');
    const storageKey = 'cet6FeaturedReadingV1';
    const api = location.protocol === 'file:' ? 'http://127.0.0.1:47831' : location.origin;
    let state = {answers: {}, pending: []}, token, supplements = [], materials = [], warnings = [], generationSettings, current, lastButton = trigger;
    let activeMinutes = 5, online = false, generating = false, openVersion = 0, selectionNotice = '', inventoryCount = 0;
    try { const saved = JSON.parse(localStorage.getItem(storageKey)); if (saved && saved.answers && Array.isArray(saved.pending)) state = saved; } catch (_) { /* Corrupt reading state does not reset vocabulary progress. */ }
    const node = (tag, text, className) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (className) n.className = className; return n; };
    function persist() {
        try { localStorage.setItem(storageKey, JSON.stringify(state)); return true; }
        catch (_) { showStatus('浏览器禁止保存记录；本次结果仅在当前页面有效。', true); return false; }
    }
    // Persist the answer and pending word before touching the two existing learning stores.
    // Absolute targets make recovery after an interrupted write idempotent.
    function recoverAnswer() {
        const journal = state.answerJournal;
        if (!journal) return;
        dailyScores[journal.day] = journal.daily;
        localStorage.setItem(dailyScoreStorageKey, JSON.stringify(dailyScores));
        if (journal.word) {
            progress[journal.word] = journal.progress;
            localStorage.setItem(progressStorageKey, JSON.stringify(progress));
            const card = wordCards.find(c => getWord(c) === journal.word); if (card) updateCardCounts(card);
        }
        updateDailyScoreDisplay();
        delete state.answerJournal;
        localStorage.setItem(storageKey, JSON.stringify(state));
    }
    try { recoverAnswer(); } catch (_) { /* Retain the durable journal for the next attempt. */ }
    async function commitAnswer(key, q, option, legacyKey) {
        const commit = () => {
            const stored = JSON.parse(localStorage.getItem(storageKey) || 'null');
            if (stored?.answers && Array.isArray(stored.pending)) state = stored;
            recoverAnswer();
            if (state.answers[key] || state.answers[legacyKey]) {
                state.answers[key] = state.answers[key] || state.answers[legacyKey];
                localStorage.setItem(storageKey, JSON.stringify(state));
                return false;
            }
            dailyScores = JSON.parse(localStorage.getItem(dailyScoreStorageKey) || '{}');
            progress = JSON.parse(localStorage.getItem(progressStorageKey) || '{}');
            const day = getTodayKey(), daily = {...getTodayScoreRecord()};
            daily.score += option.correct ? 1 : 0; daily.questions += 1;
            const journal = {day, daily};
            if (q.kind === 'vocabulary') {
                const next = {...getWordProgress(q.word)};
                if (option.correct) next.reviews += .5; else next.mistakes += 1;
                Object.assign(journal, {word: q.word, progress: next});
                if (!option.correct && !wordCards.some(c => getWord(c) === q.word) && !state.pending.includes(q.word)) state.pending.push(q.word);
            }
            state.answers[key] = {choice: option.text, correct: !!option.correct};
            state.answerJournal = journal;
            localStorage.setItem(storageKey, JSON.stringify(state));
            recoverAnswer();
            return true;
        };
        if (navigator.locks) return navigator.locks.request('cet6-reading-answer', commit);
        return commit();
    }
    function showStatus(message, error = false) { const status = body.querySelector('.reading-status'); if (status) { status.textContent = message; status.classList.toggle('reading-error', error); } }
    function updateRetryButton() {
        const retry = body.querySelector('.reading-retry');
        if (!retry) return;
        retry.disabled = !state.pending.length;
        retry.title = state.pending.length ? '重试保存待写入的错词' : '当前没有待写入的错词';
    }
    function cards() { return Array.from(document.querySelectorAll('#wordList .word-card')).map(card => ({word: getWord(card), pos: getPartOfSpeech(card), english: getEnglishMeaning(card), chinese: getMeaning(card)})); }
    async function connect() {
        const response = await fetch(api + '/api/reading', {signal: AbortSignal.timeout(2500)});
        if (!response.ok) throw Error('服务连接失败');
        const result = await response.json(); token = result.token; supplements = result.supplements || []; materials = result.materials || []; warnings = result.warnings || []; generationSettings = result.generation; online = true;
        if (!generating && !document.querySelector('#readingGeneratorBody form')) renderGenerator();
    }
    let flushing;
    async function flushPending() {
        if (flushing) return flushing;
        flushing = (async () => {
            try {
                await connect();
                for (const word of [...state.pending]) {
                    const response = await fetch(api + '/api/words', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Reading-Token': token}, body: JSON.stringify({word}), signal: AbortSignal.timeout(5000)});
                    const result = await response.json();
                    if (!response.ok) throw Error(result.error || '词卡写入失败');
                    if (!wordCards.some(card => getWord(card) === word)) {
                        const template = document.createElement('template'); template.innerHTML = result.html;
                        const card = template.content.querySelector('.word-card');
                        if (!card || getWord(card) !== word) throw Error('返回的词卡不完整');
                        document.getElementById('wordList').appendChild(card); wordCards.push(card); addReviewControls(card);
                        searchInput.dispatchEvent(new Event('input'));
                    }
                    const card = wordCards.find(c => getWord(c) === word); if (card) updateCardCounts(card);
                    state.pending = state.pending.filter(w => w !== word); persist();
                    showStatus(`“${word}”已保存到正式词库，索引已同步（${result.count} 词）。`);
                    updateRetryButton();
                }
            } catch (error) {
                if (state.pending.length) showStatus(`有 ${state.pending.length} 个错词待写入。请双击“启动词库.cmd”，再点“重试保存”。${error.message}`, true);
            } finally { flushing = null; }
        })();
        return flushing;
    }
    trigger.addEventListener('click', () => { trigger.hidden = true; levels.hidden = false; trigger.setAttribute('aria-expanded', 'true'); levels.querySelector('button').focus(); });
    levels.addEventListener('keydown', event => { if (event.key === 'Escape') { levels.hidden = true; trigger.hidden = false; trigger.setAttribute('aria-expanded', 'false'); trigger.focus(); } });
    levels.querySelectorAll('button').forEach(button => button.addEventListener('click', () => { lastButton = button; openReading(Number(button.dataset.minutes)); }));
    document.getElementById('readingClose').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { document.body.style.overflow = ''; lastButton.focus(); });
    function highlight(paragraph, words, fresh) {
        const pattern = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length).join('|');
        if (!pattern) return node('p', paragraph);
        const p = node('p'); let last = 0;
        for (const match of paragraph.matchAll(new RegExp('(?<![a-z])(' + pattern + ')(?![a-z])', 'gi'))) {
            p.append(document.createTextNode(paragraph.slice(last, match.index)));
            p.append(node('mark', match[0], fresh.includes(match[0].toLowerCase()) ? 'new-word' : ''));
            last = match.index + match[0].length;
        }
        p.append(document.createTextNode(paragraph.slice(last))); return p;
    }
    function pickReading(minutes, avoidId = '') {
        const library = cards(), level = engine.difficulty(library.length).level;
        const eligible = packs => packs.filter(p => p.minutes === minutes && p.level === level).flatMap(p => { try { return [engine.validatePack(p, library)]; } catch (_) { return []; } });
        let candidates = eligible(materials);
        selectionNotice = '';
        if (!candidates.length) {
            candidates = eligible(supplements);
            try { candidates.push(engine.makeReading(bank, window.ReadingNASA, library, minutes)); } catch (_) { /* Explain an empty pool below. */ }
            selectionNotice = online ? '资料库中暂无适合当前档位与词库的文章，已使用预置材料。可通过“补充资料”增加文章。' : '本地服务未连接，暂时使用预置材料。请双击“启动词库.cmd”以读取资料库和保存错词。';
        }
        const unique = new Map();
        for (const pack of candidates) if (!unique.has(engine.contentKey(pack))) unique.set(engine.contentKey(pack), pack);
        const duplicateCount = candidates.length - unique.size;
        candidates = [...unique.values()];
        inventoryCount = candidates.length;
        selectionNotice += ` 当前档位有 ${inventoryCount} 篇不同正文可读。`;
        if (duplicateCount) selectionNotice += ` ${duplicateCount} 份相同正文已合并，不算新文章。`;
        // Exclude the last article before the 80/20 source draw, even across close/reopen.
        const previous = avoidId || state.lastRead?.[`${minutes}:${level}`];
        const previousContent = state.lastContent?.[`${minutes}:${level}`];
        const alternatives = candidates.filter(p => p.id !== previous && engine.hash(engine.contentKey(p)) !== previousContent);
        if (alternatives.length) candidates = alternatives;
        else if (candidates.length === 1 && previous === candidates[0].id) selectionNotice += ' 当前只有这一篇合格文章，暂时无法换新。';
        const primary = candidates.filter(p => p.origin === 'website'), secondary = candidates.filter(p => p.origin !== 'website');
        const pool = secondary.length && (!primary.length || Math.random() < 0.2) ? secondary : primary;
        if (!pool.length) throw Error('当前没有满足时长、难度及“4 个已收录词＋2 个新词”的文章。请补充资料，或尝试其他档位。');
        const selected = pool[Math.floor(Math.random() * pool.length)];
        if (!state.lastRead || typeof state.lastRead !== 'object') state.lastRead = {};
        state.lastRead[`${minutes}:${level}`] = selected.id; persist();
        if (!state.lastContent || typeof state.lastContent !== 'object') state.lastContent = {};
        state.lastContent[`${minutes}:${level}`] = engine.hash(engine.contentKey(selected)); persist();
        return selected;
    }
    async function openReading(minutes, avoidId = '') {
        const version = ++openVersion; activeMinutes = minutes;
        current = null;
        body.replaceChildren(node('p', '正在匹配词库与阅读材料……'));
        if (!dialog.open) dialog.showModal(); document.body.style.overflow = 'hidden';
        try { await connect(); } catch (_) { online = false; materials = []; supplements = []; warnings = []; generationSettings = null; }
        if (version !== openVersion) return;
        if (!generating) renderGenerator();
        try { current = pickReading(minutes, avoidId); render(current, online); if (state.pending.length) flushPending(); }
        catch (error) { body.replaceChildren(node('h2', '暂时没有匹配的短文'), node('p', error.message)); if (!online) body.append(node('p', '本地服务未连接，请双击“启动词库.cmd”后重试。', 'reading-notice')); renderWarnings(); }
    }
    function renderWarnings() {
        if (!warnings.length) return;
        const details = node('details', null, 'reading-notice'); details.append(node('summary', `有 ${warnings.length} 项材料未使用，查看原因`));
        warnings.forEach(item => details.append(node('p', `${item.file}：${item.reason}`)));
        body.append(details);
    }
    function render(reading, online) {
        body.replaceChildren(node('h2', reading.title));
        const meta = node('div', null, 'reading-meta');
        [`${reading.minutes}min 档 · 约 ${reading.estimatedMinutes} 分钟`, `${reading.wordCount} 词 · 精读 ${reading.wpm} 词/分钟`, `${cards().length} 张词卡 · ${reading.label}`, `${reading.knownWords.length} 个已收录词 · 至少 ${reading.newWords.length} 个新词`].forEach(t => meta.append(node('span', t)));
        if (reading.reviewStatus === 'approved') meta.append(node('span', '已人工审核'));
        body.append(meta);
        if (selectionNotice) body.append(node('p', selectionNotice, 'reading-notice'));
        renderWarnings();
        body.append(node('p', '绿色为词库词，黄色为本次重点新词。问题位于文末。耗时按英语学习者精读估算，不含答题。', 'reading-notice'));
        const sources = node('details', null, 'reading-sources');
        sources.append(node('summary', '来源与改写说明（展开核对）'));
        sources.append(node('p', reading.paragraphs.some(p => p.contentType) ? '来源与材料说明；学习改写不等同于网站原文。' : '来源选编 + 自编学习导读；历史材料中的日期和任务状态按原文保留。'));
        for (const source of reading.sources) {
            const a = node('a', source.title + (source.date ? ` · ${source.date}` : '')); if (/^https:\/\//.test(source.url || '')) { a.href = source.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
            sources.append(a, node('br'));
        }
        body.append(sources);
        if (reading.support) {
            const water = reading.id.startsWith('water-v1-');
            const hint = reading.supportHint || (water
                ? (reading.level === 0 ? '阅读提示：先找每段的主语与动作，再追踪水去了哪里。atmosphere＝大气；vapour/vapor＝水蒸气；groundwater＝地下水；droplet＝小液滴。词义题请结合前后句判断。' : '阅读提示：区分“水存在哪里”和“水怎样移动”。留意因果连接词与文章证据，避免把一次观察当作完整结论。')
                : '阅读提示：先找主题句，再区分主要观点和具体例子。词义题可结合前后句的解释、对比或动作推断，理解题回到正文寻找证据。');
            const support = node('details', null, 'reading-glossary');
            support.append(node('summary', '阅读提示与背景术语（需要时展开）'), node('p', hint));
            body.append(support);
        }
        const prose = node('article', null, 'reading-prose'); let lastSource;
        const navigation = node('nav', null, 'reading-tools reading-navigation');
        const jump = node('button', '去答题'); jump.addEventListener('click', () => body.querySelector('.reading-questions')?.scrollIntoView({block: 'start'}));
        const supply = node('button', '补充资料 / 审核'); supply.addEventListener('click', () => { const generator = document.getElementById('readingGenerator'); generator.open = true; generator.scrollIntoView({block: 'start'}); });
        navigation.append(jump, supply); body.append(navigation);
        for (const paragraph of reading.paragraphs) {
            const sourceKey = paragraph.source + ':' + (paragraph.contentType || '');
            if (sourceKey !== lastSource) { const label = ({learning_adaptation: '学习改写', original_excerpt: '原文摘录', user_input: '用户提供原文'})[paragraph.contentType] || (paragraph.source === 'guide' ? '学习导读 · 自编' : paragraph.source === 'usgs' ? 'USGS · 原文选编（修正明显笔误）' : paragraph.source === 'nasa' ? 'NASA · 原文选编（2010）' : '阅读正文'); prose.append(node('div', label, 'source-label')); lastSource = sourceKey; }
            prose.append(highlight(paragraph.text, [...reading.knownWords, ...reading.newWords], reading.newWords));
        }
        body.append(prose);
        const section = node('section', null, 'reading-questions'); section.append(node('h3', `读后练习 · ${reading.questions.length} 题`));
        section.append(node('p', '每题答对得 1 分；只有词义题更新复习／答错次数。答错的新词自动保存为正式词卡。', 'reading-notice'));
        reading.questions.forEach((q, i) => section.append(renderQuestion(reading, q, i)));
        body.append(section);
        const status = node('p', online ? '本地服务已连接，阅读错词可自动写入正式词库。' : '当前可阅读与答题。自动保存新词需要双击“启动词库.cmd”；失败的保存会保留在待写入队列。', 'reading-status'); status.setAttribute('role', 'status'); body.append(status);
        const tools = node('div', null, 'reading-tools');
        const again = node('button', '换一组阅读'); again.addEventListener('click', () => openReading(reading.minutes, reading.id));
        if (inventoryCount < 2) { again.disabled = true; again.title = '当前只有这一篇不同正文。请通过补充资料 / 审核增加库存。'; }
        const retry = node('button', '重试保存', 'reading-retry'); retry.disabled = !state.pending.length; retry.title = state.pending.length ? '重试保存待写入的错词' : '当前没有待写入的错词'; retry.addEventListener('click', () => { if (state.pending.length) flushPending(); else showStatus('当前没有待写入的错词。'); });
        const close = node('button', '返回词库'); close.addEventListener('click', () => dialog.close());
        tools.append(again, retry, close); body.append(tools); updateRetryButton(); dialog.scrollTop = 0;
    }
    function renderQuestion(reading, q, i) {
        const article = node('div', null, 'reading-question'); article.dataset.kind = q.kind; if (q.word) article.dataset.word = q.word;
        article.append(node('h3', `${i + 1}. ${q.kind === 'vocabulary' ? '词义猜测 · ' : ''}${q.prompt}`));
        const legacyKey = reading.id + ':' + engine.hash(q.prompt);
        const key = 'content:' + engine.hash(engine.contentKey(reading)) + ':' + engine.hash(q.prompt);
        const saved = state.answers[key] || state.answers[legacyKey];
        if (saved && !state.answers[key]) { state.answers[key] = saved; persist(); }
        let answered = !!saved;
        const options = node('div');
        const explanation = node('p', null, 'reading-explanation');
        const buttons = q.options.map(option => {
            const button = node('button', option.text, 'quiz-option'); button.type = 'button'; button.dataset.correct = String(!!option.correct);
            button.addEventListener('click', async () => {
                if (answered) return; answered = true;
                try {
                    await commitAnswer(key, q, option, legacyKey);
                    reveal(state.answers[key].choice); updateRetryButton();
                    if (state.pending.length) flushPending();
                } catch (_) {
                    answered = false;
                    showStatus('答题记录未能完整保存，请允许此页面使用浏览器本地存储后重试；已保存的结果会恢复，不会重复计分。', true);
                }
            });
            options.append(button); return button;
        });
        const help = node('button', '中文提示', 'reading-help'); help.type = 'button';
        help.addEventListener('click', () => { q.options.forEach((o, n) => { if (o.chinese) buttons[n].textContent = o.chinese; }); help.disabled = true; });
        if (q.kind === 'vocabulary' && q.options.every(o => o.chinese)) article.append(help);
        function reveal(choice) {
            buttons.forEach((b, n) => { b.disabled = true; if (q.options[n].correct) b.classList.add('correct'); else if (q.options[n].text === choice) b.classList.add('wrong'); });
            help.disabled = true; explanation.textContent = ((state.answers[key] || state.answers[legacyKey])?.correct ? '本题已答对。\n' : '本题已答错。\n') + q.explanation;
        }
        article.append(options, explanation); if (saved) reveal(saved.choice); return article;
    }
    function renderGenerator() {
        const host = document.getElementById('readingGeneratorBody');
        if (!host || generating) return;
        host.replaceChildren();
        const review = node('details', null, 'reading-review');
        review.append(node('summary', '资料审核与库存'));
        const reviewBody = node('div', null, 'reading-review-body'); review.append(reviewBody); host.append(review);
        review.addEventListener('toggle', () => { if (review.open) loadReview(reviewBody); });
        if (!online || !generationSettings) { host.append(node('p', online ? '生成服务尚未配置，本地阅读不受影响。' : '请先双击“启动词库.cmd”，再重新打开阅读窗口。', 'reading-notice')); return; }
        const form = document.createElement('form');
        const field = (labelText, control, wide = false) => { const label = node('label', labelText, wide ? 'reading-generation-wide' : ''); control.setAttribute('aria-label', labelText); label.append(control); form.append(label); return control; };
        const search = field('检索服务', document.createElement('select'));
        for (const provider of ['tavily']) { const option = document.createElement('option'); option.value = provider; option.textContent = `Tavily${generationSettings.search.providers[provider].configured ? '' : '（未配置）'}`; option.disabled = !generationSettings.search.providers[provider].configured; search.append(option); }
        const firstSearch = Array.from(search.options).find(option => !option.disabled); if (firstSearch) search.value = firstSearch.value;
        const provider = field('模型供应商', document.createElement('select'));
        for (const name of ['deepseek']) { const option = document.createElement('option'); option.value = name; option.textContent = `DeepSeek${generationSettings.models.providers[name].configured ? '' : '（未配置）'}`; option.disabled = !generationSettings.models.providers[name].configured; provider.append(option); }
        const firstProvider = Array.from(provider.options).find(option => !option.disabled); if (firstProvider) provider.value = firstProvider.value;
        const model = field('模型', document.createElement('select'));
        const refillModels = () => { model.replaceChildren(); const setting = generationSettings.models.providers[provider.value]; for (const name of setting?.models || []) { const option = document.createElement('option'); option.value = name; option.textContent = name; option.selected = name === setting.defaultModel; model.append(option); } };
        provider.addEventListener('change', refillModels); refillModels();
        const minutes = field('阅读档位', document.createElement('select')); for (const value of [5, 20, 45]) { const option = document.createElement('option'); option.value = value; option.textContent = `${value} min`; minutes.append(option); }
        minutes.value = String(activeMinutes);
        const count = field('生成篇数', document.createElement('select')); for (let value = 1; value <= generationSettings.limits.maxArticles; value++) { const option = document.createElement('option'); option.value = value; option.textContent = `${value} 篇`; count.append(option); }
        const queries = field(`英文检索词（每行一条，最多 ${generationSettings.limits.maxSearchRequests} 条）`, document.createElement('textarea'), true); queries.rows = 3; queries.placeholder = '例如：how cities adapt to extreme heat';
        const auxiliaryType = field('辅助材料类型（可选）', document.createElement('select')); for (const [value, label] of [['', '不添加'], ['input_file', 'input 文件内容'], ['user_input', '用户长文']]) { const option = document.createElement('option'); option.value = value; option.textContent = label; auxiliaryType.append(option); }
        const auxiliaryUrl = field('辅助材料来源链接（可选）', document.createElement('input')); auxiliaryUrl.type = 'url'; auxiliaryUrl.placeholder = 'https://...';
        const auxiliaryText = field('辅助材料正文（可选）', document.createElement('textarea'), true); auxiliaryText.rows = 4;
        const confirmLabel = node('label', null, 'reading-generation-confirm'); const confirm = document.createElement('input'); confirm.type = 'checkbox'; confirmLabel.append(confirm, document.createTextNode(' 我确认这次操作可能调用所选搜索与模型服务并产生费用；不会自动切换服务。')); form.append(confirmLabel);
        const submit = node('button', '检索并生成'); submit.type = 'submit';
        const status = node('p', generationSettings.enabled ? '选择供应商、档位和篇数后开始。仅点击生成才会联网，实际费用以服务商账单为准。' : '在线生成尚未启用，请先完成本地服务配置；已有文章可以正常阅读。', 'reading-generation-status reading-generation-wide'); status.setAttribute('role', 'status');
        const cleanupHost = node('div', null, 'reading-generation-wide');
        const configured = Boolean(firstSearch && firstProvider); submit.disabled = !generationSettings.enabled || !configured; form.append(submit, status, cleanupHost); host.append(form);
        if (!generationSettings.enabled) status.textContent = '在线生成未启用：在本机 .env 设置 READING_ALLOW_EXTERNAL_CALLS=true，再重新打开阅读窗口。';
        if (!configured) status.textContent = `请在本机 .env 配置 ${[!firstSearch && 'TAVILY_API_KEY', !firstProvider && 'DEEPSEEK_API_KEY'].filter(Boolean).join(' 和 ')}，再重新打开阅读窗口。不要把密钥粘贴到页面。`;
        const renderRetention = retention => {
            cleanupHost.replaceChildren();
            if (!retention) return;
            if (!retention.candidates?.length) {
                cleanupHost.append(node('p', `材料按档位和难度最多保留最近 ${retention.limit} 篇模型生成内容；本次没有可安全清理的候选。`, 'reading-notice'));
                return;
            }
            const details = node('details', null, 'reading-notice');
            details.append(node('summary', `有 ${retention.candidates.length} 篇旧模型材料可清理（需要确认）`));
            retention.candidates.forEach(item => details.append(node('p', `${item.title} · ${item.minutes}min`)));
            const remove = node('button', `确认清理 ${retention.candidates.length} 篇`); remove.type = 'button';
            remove.addEventListener('click', async () => {
                remove.disabled = true;
                status.classList.remove('reading-error'); status.textContent = '正在重新核对清理条件……';
                try {
                    const response = await fetch(api + '/api/materials/cleanup', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Reading-Token': token}, body: JSON.stringify({confirm: true, ids: retention.candidates.map(item => item.id), protectedMaterialIds: current ? [current.id] : [], hasPendingWords: state.pending.length > 0}), signal: AbortSignal.timeout(15000)});
                    const result = await response.json(); if (!response.ok) throw Error(result.error || '清理失败');
                    const failed = (result.failed?.length || 0) + (result.skipped?.length || 0);
                    status.textContent = `已清理 ${result.cleaned?.length || 0} 篇；${failed ? `${failed} 篇因状态变化或文件错误保留。` : '未影响当前文章、人工材料或学习记录。'}`;
                    await connect(); cleanupHost.replaceChildren();
                } catch (error) { status.textContent = `清理未完成：${error.message}。新材料仍可保留使用。`; status.classList.add('reading-error'); remove.disabled = false; }
            });
            details.append(remove); cleanupHost.append(details);
        };
        form.addEventListener('submit', async event => {
            event.preventDefault();
            const list = queries.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
            if (!confirm.checked) { status.textContent = '请先勾选费用确认。'; status.classList.add('reading-error'); return; }
            if (!list.length) { status.textContent = '请至少填写一条英文检索词。'; status.classList.add('reading-error'); return; }
            if (auxiliaryText.value.trim() && (!auxiliaryType.value || !/^https:\/\//i.test(auxiliaryUrl.value.trim()))) { status.textContent = '辅助正文需要选择类型并填写 HTTPS 来源链接。'; status.classList.add('reading-error'); return; }
            generating = true;
            const controls = Array.from(form.elements); controls.forEach(control => { control.disabled = true; });
            status.classList.remove('reading-error'); status.textContent = `DeepSeek · ${minutes.value}min · ${count.value} 篇：正在检索、整理和校验……`;
            try {
                const supplements = auxiliaryText.value.trim() ? [{title: auxiliaryType.value === 'input_file' ? '页面提供的 input 材料' : '页面提供的用户长文', url: auxiliaryUrl.value.trim(), date: '用户提供', sourceType: auxiliaryType.value, content: auxiliaryText.value}] : [];
                const response = await fetch(api + '/api/generate', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Reading-Token': token}, body: JSON.stringify({confirm: true, searchProvider: search.value, modelProvider: provider.value, model: model.value, minutes: Number(minutes.value), count: Number(count.value), queries: list, supplements, protectedMaterialIds: current ? [current.id] : [], hasPendingWords: state.pending.length > 0}), signal: AbortSignal.timeout(300000)});
                const result = await response.json();
                if (!response.ok) {
                    const phase = result.code === 'validation_failed' || result.code === 'invalid_draft' ? '内容校验失败' : result.code === 'save_failed' ? '本地保存失败' : '搜索或生成请求失败';
                    throw Error(`${phase}：${result.error || '请检查服务配置后重试'}`);
                }
                const cost = result.usage.cost.totalUsd == null ? '暂无金额估算' : `估算约 $${result.usage.cost.totalUsd.toFixed(4)}`;
                status.textContent = `已保存 ${result.files.length} 篇待人工审核的文章；${cost}，实际费用请以服务商账单为准。审核通过后才会进入随机阅读。`;
                review.open = true; await loadReview(reviewBody);
                renderRetention(result.retention);
            } catch (error) { status.textContent = `请求未完成：${error.message}。可在“资料审核与库存”检查是否已有部分文章保存；不要因等待超时立即重复提交。`; status.classList.add('reading-error'); review.open = true; await loadReview(reviewBody); }
            finally { generating = false; controls.forEach(control => { control.disabled = false; }); submit.disabled = !generationSettings?.enabled || !configured; }
        });
    }
    async function loadReview(host) {
        host.replaceChildren(node('p', '正在读取本地材料……', 'reading-notice'));
        try {
            const response = await fetch(api + '/api/materials/review', {signal: AbortSignal.timeout(5000)});
            const result = await response.json(); if (!response.ok) throw Error(result.error || '无法读取审核列表');
            token = result.token || token;
            host.replaceChildren(node('p', '先核对来源、正文、题目答案及候选词卡，再明确批准。预览不会计分或建卡。程序校验不能代替人工内容判断。', 'reading-notice'));
            const refresh = node('button', '刷新库存'); refresh.type = 'button'; refresh.addEventListener('click', () => loadReview(host)); host.append(refresh);
            if (!result.materials.length) host.append(node('p', '暂无可审核材料。可在下方补充资料；坏文件原因见本区底部。'));
            for (const entry of result.materials) {
                const {material, pack} = entry, meta = material.metadata;
                const detail = node('details', null, 'reading-review-item');
                detail.append(node('summary', `${meta.title} · ${meta.minutes}min · ${{pending:'待人工审核',approved:'已审核',rejected:'审核不通过'}[pack.reviewStatus]}`));
                detail.append(node('p', entry.eligibilityReason || '当前词库覆盖与长度合格；批准后可用于当前匹配档位。', entry.eligibilityReason ? 'reading-error' : 'reading-notice'));
                for (const source of meta.sources) {
                    const link = node('a', source.title); link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; detail.append(link, node('br'));
                }
                detail.append(node('p', meta.supportHint, 'reading-glossary'));
                const prose = node('div', null, 'reading-prose');
                for (const paragraph of material.article) { prose.append(node('small', {learning_adaptation:'学习改写',original_excerpt:'原文摘录',user_input:'用户提供原文'}[paragraph.contentType]), node('p', paragraph.text)); }
                detail.append(prose, node('h3', '题目、答案与解析'));
                for (const q of material.questions) {
                    detail.append(node('p', q.prompt));
                    q.options.forEach(o => detail.append(node('p', `${o.correct ? '✓ 正确答案：' : '干扰项：'}${o.text}${o.chinese ? ' / ' + o.chinese : ''}`)));
                    detail.append(node('p', q.explanation));
                }
                detail.append(node('h3', '候选词卡（不会自动收录）'));
                for (const c of material.candidateCards) {
                    detail.append(node('p', `${c.word} · ${c.pos} · 英 /${c.uk}/ 美 /${c.us}/\n${c.english}\n${c.chinese}\n${c.example}\n${c.translation}`, 'reading-explanation'));
                    const link = node('a', '核对释义和读音'); link.href = c.source; link.target = '_blank'; link.rel = 'noopener noreferrer'; detail.append(link);
                }
                const label = node('label', null, 'reading-review-confirm'); const confirm = document.createElement('input'); confirm.type = 'checkbox';
                label.append(confirm, document.createTextNode('我已核对来源、正文、答案及词卡内容')); detail.append(label);
                const status = node('p', null, 'reading-review-status'); status.setAttribute('role', 'status');
                const controls = node('div', null, 'reading-tools');
                for (const [value, text] of [['approved','审核通过'], ['rejected','审核不通过'], ['pending','退回待审核']]) {
                    const button = node('button', text); button.type = 'button';
                    button.addEventListener('click', async () => {
                        if (!confirm.checked) { status.textContent = '请先逐项核对并勾选确认。'; return; }
                        controls.querySelectorAll('button').forEach(b => {b.disabled = true;});
                        try {
                            const response = await fetch(api + '/api/materials/review', {method:'POST', headers:{'Content-Type':'application/json','X-Reading-Token':token}, body:JSON.stringify({id:meta.id, revision:entry.revision, status:value, confirm:true}), signal:AbortSignal.timeout(5000)});
                            const result = await response.json(); if (!response.ok) throw Error(result.error || '审核保存失败');
                            status.textContent = value === 'approved' ? '审核已保存。可点击“阅读这篇”开始；库存按当前词库重新检查。' : '状态已保存，本篇不会进入随机阅读。';
                            await connect();
                            if (value === 'approved') {
                                const read = node('button', '阅读这篇'); read.type = 'button';
                                read.addEventListener('click', async () => {
                                    await connect(); const match = materials.find(p => p.id === meta.id);
                                    try {
                                        if (!match || match.level !== engine.difficulty(cards().length).level) throw Error('当前难度或词汇资格不匹配，请选择其他文章。');
                                        current = engine.validatePack(match, cards()); activeMinutes = current.minutes;
                                        inventoryCount = new Set(materials.filter(p => p.minutes === current.minutes && p.level === current.level).map(engine.contentKey)).size;
                                        selectionNotice = '正在阅读刚审核的本地材料。'; render(current, true); document.getElementById('readingGenerator').open = false;
                                    } catch (error) { status.textContent = error.message; }
                                }); controls.append(read);
                            }
                        } catch (error) { status.textContent = `未保存：${error.message}。请刷新库存后重试。`; controls.querySelectorAll('button').forEach(b => {b.disabled = false;}); }
                    }); controls.append(button);
                }
                detail.append(controls, status); host.append(detail);
            }
            for (const item of result.skipped || []) host.append(node('p', `${item.file || item.filename}：${item.reason}`, 'reading-error'));
        } catch (error) { host.replaceChildren(node('p', `资料审核不可用：${error.message}。请启动或重启“启动词库.cmd”后重试。`, 'reading-error')); }
    }
    if (state.pending.length) flushPending();
    window.FeaturedReading = {open: openReading, pending: () => state.pending.slice(), current: () => current};
})();
