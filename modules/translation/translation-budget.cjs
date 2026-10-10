'use strict';

// Offline accounting only. Reserve once BEFORE each network attempt; never retry
// with an existing id. Prices are caller-supplied CNY / million tokens.
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const MODEL = 'deepseek-flash';
const SCALE = 1000000;
const ERROR_CODES = new Set(['timeout', 'network', 'authentication', 'rate_limit', 'service_unavailable', 'request_failed', 'invalid_response', 'output_limit', 'response_too_large']);
function fail(code) { const e = new Error(code); e.code = code; throw e; }
function integer(n, min, max) { return Number.isSafeInteger(n) && n >= min && n <= max; }
function exact(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('|') === keys.slice().sort().join('|'); }
function safePath(filename, optional = false) {
    const absolute = path.resolve(filename);
    const root = path.parse(absolute).root;
    let current = root;
    for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        let stat;
        try { stat = fs.lstatSync(current); }
        catch (e) { if (e.code === 'ENOENT' && optional && current === absolute) return null; throw e; }
        if (stat.isSymbolicLink() || (current === absolute ? (!stat.isFile() || stat.nlink !== 1) : !stat.isDirectory())) fail('unsafe_path');
    }
    return fs.lstatSync(absolute);
}

function createBudget({filename, maxCny = 4, maxCalls = 20, model = MODEL, rates = {input: 2, output: 8}, pricingDate = '2026-10-10'} = {}) {
    if (typeof filename !== 'string' || !filename || model !== MODEL || !Number.isFinite(maxCny) || maxCny <= 0 || maxCny > 4 || !integer(maxCalls, 1, 20) || !exact(rates, ['input', 'output']) || ![rates.input, rates.output].every(n => Number.isFinite(n) && n > 0 && n <= 1000000) || !/^\d{4}-\d{2}-\d{2}$/.test(pricingDate)) fail('invalid_config');
    filename = path.resolve(filename);
    if (path.extname(filename) !== '.json') fail('invalid_filename');
    const lock = filename + '.lock';
    const config = {maxUnits: Math.floor(maxCny * SCALE), maxCalls, model, rates: {input: rates.input, output: rates.output}, pricingDate};
    let blocked = false;
    const price = (input, output) => Math.ceil(input * config.rates.input + output * config.rates.output);
    const charge = (input, output) => Math.max(200000, price(input, output));
    function validate(data) {
        if (!exact(data, ['version', 'config', 'records']) || data.version !== 1 || JSON.stringify(data.config) !== JSON.stringify(config) || !Array.isArray(data.records) || data.records.length > maxCalls) fail('corrupt_ledger');
        const ids = new Set();
        let sum = 0;
        for (const r of data.records) {
            if (!exact(r, ['id', 'inputBudgetTokens', 'maxOutputTokens', 'reservedUnits', 'status', 'usage', 'estimatedCny', 'actualBillCny', 'errorCode']) || typeof r.id !== 'string' || !/^[a-f0-9-]{36}$/.test(r.id) || ids.has(r.id) || !integer(r.inputBudgetTokens, 1024, 40000) || !integer(r.maxOutputTokens, 1, 6000) || r.reservedUnits !== charge(r.inputBudgetTokens, r.maxOutputTokens) || !['reserved', 'settled'].includes(r.status) || r.actualBillCny !== null || !(r.errorCode === null || ERROR_CODES.has(r.errorCode) || r.errorCode === 'other')) fail('corrupt_ledger');
            ids.add(r.id);
            if (r.usage !== null && (!exact(r.usage, ['inputTokens', 'outputTokens']) || !integer(r.usage.inputTokens, 0, 1000000000) || !integer(r.usage.outputTokens, 0, 1000000000))) fail('corrupt_ledger');
            if (r.estimatedCny !== (r.usage === null ? r.reservedUnits / SCALE : price(r.usage.inputTokens, r.usage.outputTokens) / SCALE) || (r.status === 'reserved' && (r.usage !== null || r.errorCode !== null))) fail('corrupt_ledger');
            sum += r.reservedUnits;
        }
        if (sum > config.maxUnits) fail('corrupt_ledger');
        return data;
    }
    function read() {
        if (!safePath(filename, true)) return {version: 1, config, records: []};
        const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        try {
            const stat = fs.fstatSync(fd);
            if (!stat.isFile() || stat.nlink !== 1 || stat.size > 100000) fail('unsafe_path');
            return validate(JSON.parse(fs.readFileSync(fd, 'utf8')));
        } finally { fs.closeSync(fd); }
    }
    function save(data) {
        const temp = filename + '.' + randomUUID() + '.tmp';
        let fd;
        try {
            safePath(filename, true);
            fd = fs.openSync(temp, 'wx', 0o600);
            fs.writeFileSync(fd, JSON.stringify(data) + '\n');
            fs.fsyncSync(fd);
            fs.closeSync(fd); fd = undefined;
            safePath(filename, true);
            fs.renameSync(temp, filename);
        } finally {
            if (fd !== undefined) fs.closeSync(fd);
            if (fs.existsSync(temp)) fs.unlinkSync(temp);
        }
    }
    function transaction(fn) {
        if (blocked) fail('budget_blocked');
        let fd;
        let owned;
        try {
            safePath(filename, true);
            safePath(lock, true);
            fd = fs.openSync(lock, 'wx', 0o600);
            owned = fs.fstatSync(fd);
            const data = read();
            return fn(data);
        } catch (e) {
            // Any accounting or lock failure stops this instance. Never erase a
            // stale/foreign lock: recovery requires explicit operator inspection.
            blocked = true;
            if (['budget_exhausted', 'call_limit', 'unknown_reservation', 'already_settled', 'usage_exceeds_envelope'].includes(e.code)) throw e;
            fail('budget_unavailable');
        } finally {
            if (fd !== undefined) {
                try {
                    fs.closeSync(fd);
                    const current = fs.lstatSync(lock);
                    if (current.isSymbolicLink() || current.dev !== owned.dev || current.ino !== owned.ino) fail('unsafe_lock');
                    fs.unlinkSync(lock);
                } catch (_) { blocked = true; fail('budget_unavailable'); }
            }
        }
    }
    // Validate/create immediately so a corrupt ledger cannot appear usable.
    transaction(data => { save(data); });
    return Object.freeze({
        reserve({model: requestedModel, instructions, input, schema, maxOutputTokens} = {}) {
            if (requestedModel !== MODEL) fail('forbidden_model');
            if (typeof instructions !== 'string' || !instructions.trim() || typeof input !== 'string' || !input.trim() || !schema || schema.type !== 'object' || !schema.properties || !integer(maxOutputTokens, 1, 6000)) fail('invalid_request');
            let body;
            try {
                // Keep identical to reading-models.cjs deepSeekRequest. Counting
                // the entire serialized envelope also covers JSON escaping.
                body = JSON.stringify({model: requestedModel, messages: [
                    {role: 'system', content: `${instructions}\nReturn JSON only. The JSON must follow this schema: ${JSON.stringify(schema)}`},
                    {role: 'user', content: input}
                ], response_format: {type: 'json_object'}, thinking: {type: 'disabled'}, max_tokens: maxOutputTokens, stream: false});
            } catch (_) { fail('invalid_request'); }
            const inputBudgetTokens = Buffer.byteLength(body, 'utf8') + 1024;
            if (inputBudgetTokens > 40000) fail('input_limit');
            return transaction(data => {
                if (data.records.some(r => r.usage && (r.usage.inputTokens > r.inputBudgetTokens || r.usage.outputTokens > r.maxOutputTokens))) fail('usage_exceeds_envelope');
                if (data.records.length >= maxCalls) fail('call_limit');
                const reservedUnits = charge(inputBudgetTokens, maxOutputTokens);
                if (data.records.reduce((n, r) => n + r.reservedUnits, 0) + reservedUnits > config.maxUnits) fail('budget_exhausted');
                const id = randomUUID();
                data.records.push({id, inputBudgetTokens, maxOutputTokens, reservedUnits, status: 'reserved', usage: null, estimatedCny: reservedUnits / SCALE, actualBillCny: null, errorCode: null});
                save(data);
                return id;
            });
        },
        settle(id, {usage, errorCode} = {}) {
            return transaction(data => {
                const r = data.records.find(item => item.id === id);
                if (!r) fail('unknown_reservation');
                if (r.status !== 'reserved') fail('already_settled');
                const inputTokens = usage?.inputTokens ?? usage?.prompt_tokens;
                const outputTokens = usage?.outputTokens ?? usage?.completion_tokens;
                // Preserve reported counts even if the provider violates the
                // envelope; such a violation persistently blocks new attempts.
                // Missing/partial/invalid usage remains unknown, never zeroed.
                r.usage = integer(inputTokens, 0, 1000000000) && integer(outputTokens, 0, 1000000000) ? {inputTokens, outputTokens} : null;
                r.estimatedCny = r.usage ? price(inputTokens, outputTokens) / SCALE : r.reservedUnits / SCALE;
                r.errorCode = errorCode == null ? null : ERROR_CODES.has(errorCode) ? errorCode : 'other';
                r.status = 'settled';
                save(data);
            });
        },
        snapshot() {
            return transaction(data => ({model, pricingDate, rates: {...config.rates}, maxCny: config.maxUnits / SCALE, maxCalls, calls: data.records.length,
                reservedCny: data.records.reduce((n, r) => n + r.reservedUnits, 0) / SCALE,
                actualBillCny: null, records: data.records.map(r => ({...r, reservedCny: r.reservedUnits / SCALE, usageStatus: r.usage === null ? 'unknown' : 'reported', usage: r.usage && {...r.usage}}))}));
        }
    });
}
module.exports = {createBudget};
