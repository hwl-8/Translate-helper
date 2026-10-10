'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {createBudget} = require('./translation-budget.cjs');

const request = {model: 'deepseek-flash', instructions: 'PRIVATE_INSTRUCTIONS', input: 'PRIVATE_USER_TEXT 密钥', schema: {type: 'object', properties: {PRIVATE_SCHEMA: {type: 'string'}}}, maxOutputTokens: 6000};
function rejects(fn, code) { assert.throws(fn, e => e.code === code); }
function worker(filename) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [__filename, '--worker', filename], {stdio: ['ignore', 'pipe', 'pipe']});
        let out = ''; let err = '';
        child.stdout.on('data', data => { out += data; });
        child.stderr.on('data', data => { err += data; });
        child.on('error', reject);
        child.on('exit', code => code === 0 ? resolve(out.trim()) : reject(Error(err)));
    });
}
if (process.argv[2] === '--worker') {
    try { createBudget({filename: process.argv[3]}).reserve(request); process.stdout.write('reserved'); }
    catch (e) { process.stdout.write(e.code); }
} else {
    (async () => {
        const root = fs.mkdtempSync(path.join(__dirname, '.translation-budget-test-'));
        const file = name => path.join(root, name + '.json');
        try {
            const filename = file('restart');
            let budget = createBudget({filename});
            const id = budget.reserve(request);
            let record = budget.snapshot().records[0];
            const envelope = {model: request.model, messages: [
                {role: 'system', content: `${request.instructions}\nReturn JSON only. The JSON must follow this schema: ${JSON.stringify(request.schema)}`},
                {role: 'user', content: request.input}
            ], response_format: {type: 'json_object'}, thinking: {type: 'disabled'}, max_tokens: 6000, stream: false};
            assert.equal(record.inputBudgetTokens, Buffer.byteLength(JSON.stringify(envelope), 'utf8') + 1024);
            assert.equal(record.usageStatus, 'unknown');
            assert.equal(record.estimatedCny, 0.2);
            // Simulate a process crash/timeout before settlement: persisted in full.
            budget = createBudget({filename});
            assert.equal(budget.snapshot().calls, 1);
            assert.equal(budget.snapshot().reservedCny, 0.2);
            budget.settle(id, {errorCode: 'timeout'});
            record = budget.snapshot().records[0];
            assert.equal(record.usage, null);
            assert.equal(record.estimatedCny, 0.2);
            assert.equal(record.actualBillCny, null);
            rejects(() => budget.settle(id, {}), 'already_settled');
            budget = createBudget({filename});
            const success = budget.reserve(request);
            budget.settle(success, {usage: {prompt_tokens: 100, completion_tokens: 200, api_key: 'PRIVATE_API_KEY'}, errorCode: 'PRIVATE_ERROR_TEXT'});
            record = budget.snapshot().records[1];
            assert.deepEqual(record.usage, {inputTokens: 100, outputTokens: 200});
            assert.equal(record.estimatedCny, 0.0018);
            assert.equal(record.actualBillCny, null);
            assert.equal(record.errorCode, 'other');
            assert.equal(budget.snapshot().reservedCny, 0.4);
            const partial = budget.reserve(request);
            budget.settle(partial, {usage: {inputTokens: 2}});
            assert.equal(budget.snapshot().records[2].usageStatus, 'unknown');
            const content = fs.readFileSync(filename, 'utf8');
            for (const secret of ['PRIVATE_', '密钥', 'instructions', 'schema', 'api_key']) assert.ok(!content.includes(secret));

            const limit = createBudget({filename: file('limit')});
            for (let i = 0; i < 20; i++) limit.reserve(request);
            assert.equal(limit.snapshot().reservedCny, 4);
            rejects(() => limit.reserve(request), 'call_limit');
            assert.equal(createBudget({filename: file('limit')}).snapshot().calls, 20);
            const monetary = createBudget({filename: file('money'), maxCny: 0.39});
            monetary.reserve(request);
            rejects(() => monetary.reserve(request), 'budget_exhausted');
            const expensive = createBudget({filename: file('peak'), rates: {input: 20, output: 80}});
            expensive.reserve(request);
            assert.ok(expensive.snapshot().reservedCny > 0.48);
            const forbidden = createBudget({filename: file('forbidden')});
            for (const model of ['deepseek-v4-pro', 'DeepSeek-Flash', 'deepseek-flash ', undefined]) rejects(() => forbidden.reserve({...request, model}), 'forbidden_model');
            rejects(() => forbidden.reserve({...request, maxOutputTokens: 6001}), 'invalid_request');
            rejects(() => forbidden.reserve({...request, input: 'x'.repeat(40000)}), 'input_limit');
            rejects(() => forbidden.reserve({...request, schema: {type: 'object', properties: {}, description: 'x'.repeat(40000)}}), 'input_limit');
            assert.equal(forbidden.snapshot().calls, 0);
            const over = createBudget({filename: file('over')});
            const overId = over.reserve(request);
            over.settle(overId, {usage: {inputTokens: 50000, outputTokens: 7000}});
            assert.equal(over.snapshot().records[0].usage.inputTokens, 50000);
            rejects(() => over.reserve(request), 'usage_exceeds_envelope');
            rejects(() => createBudget({filename: file('over')}).reserve(request), 'usage_exceeds_envelope');

            const corrupt = file('corrupt');
            fs.writeFileSync(corrupt, '{broken');
            rejects(() => createBudget({filename: corrupt}), 'budget_unavailable');
            assert.equal(fs.readFileSync(corrupt, 'utf8'), '{broken');
            const tampered = file('tampered');
            createBudget({filename: tampered}).reserve(request);
            const data = JSON.parse(fs.readFileSync(tampered, 'utf8'));
            data.records[0].reservedUnits = 0;
            fs.writeFileSync(tampered, JSON.stringify(data));
            rejects(() => createBudget({filename: tampered}), 'budget_unavailable');
            rejects(() => createBudget({filename, maxCny: 3}), 'budget_unavailable');

            const locked = file('locked');
            fs.writeFileSync(locked + '.lock', 'FOREIGN_LOCK');
            rejects(() => createBudget({filename: locked}), 'budget_unavailable');
            assert.equal(fs.readFileSync(locked + '.lock', 'utf8'), 'FOREIGN_LOCK');
            const unsafe = file('directory');
            fs.mkdirSync(unsafe);
            rejects(() => createBudget({filename: unsafe}), 'budget_unavailable');
            const linked = file('hardlink');
            try { fs.linkSync(filename, linked); }
            catch (e) { if (!['EPERM', 'EACCES', 'ENOSYS'].includes(e.code)) throw e; }
            if (fs.existsSync(linked)) {
                rejects(() => createBudget({filename: linked}), 'budget_unavailable');
                fs.unlinkSync(linked);
            }
            // Exercise rejection even on hosts that disallow making links.
            const originalLstat = fs.lstatSync;
            for (const kind of ['hardlink', 'symlink']) {
                try {
                    fs.lstatSync = function (target, ...args) {
                        const stat = originalLstat.call(fs, target, ...args);
                        if (target === filename) {
                            if (kind === 'hardlink') stat.nlink = 2;
                            else stat.isSymbolicLink = () => true;
                        }
                        return stat;
                    };
                    rejects(() => createBudget({filename}), 'budget_unavailable');
                } finally { fs.lstatSync = originalLstat; }
            }
            // Windows may prohibit creation of file symlinks without Developer Mode.
            const symlink = file('symlink');
            try { fs.symlinkSync(filename, symlink); }
            catch (e) { if (!['EPERM', 'EACCES', 'ENOSYS'].includes(e.code)) throw e; }
            if (fs.existsSync(symlink)) rejects(() => createBudget({filename: symlink}), 'budget_unavailable');
            const junction = path.join(root, 'junction');
            try { fs.symlinkSync(root, junction, process.platform === 'win32' ? 'junction' : 'dir'); }
            catch (e) { if (!['EPERM', 'EACCES', 'ENOSYS'].includes(e.code)) throw e; }
            if (fs.existsSync(junction)) {
                rejects(() => createBudget({filename: path.join(junction, 'nested.json')}), 'budget_unavailable');
                fs.unlinkSync(junction);
            }

            // Inject filesystem failures only around temporary fake ledgers.
            const saving = createBudget({filename: file('save-failure')});
            const originalRename = fs.renameSync;
            try {
                fs.renameSync = () => { const e = Error('fake'); e.code = 'EACCES'; throw e; };
                rejects(() => saving.reserve(request), 'budget_unavailable');
            } finally { fs.renameSync = originalRename; }
            rejects(() => saving.reserve(request), 'budget_blocked');
            assert.equal(createBudget({filename: file('save-failure')}).snapshot().calls, 0);
            const settlement = createBudget({filename: file('settle-failure')});
            const pending = settlement.reserve(request);
            try {
                fs.renameSync = () => { throw Error('fake'); };
                rejects(() => settlement.settle(pending, {usage: {inputTokens: 1, outputTokens: 1}}), 'budget_unavailable');
            } finally { fs.renameSync = originalRename; }
            assert.equal(createBudget({filename: file('settle-failure')}).snapshot().records[0].usageStatus, 'unknown');
            const originalRead = fs.readFileSync;
            try {
                fs.readFileSync = () => { throw Error('fake unreadable'); };
                rejects(() => createBudget({filename}), 'budget_unavailable');
            } finally { fs.readFileSync = originalRead; }

            const parallel = file('parallel');
            createBudget({filename: parallel});
            const outcomes = await Promise.all(Array.from({length: 24}, () => worker(parallel)));
            assert.ok(outcomes.every(value => ['reserved', 'budget_unavailable', 'call_limit'].includes(value)));
            const final = createBudget({filename: parallel}).snapshot();
            assert.equal(final.calls, outcomes.filter(value => value === 'reserved').length);
            assert.ok(final.calls > 0 && final.calls <= 20 && final.reservedCny <= 4);
            assert.equal(fs.existsSync(parallel + '.lock'), false);
            console.log('translation budget: offline isolation, persistence, limits, privacy, locking and failure checks passed');
        } finally { fs.rmSync(root, {recursive: true, force: true}); }
    })().catch(e => { console.error(e); process.exitCode = 1; });
}
