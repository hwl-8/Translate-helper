'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createModelClient, loadModelConfig, ModelCallError} = require('./reading-models.cjs');

const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {title: {type: 'string'}},
    required: ['title']
};
const secretDeepSeek = 'test-deepseek-secret-never-log';
const baseConfig = {
    timeoutMs: 1000,
    maxRetries: 2,
    maxOutputTokens: 123,
    usageFile: null,
    providers: {
        deepseek: {apiKey: secretDeepSeek, defaultModel: 'deepseek-test', models: ['deepseek-test', 'deepseek-test-2']}
    }
};
const response = (data, status = 200) => new Response(JSON.stringify(data), {status, headers: {'Content-Type': 'application/json'}});

(async () => {
    const requests = [];
    const records = [];
    const successFetch = async (url, options) => {
        requests.push({url, options, body: JSON.parse(options.body)});
        return response({
            id: 'chat_test', model: 'deepseek-test', choices: [{finish_reason: 'stop', message: {content: '{"title":"DeepSeek result"}'}}],
            usage: {prompt_tokens: 20, prompt_tokens_details: {cached_tokens: 4}, completion_tokens: 6, completion_tokens_details: {reasoning_tokens: 0}, total_tokens: 26}
        });
    };
    const client = createModelClient({config: baseConfig, fetchImpl: successFetch, sleep: async () => {}, recordUsage: record => records.push(record)});
    await assert.rejects(client.generate({provider: 'unsupported', instructions: 'Create data.', input: 'Input.', schema}), error => error.code === 'invalid_provider');
    assert.equal(requests.length, 0, 'Removed provider must not send a request');
    assert.deepEqual(Object.keys(client.config().providers), ['deepseek']);
    const deepseek = await client.generate({provider: 'deepseek', instructions: 'Create data.', input: 'Shared search bundle.', schema, maxOutputTokens: 999});
    assert.deepEqual(deepseek.output, {title: 'DeepSeek result'});
    assert.deepEqual(deepseek.usage, {inputTokens: 20, cachedInputTokens: 4, outputTokens: 6, reasoningTokens: 0, totalTokens: 26});
    assert.equal(requests[0].url, 'https://api.deepseek.com/chat/completions');
    assert.equal(requests[0].body.max_tokens, 123);
    assert.deepEqual(requests[0].body.response_format, {type: 'json_object'});
    assert.deepEqual(requests[0].body.thinking, {type: 'disabled'});
    assert(requests[0].body.messages[0].content.includes('Return JSON only'));
    assert(!('text' in requests[0].body), 'DeepSeek 请求不得混入其他供应商参数');
    assert.equal(client.config().providers.deepseek.configured, true);
    assert(!JSON.stringify(client.config()).includes(secretDeepSeek));
    assert(!JSON.stringify(records).includes(secretDeepSeek));
    assert(!JSON.stringify(records).includes('Shared search bundle'));

    let timeoutCalls = 0;
    const timeoutClient = createModelClient({
        config: {...baseConfig, timeoutMs: 1000, maxRetries: 1},
        fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
            timeoutCalls++;
            options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {once: true});
        }),
        sleep: async () => {}, recordUsage: () => {}
    });
    await assert.rejects(timeoutClient.generate({provider: 'deepseek', instructions: 'Create data.', input: 'Input.', schema, timeoutMs: 1000}), error => error instanceof ModelCallError && error.code === 'timeout' && error.attempts === 2);
    assert.equal(timeoutCalls, 2);

    const calledUrls = [];
    const rateClient = createModelClient({
        config: baseConfig,
        fetchImpl: async url => { calledUrls.push(url); return response({error: {message: 'secret provider detail'}}, 429); },
        sleep: async () => {}, recordUsage: () => {}
    });
    await assert.rejects(rateClient.generate({provider: 'deepseek', instructions: 'Create data.', input: 'Input.', schema}), error => error.code === 'rate_limit' && error.status === 429 && error.attempts === 3 && !error.message.includes('secret provider detail'));
    assert.equal(calledUrls.length, 3);
    assert(calledUrls.every(url => url.includes('deepseek.com')), '限流后不得自动切换供应商');

    let malformedCalls = 0;
    const malformedClient = createModelClient({
        config: {...baseConfig, maxRetries: 1},
        fetchImpl: async () => { malformedCalls++; return response({choices: [{finish_reason: 'stop', message: {content: '{broken'}}]}); },
        sleep: async () => {}, recordUsage: () => {}
    });
    await assert.rejects(malformedClient.generate({provider: 'deepseek', instructions: 'Create data.', input: 'Input.', schema}), error => error.code === 'invalid_response' && error.attempts === 2);
    assert.equal(malformedCalls, 2);

    let schemaCalls = 0;
    const schemaClient = createModelClient({
        config: {...baseConfig, maxRetries: 1},
        fetchImpl: async () => { schemaCalls++; return response({id: 'bad-shape', model: 'deepseek-test', choices: [{finish_reason: 'stop', message: {content: '{"wrong":true}'}}], usage: {}}); },
        sleep: async () => {}, recordUsage: () => {}
    });
    await assert.rejects(schemaClient.generate({provider: 'deepseek', instructions: 'Create data.', input: 'Input.', schema}), error => error.code === 'invalid_response' && error.message.includes('不符合要求') && error.attempts === 2);
    assert.equal(schemaCalls, 2, 'DeepSeek JSON Output 仍须本地 schema 校验');

    let loggingCalls = 0;
    const loggingFailure = createModelClient({config:baseConfig, fetchImpl:async (...args)=>{loggingCalls++;return successFetch(...args);},recordUsage:()=>{throw Error('simulated log disk failure');},sleep:async()=>{}});
    const preserved = await loggingFailure.generate({provider:'deepseek',instructions:'Create data.',input:'Input.',schema});
    assert.equal(loggingCalls,1,'Logging failure must not repeat a paid success');
    assert.equal(preserved.output.title,'DeepSeek result');
    assert.equal(preserved.usageRecordFailed,true);

    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'reading-model-config-test-'));
    try {
        fs.writeFileSync(path.join(temp, '.env'), `DEEPSEEK_API_KEY=${secretDeepSeek}\nMODEL_USAGE_FILE=.usage-test.jsonl\n`);
        const config = loadModelConfig({root: temp, env: {}});
        assert.equal(config.providers.deepseek.apiKey, secretDeepSeek);
        const publicConfig = JSON.stringify(createModelClient({config, fetchImpl: successFetch}).config());
        assert(!publicConfig.includes(secretDeepSeek));
        const diskClient = createModelClient({config, fetchImpl: successFetch});
        await diskClient.generate({provider: 'deepseek', instructions: 'Do not log this prompt.', input: 'Do not log this input.', schema});
        const usageLog = fs.readFileSync(config.usageFile, 'utf8');
        assert(!usageLog.includes(secretDeepSeek) && !usageLog.includes('Do not log'));
        assert.equal(JSON.parse(usageLog).provider, 'deepseek');
    } finally { fs.rmSync(temp, {recursive: true, force: true}); }

    await assert.rejects(createModelClient({config: {...baseConfig, providers: {...baseConfig.providers, deepseek: {...baseConfig.providers.deepseek, apiKey: ''}}}, fetchImpl: successFetch}).generate({provider: 'deepseek', instructions: 'Create.', input: 'Input.', schema}), error => error.code === 'not_configured');

    console.log(JSON.stringify({
        result: 'PASS',
        checks: ['DeepSeek Chat Completions adapter', 'unified output and usage', 'server-only config', 'output cap', 'timeout retry', '429 retry', 'malformed JSON retry', 'local JSON schema validation', 'no provider fallback', 'sanitized usage log']
    }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
