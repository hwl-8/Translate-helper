(function () {
    'use strict';
    const dialog = document.getElementById('translationDialog');
    const root = document.getElementById('translationBody');
    const trigger = document.getElementById('translationTrigger');
    const key = 'cet6TranslationHistoryV1';
    const api = location.protocol === 'file:' ? 'http://127.0.0.1:47831' : location.origin;
    const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
    let history = [], current = null, config, busy = false, importing = false, polling = false, pendingSubmission = null;
    let draft = {text: '', direction: 'en-zh', model: ''};
    try {
        const saved = JSON.parse(localStorage.getItem(key));
        if (saved && Array.isArray(saved.history)) { history = saved.history.slice(0, 10); draft = {...draft, ...saved.draft}; current = history.find(h => h.id === saved.currentId) || null; pendingSubmission = saved.pendingSubmission || null; }
    } catch (_) { /* Ignore damaged translation storage without changing learning records. */ }
    const form = el('form', null, 'translation-form');
    const intro = el('p', '粘贴英文或中文，按段对照阅读，再审核需要加入词库的候选词。仅调用 DeepSeek。', 'translation-intro');
    const textLabel = el('label', '待翻译文本');
    const input = el('textarea'); input.id = 'translationInput'; input.rows = 7; input.placeholder = '在这里粘贴文本…'; input.value = draft.text; textLabel.htmlFor = input.id;
    const meter = el('p', '', 'translation-meter');
    const options = el('div', null, 'translation-options');
    const direction = el('select'); direction.id = 'translationDirection';
    for (const [value, label] of [['en-zh', '英文 → 中文'], ['zh-en', '中文 → 英文']]) { const o = el('option', label); o.value = value; direction.append(o); }
    direction.value = draft.direction;
    const model = el('select'); model.id = 'translationModel';
    for (const [label, control] of [['翻译方向', direction], ['DeepSeek 模型', model]]) { const l = el('label', label); l.append(control); options.append(l); }
    const paid = el('input'); paid.type = 'checkbox'; paid.id = 'translationPaid';
    const consent = el('label', null, 'translation-check'); consent.append(paid, document.createTextNode('我确认将文本发送给 DeepSeek，并承担本次翻译或重试可能产生的费用。'));
    const submit = el('button', '开始翻译', 'translation-primary'); submit.type = 'submit'; submit.id = 'translationSubmit';
    const retry = el('button', '重试未完成部分'); retry.type = 'button'; retry.id = 'translationRetry'; retry.hidden = true;
    const actions = el('div', null, 'translation-actions'); actions.append(submit, retry);
    const status = el('p', '', 'translation-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const storageNotice = el('p', '', 'translation-error'); storageNotice.setAttribute('role', 'status');
    form.append(intro, textLabel, input, meter, options, consent, actions, status, storageNotice);
    const privacy = el('p', '隐私提示：原文、译文、候选词和选择会保存在当前浏览器，最多保留 10 条。共用设备请删除记录；服务端默认不记录原文。', 'translation-privacy');
    const results = el('section', null, 'translation-results'); results.id = 'translationResults';
    results.tabIndex = -1;
    const jump = el('button', '↓ 查看翻译结果与候选词'); jump.type = 'button'; jump.addEventListener('click', () => { results.scrollIntoView({behavior: 'smooth', block: 'start'}); results.focus({preventScroll: true}); }); actions.append(jump);
    const archive = el('section', null, 'translation-history'); archive.id = 'translationHistory';
    root.append(form, privacy, results, archive);
    function message(value, error = false) { status.textContent = value; status.classList.toggle('translation-error', error); }
    function persist() {
        draft = {text: input.value, direction: direction.value, model: model.value || draft.model};
        try { localStorage.setItem(key, JSON.stringify({history, draft, currentId: current?.id || null, pendingSubmission})); storageNotice.textContent = ''; }
        catch (_) { storageNotice.textContent = '浏览器无法保存翻译记录（存储已满或被禁用）。请保留当前页面并自行复制结果。'; }
    }
    function remember(job) {
        const existing = history.find(h => h.id === job.id);
        const entry = {...existing, ...job, selected: existing?.selected || {}, reviewed: existing?.reviewed || {}, expanded: existing?.expanded || {}, viewed: existing?.viewed || {}, reviewAll: existing?.reviewAll || false};
        // A regenerated card requires a fresh review even when its array position is unchanged.
        (entry.candidates || []).forEach((candidate, index) => {
            if (existing && JSON.stringify(existing.candidates?.[index]?.card) !== JSON.stringify(candidate.card)) {
                delete entry.selected[index]; delete entry.reviewed[index]; delete entry.viewed[index];
                entry.reviewAll = false;
            }
        });
        history = [entry, ...history.filter(h => h.id !== job.id)].slice(0, 10); current = entry; persist(); render();
    }
    function estimate() {
        const length = Array.from(input.value).length;
        let calls = '—';
        try { const normalized = window.TranslationInput.normalizeInput({type: 'text', text: input.value}); calls = (normalized.batches || normalized.chunks).length + 1; } catch (_) { /* Validation is shown on submission. */ }
        meter.textContent = `${length.toLocaleString()} / ${Math.min(config?.limits?.maxCharacters || 10000, 10000).toLocaleString()} 字符 · 预计 ${calls} 次模型调用（不含重试）`;
        meter.classList.toggle('translation-error', length > Math.min(config?.limits?.maxCharacters || 10000, 10000));
    }
    function controls() {
        const active = busy || current?.state === 'running';
        submit.disabled = active || importing || !config?.enabled || !config?.configured;
        retry.hidden = !current || !['partial', 'failed'].includes(current.state) || current.missing;
        retry.disabled = active || importing || !config?.enabled || !config?.configured;
        input.disabled = active; direction.disabled = active; model.disabled = active;
        submit.textContent = active ? '翻译进行中…' : '开始翻译';
    }
    async function connect() {
        const response = await fetch(api + '/api/translation/config', {signal: AbortSignal.timeout(6000)});
        if (!response.ok) throw Error('无法连接翻译服务，请运行“启动词库.cmd”。');
        config = await response.json();
        const selected = model.value || draft.model || config.defaultModel;
        model.replaceChildren();
        for (const item of config.models || []) { const value = typeof item === 'string' ? item : item.id || item.model || item.name; const o = el('option', typeof item === 'string' ? item : item.label || value); o.value = value; model.append(o); }
        model.value = Array.from(model.options).some(o => o.value === selected) ? selected : config.defaultModel;
        estimate(); controls();
        await revalidateCandidates(current);
        render(); persist();
        if (!config.enabled || !config.configured) message(configurationError(), true);
        return config;
    }
    function configurationError() {
        const issues = [];
        if (!config?.configured) issues.push('缺少 DEEPSEEK_API_KEY，请在本地 .env 中配置 DeepSeek 密钥');
        if (!config?.enabled) issues.push('TRANSLATION_ALLOW_EXTERNAL_CALLS 尚未设为 true，请在本地 .env 中开启翻译外部调用');
        return issues.join('；') + '。修改后请重启本地服务。';
    }
    function refreshKnown() {
        const known = new Set(config?.words || []);
        for (const entry of history) for (const candidate of entry.candidates || []) {
            const word = String(candidate.card?.word || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (known.has(word) || (typeof wordCards !== 'undefined' && wordCards.some(c => getWord(c) === word))) {
                candidate.exists = true;
                candidate.importStatus = candidate.importStatus === 'added' ? 'added' : 'exists';
                delete candidate.importError;
            }
        }
    }
    async function revalidateCandidates(entry) {
        if (!entry?.candidates?.length || entry.state === 'running') return;
        try {
            const englishText = entry.direction === 'en-zh' ? entry.input?.text || '' : (entry.paragraphs || []).map(p => p.translation || '').join('\n\n');
            const data = await request('/candidates/validate', {cards:entry.candidates.map(c => c.card),englishText}, true);
            if (!Array.isArray(data.candidates) || data.candidates.length !== entry.candidates.length) throw Error('本地校验返回不完整。');
            entry.candidates = entry.candidates.map((candidate,index) => ({...candidate,...data.candidates[index]}));
            delete entry.validationError;
            persist();
        } catch (_) {
            entry.validationError = '候选词未能按最新规则重新校验，暂保留原状态。请重启本地服务后重新打开这条历史；无需重新翻译或付费。';
        }
    }
    async function request(path, body, refreshed = false) {
        if (!config) await connect();
        const response = await fetch(api + '/api/translation' + path, {method: body ? 'POST' : 'GET', headers: {'Content-Type': 'application/json', 'X-Reading-Token': config.token}, ...(body ? {body: JSON.stringify(body)} : {}), signal: AbortSignal.timeout(20000)});
        if ((response.status === 401 || response.status === 403) && !refreshed) { await connect(); return request(path, body, true); }
        const data = await response.json().catch(() => ({}));
        if (!response.ok) { const e = Error(typeof data.error === 'string' ? data.error : data.error?.message || data.message || `请求失败（${response.status}）`); e.status = response.status; throw e; }
        return data;
    }
    async function poll() {
        if (polling || current?.state !== 'running') return;
        polling = true;
        const id = current.id;
        try {
            while (current?.id === id && current.state === 'running') {
                const job = await request('/jobs/' + encodeURIComponent(id)); remember(job);
                if (job.state !== 'running') break;
                await new Promise(resolve => setTimeout(resolve, 1200));
            }
        } catch (error) {
            if (error.status === 404 && current?.id === id) { current.state = 'failed'; current.missing = true; persist(); render(); message('服务重启后任务已失效。已保存的部分结果仍在；重新勾选费用确认并点击“开始翻译”可创建新任务。', true); }
            else { message('进度暂时无法获取，正在保留结果并稍后重连。' + error.message, true); setTimeout(poll, 4000); }
        } finally { polling = false; controls(); }
    }
    async function start(isRetry) {
        if (busy || importing || current?.state === 'running') return;
        message('');
        try {
            if (!paid.checked) throw Error('请先勾选本次费用确认。');
            if (Array.from(input.value).length > Math.min(config?.limits?.maxCharacters || 10000, 10000)) throw Error('文本最多 10000 个 Unicode 字符，包括空白和换行。');
            if (!window.TranslationInput) throw Error('文本处理模块尚未加载，请稍后重新打开页面。');
            const normalized = window.TranslationInput.normalizeInput({type: 'text', text: input.value});
            busy = true; controls(); renderHistory();
            await connect();
            if (!config.enabled || !config.configured) throw Error(configurationError());
            const path = isRetry ? '/jobs/' + encodeURIComponent(current.id) + '/retry' : '/jobs';
            const payload = isRetry ? {confirm:true} : {confirm:true,input:{type:'text',text:normalized.text},direction:direction.value,model:model.value};
            const fingerprint = JSON.stringify([path,payload]);
            const requestId = pendingSubmission?.fingerprint === fingerprint ? pendingSubmission.requestId : crypto.randomUUID();
            pendingSubmission = {fingerprint,requestId}; persist();
            const job = await request(path, {...payload,requestId}); pendingSubmission = null; paid.checked = false; remember(job); message('任务已提交，关闭弹窗后仍会继续获取并保存结果。');
        } catch (error) { message(error.name === 'TypeError' || error.name === 'TimeoutError' ? '无法取得本地翻译服务的响应。请检查启动窗口后原样重试；同一请求标识会复用已有任务，避免重复调用。' : error.message, true); }
        finally { busy = false; controls(); renderHistory(); }
        if (current?.state === 'running') poll();
    }
    function check(label, checked, change, disabled = false) {
        const l = el('label', null, 'translation-check'); const c = el('input'); c.type = 'checkbox'; c.checked = !!checked; c.disabled = disabled; c.addEventListener('change', () => change(c.checked)); l.append(c, document.createTextNode(label)); return l;
    }
    function field(parent, label, value) { const row = el('p'); row.append(el('strong', label + '：'), document.createTextNode(value == null ? '—' : String(value))); parent.append(row); }
    function render() {
        refreshKnown();
        results.replaceChildren(); controls(); renderHistory();
        if (!current) { results.append(el('p', '翻译结果将在这里按段展示。', 'translation-empty')); return; }
        const title = el('h3', '段落对照'); results.append(title);
        const back = el('button', '↑ 返回输入与费用确认'); back.type = 'button'; back.addEventListener('click', () => { form.scrollIntoView({behavior: 'smooth', block: 'start'}); input.focus({preventScroll: true}); }); results.append(back);
        const stateLabels = {running: '处理中', complete: '已完成', partial: '部分完成', failed: '未完成'};
        results.append(el('p', `${stateLabels[current.state] || current.state} · ${current.stage === 'candidates' ? '候选词整理' : '段落翻译'} · ${current.model || ''}`, 'translation-meter'));
        if (current.error) results.append(el('p', current.error.message || current.error.code, 'translation-error'));
        for (const warning of current.warnings || []) results.append(el('p', warning, 'translation-warning'));
        (current.paragraphs || []).forEach((p, index) => {
            const card = el('article', null, 'translation-paragraph'); const pair = el('div', null, 'translation-pair');
            for (const [label, content] of [['原文', p.original], ['译文', p.translation || (p.status === 'failed' ? '本段翻译失败，可重试。' : '等待翻译…')]]) { const col = el('div'); col.append(el('small', label), el('p', content)); pair.append(col); }
            card.append(pair);
            if (p.analyses?.length) { const details = el('details'); details.open = !!current.expanded['p' + index]; details.append(el('summary', `句子分析 · ${p.analyses.length}`)); for (const a of p.analyses) { const analysis = el('div', null, 'translation-analysis'); field(analysis, '句子', a.sentence); field(analysis, '分析', a.explanation); field(analysis, '词汇', a.vocabulary); details.append(analysis); } details.addEventListener('toggle', () => { current.expanded['p' + index] = details.open; persist(); }); card.append(details); }
            results.append(card);
        });
        const candidates = current.candidates || [];
        if (candidates.length) {
            results.append(el('h3', '候选词 · 人工审核后入库'), el('p', '模型草稿可能包含错误。请核对释义、音标、词性、例句和原文证据；展开详情不会调用模型。', 'translation-intro'));
            if (current.validationError) results.append(el('p', current.validationError, 'translation-warning'));
            const allReview = check('我已核对所有可导入候选词的完整卡片（请先逐张展开详情），确认音标、释义、例句与证据准确', current.reviewAll, value => { current.reviewAll = value; persist(); updateImport(); });
            allReview.querySelector('input').id = 'translationReviewAll'; results.append(allReview);
            candidates.forEach((candidate, index) => {
                const c = candidate.card || {}; const item = el('article', null, 'translation-candidate');
                const unavailable = !candidate.valid || candidate.exists;
                item.append(check(`${c.word || '无词名'} · ${c.pos || ''} · ${c.chinese || ''}`, current.selected[index], value => { current.selected[index] = value; persist(); updateImport(); }, unavailable || importing || current.state === 'running'));
                const details = el('details'); details.open = !!current.expanded['c' + index]; details.append(el('summary', '查看完整词卡与原文证据'));
                for (const [name, property] of [['词名', 'word'], ['英式音标', 'uk'], ['美式音标', 'us'], ['词性', 'pos'], ['中文释义', 'chinese'], ['英文释义', 'english'], ['例句', 'example'], ['例句翻译', 'translation'], ['原文证据', 'evidence']]) field(details, name, c[property]);
                if (c.uncertain) details.append(el('p', '模型标记为不确定，请重点核实。', 'translation-warning'));
                details.addEventListener('toggle', () => { current.expanded['c' + index] = details.open; if (details.open) { current.viewed ||= {}; current.viewed[index] = true; } persist(); updateImport(); }); item.append(details);
                if (candidate.importStatus === 'added') item.append(el('p', `${c.word}：本次新增成功`, 'translation-meter'));
                else if (candidate.exists) item.append(el('p', `${c.word}：已存在于正式词库`, 'translation-meter'));
                if (candidate.issues?.length) item.append(el('p', candidate.issues.join('；'), 'translation-error'));
                for (const warning of candidate.warnings || []) item.append(el('p', warning, 'translation-warning translation-card-warning'));
                if (candidate.importError) item.append(el('p', `${c.word}：失败 · ${candidate.importError}`, 'translation-error'));
                item.append(check('我已审核此词的完整详情', current.reviewed[index], value => { current.reviewed[index] = value; persist(); updateImport(); }, unavailable || importing || current.state === 'running'));
                results.append(item);
            });
            const button = el('button', '导入已选择且已审核的词', 'translation-primary'); button.type = 'button'; button.id = 'translationImport'; button.addEventListener('click', importWords); results.append(button); updateImport();
        }
        if (current.usage) results.append(el('p', `用量：${current.usage.calls || 0} 次调用 · 输入 ${current.usage.inputTokens || 0} / 输出 ${current.usage.outputTokens || 0} tokens`, 'translation-meter'));
    }
    function allViewed() { return (current?.candidates || []).every((c, i) => !c.valid || c.exists || current.viewed?.[i]); }
    function eligible() { return (current?.candidates || []).filter((c, i) => c.valid && !c.exists && current.selected[i] && ((current.reviewAll && allViewed()) || current.reviewed[i])); }
    function updateImport() { const review = document.getElementById('translationReviewAll'); if (review) review.disabled = !allViewed() || importing || busy || current.state === 'running'; const b = document.getElementById('translationImport'); if (b) { const count = eligible().length; b.disabled = !count || importing || busy || current.state === 'running'; b.textContent = importing ? '正在写入词库…' : `导入已选择且已审核的词（${count}）`; } }
    async function importWords() {
        if (importing || busy || current?.state === 'running' || !eligible().length) return;
        const entry = current; const items = eligible().map(c => ({card: c.card, reviewed: true}));
        if (!window.confirm('确认将以下已审核词卡写入正式词库？\n\n' + items.map(item => item.card.word).join('、'))) return;
        importing = true; render(); message('');
        try {
            const data = await request('/words', {confirm: true, items});
            if (!Array.isArray(data.results) || data.results.length !== items.length || data.results.some(r=>!['added','exists','failed'].includes(r.status) || !items.some(item=>item.card.word===r.word)) || new Set(data.results.map(r=>r.word)).size!==items.length) throw Error('服务器未返回完整的逐词保存结果。请重试核对，已保存的词不会重复创建。');
            let added = 0, existed = 0, failed = 0;
            for (const result of data.results || []) {
                const normalize = value => String(value).replace(/\s+/g, ' ').trim().toLowerCase();
                const candidate = entry.candidates.find(c => normalize(c.card.word) === normalize(result.word));
                if (result.status === 'added' || result.status === 'exists') {
                    if (!wordCards.some(c => getWord(c) === normalize(result.word)) && result.html) {
                        // Only the server's escaped, trusted card renderer may provide HTML here.
                        const template = document.createElement('template'); template.innerHTML = result.html;
                        const card = template.content.querySelector('.word-card');
                        if (!card || getWord(card) !== normalize(result.word)) throw Error('服务器返回的词卡不完整；已保存结果保留，可重新尝试同步。');
                        document.getElementById('wordList').appendChild(card); wordCards.push(card); addReviewControls(card); updateCardCounts(card);
                        searchInput.dispatchEvent(new Event('input'));
                    }
                    if (candidate) { candidate.exists = true; candidate.importStatus = result.status; delete candidate.importError; }
                    if (result.status === 'added') added++; else existed++;
                    config.words ||= []; if (!config.words.includes(normalize(result.word))) config.words.push(normalize(result.word));
                } else { failed++; if (candidate) { candidate.importStatus = 'failed'; candidate.importError = result.error || result.code || '写入失败，请重试'; } }
            }
            refreshKnown(); persist(); message(`新增 ${added} 个，已存在 ${existed} 个，失败 ${failed} 个。${failed ? '失败项已保留审核与选择，可重试。' : '词库已同步。'}`, failed > 0);
        } catch (error) { persist(); message('导入失败，审核与选择已保留。' + error.message, true); }
        finally { importing = false; render(); }
    }
    function renderHistory() {
        archive.replaceChildren(); const bar = el('div', null, 'translation-history-bar'); bar.append(el('h3', `本机历史 · ${history.length}/10`));
        const clear = el('button', '清空历史'); clear.type = 'button'; clear.disabled = !history.length || busy || importing || current?.state === 'running';
        clear.addEventListener('click', () => { if (!window.confirm('清空本浏览器全部翻译原文、结果与选择？此操作无法撤销。')) return; history = []; current = null; input.value = ''; paid.checked = false; persist(); estimate(); render(); message('翻译历史已清空。'); }); bar.append(clear); archive.append(bar);
        for (const entry of history) {
            const row = el('div', null, 'translation-history-row');
            const open = el('button', `${entry.direction === 'zh-en' ? '中 → 英' : '英 → 中'} · ${entry.input?.text?.slice(0, 65) || '翻译任务'}`); open.type = 'button'; open.disabled = busy || importing || (current?.state === 'running' && current.id !== entry.id); open.setAttribute('aria-pressed', String(current?.id === entry.id));
            open.addEventListener('click', async () => { current = entry; input.value = entry.input?.text || ''; direction.value = entry.direction; model.value = entry.model; paid.checked = false; persist(); estimate(); render(); message(''); if (entry.state === 'running') poll(); else { await revalidateCandidates(entry); if (current === entry) render(); } });
            const remove = el('button', '删除'); remove.type = 'button'; remove.setAttribute('aria-label', '删除翻译记录：' + (entry.input?.text?.slice(0, 24) || entry.id)); remove.disabled = busy || importing || current?.state === 'running';
            remove.addEventListener('click', () => { if (!window.confirm('删除这条翻译的原文、结果与选择？此操作无法撤销。')) return; history = history.filter(h => h.id !== entry.id); if (current?.id === entry.id) { current = null; input.value = ''; paid.checked = false; } persist(); estimate(); render(); });
            row.append(open, remove); archive.append(row);
        }
    }
    async function open() {
        if (!dialog.open) dialog.showModal();
        render(); estimate();
        try { await connect(); if (current?.state === 'running') poll(); } catch (error) { message(error.message, true); }
    }
    input.addEventListener('input', () => { paid.checked = false; estimate(); persist(); });
    direction.addEventListener('change', () => { paid.checked = false; persist(); });
    model.addEventListener('change', () => { paid.checked = false; persist(); });
    form.addEventListener('submit', event => { event.preventDefault(); start(false); });
    retry.addEventListener('click', () => start(true)); trigger.addEventListener('click', open);
    document.getElementById('translationClose').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { persist(); trigger.focus(); });
    window.TranslateHelper = {open, get current() { return current; }, get history() { return history; }};
    render(); estimate();
    if (current?.state === 'running') connect().then(poll).catch(error => message(error.message, true));
})();
