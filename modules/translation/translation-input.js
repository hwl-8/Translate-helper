(function (root) {
    'use strict';
    const MAX_CHARACTERS = 10000;
    function fail(message, code) { throw Object.assign(new Error(message), {code, status: 400}); }
    function normalizeInput(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) fail('请输入要翻译的文本。', 'INVALID_INPUT');
        if (input.type === 'url' || input.type === 'file') fail('文件与网址翻译暂未开放，请先粘贴正文。', 'INPUT_NOT_SUPPORTED');
        if (input.type !== 'text' || typeof input.text !== 'string') fail('首版仅支持粘贴文本。', 'INVALID_INPUT');
        if (Array.from(input.text).length > MAX_CHARACTERS) fail('文本超过 10,000 字符，请分次提交；不会自动截断。', 'INPUT_TOO_LONG');
        if (!input.text.trim()) fail('请输入要翻译的文本。', 'EMPTY_INPUT');
        const text = input.text.replace(/\r\n?/g, '\n');
        const paragraphs = text.split(/\n[\t ]*\n|\n/).filter(part => part.trim());
        const chunks = [], batches = [], warnings = [];
        let batch = [], size = 0;
        function flush() { if (batch.length) batches.push(batch); batch = []; size = 0; }
        for (const [paragraph, content] of paragraphs.entries()) {
            let remaining = Array.from(content);
            while (remaining.length) {
                let available = 1200 - size - (batch.length ? 2 : 0);
                if (available < Math.min(200,remaining.length)) { flush(); available = 1200; }
                let end = Math.min(available, remaining.length);
                if (end < remaining.length) {
                    const prefix = remaining.slice(0, end).join('');
                    const matches = [...prefix.matchAll(/[.!?。！？][\s”’"')]*|[;；]\s*/g)];
                    const boundary = matches.map(m => Array.from(prefix.slice(0, m.index + m[0].length)).length).filter(n => n >= Math.min(200,Math.floor(end/2))).pop();
                    if (boundary) end = boundary;
                    else if (!warnings.length) warnings.push('存在较长句子，已按长度拆分；请结合相邻片段核对语义。');
                }
                if (batch.length) size += 2;
                batch.push(chunks.length); size += end;
                chunks.push({paragraph, text: remaining.slice(0, end).join('')});
                remaining = remaining.slice(end);
                if (remaining.length) flush();
            }
        }
        flush();
        return {type: 'text', text, paragraphs, chunks, batches, warnings, source: {type: 'user_text'}};
    }
    const api = {MAX_CHARACTERS, normalizeInput};
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.TranslationInput = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
