'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PROVIDERS = Object.freeze({
    deepseek: Object.freeze({
        endpoint: 'https://api.deepseek.com/chat/completions',
        defaultModel: 'deepseek-flash',
        models: ['deepseek-flash', 'deepseek-v4-pro']
    })
});

const DEFAULT_TIMEOUT_MS = 45000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_OUTPUT_TOKENS = 6000;
const MAX_ALLOWED_OUTPUT_TOKENS = 20000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

class ModelCallError extends Error {
    constructor(message, {code = 'model_error', provider, status, retryable = false, attempts = 0} = {}) {
        super(message);
        this.name = 'ModelCallError';
        this.code = code;
        this.provider = provider;
        this.status = status;
        this.retryable = retryable;
        this.attempts = attempts;
    }
}

function parseEnvFile(text) {
    const result = {};
    for (const [index, raw] of text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n').entries()) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const match = line.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
        if (!match) throw Error(`.env 第 ${index + 1} 行格式不正确`);
        let value = match[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        result[match[1]] = value;
    }
    return result;
}

function boundedInteger(value, fallback, min, max, label) {
    if (value == null || value === '') return fallback;
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) throw Error(`${label} 必须是 ${min}–${max} 的整数`);
    return number;
}

function modelList(value, defaults, label) {
    const items = value ? value.split(',').map(item => item.trim()).filter(Boolean) : defaults.slice();
    if (!items.length || items.length > 20 || items.some(item => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(item))) throw Error(`${label} 格式不正确`);
    return [...new Set(items)];
}

function localUsagePath(root, value) {
    if (value === 'off') return null;
    const resolved = path.resolve(root, value || '.model-usage.jsonl');
    const relative = path.relative(root, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('MODEL_USAGE_FILE 必须位于项目目录内');
    return resolved;
}

function loadModelConfig({root = __dirname, env = process.env} = {}) {
    root = path.resolve(root);
    const filename = path.join(root, '.env');
    const fileValues = fs.existsSync(filename) ? parseEnvFile(fs.readFileSync(filename, 'utf8')) : {};
    const values = {...fileValues, ...env};
    const deepseekModels = modelList(values.DEEPSEEK_MODELS, PROVIDERS.deepseek.models, 'DEEPSEEK_MODELS');
    const deepseekDefault = values.DEEPSEEK_DEFAULT_MODEL || PROVIDERS.deepseek.defaultModel;
    if (!deepseekModels.includes(deepseekDefault)) throw Error('DEEPSEEK_DEFAULT_MODEL 必须包含在 DEEPSEEK_MODELS 中');
    return {
        timeoutMs: boundedInteger(values.MODEL_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1000, 300000, 'MODEL_TIMEOUT_MS'),
        maxRetries: boundedInteger(values.MODEL_MAX_RETRIES, DEFAULT_MAX_RETRIES, 0, 3, 'MODEL_MAX_RETRIES'),
        maxOutputTokens: boundedInteger(values.MODEL_MAX_OUTPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS, 1, MAX_ALLOWED_OUTPUT_TOKENS, 'MODEL_MAX_OUTPUT_TOKENS'),
        usageFile: localUsagePath(root, values.MODEL_USAGE_FILE),
        providers: {
            deepseek: {apiKey: values.DEEPSEEK_API_KEY || '', defaultModel: deepseekDefault, models: deepseekModels}
        }
    };
}

function publicModelConfig(config) {
    return {
        timeoutMs: config.timeoutMs,
        maxRetries: config.maxRetries,
        maxOutputTokens: config.maxOutputTokens,
        providers: Object.fromEntries(Object.entries(config.providers).map(([name, value]) => [name, {
            configured: Boolean(value.apiKey),
            defaultModel: value.defaultModel,
            models: value.models.slice()
        }]))
    };
}

function createUsageRecorder(filename) {
    if (!filename) return () => {};
    return record => {
        const safe = {
            timestamp: record.timestamp,
            provider: record.provider,
            model: record.model,
            requestId: record.requestId || null,
            attempts: record.attempts,
            durationMs: record.durationMs,
            usage: record.usage
        };
        fs.appendFileSync(filename, JSON.stringify(safe) + '\n', {encoding: 'utf8', mode: 0o600});
    };
}

function assertSchema(schema) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema) || schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object') {
        throw new ModelCallError('输出结构定义无效，必须提供对象类型的 JSON Schema。', {code: 'invalid_request'});
    }
}

function valueMatchesType(value, type) {
    if (type === 'null') return value === null;
    if (type === 'array') return Array.isArray(value);
    if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
    if (type === 'integer') return Number.isInteger(value);
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
    return typeof value === type;
}

function validateJsonSchema(value, schema, location = '$') {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw Error(`${location} 的 schema 无效`);
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (schema.type && !types.some(type => valueMatchesType(value, type))) throw Error(`${location} 类型不符合 schema`);
    if (Array.isArray(schema.enum) && !schema.enum.some(item => Object.is(item, value))) throw Error(`${location} 不在允许值中`);
    if (typeof value === 'string') {
        if (Number.isInteger(schema.minLength) && value.length < schema.minLength) throw Error(`${location} 太短`);
        if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) throw Error(`${location} 太长`);
        if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) throw Error(`${location} 格式不匹配`);
    }
    if (Array.isArray(value)) {
        if (Number.isInteger(schema.minItems) && value.length < schema.minItems) throw Error(`${location} 项目过少`);
        if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) throw Error(`${location} 项目过多`);
        if (schema.items) value.forEach((item, index) => validateJsonSchema(item, schema.items, `${location}[${index}]`));
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const properties = schema.properties || {};
        for (const required of schema.required || []) if (!Object.prototype.hasOwnProperty.call(value, required)) throw Error(`${location}.${required} 为必填字段`);
        if (schema.additionalProperties === false) {
            const extra = Object.keys(value).find(key => !Object.prototype.hasOwnProperty.call(properties, key));
            if (extra) throw Error(`${location}.${extra} 是未知字段`);
        }
        for (const [key, child] of Object.entries(properties)) if (Object.prototype.hasOwnProperty.call(value, key)) validateJsonSchema(value[key], child, `${location}.${key}`);
    }
    return true;
}

function parseJsonObject(text, provider) {
    if (typeof text !== 'string' || !text.trim()) throw new ModelCallError(`DeepSeek 返回了空内容。`, {code: 'invalid_response', provider, retryable: true});
    let value;
    try { value = JSON.parse(text); }
    catch (_) { throw new ModelCallError(`DeepSeek 返回内容不是有效 JSON。`, {code: 'invalid_response', provider, retryable: true}); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ModelCallError('模型返回的 JSON 顶层必须是对象。', {code: 'invalid_response', provider, retryable: true});
    return value;
}

function deepSeekRequest({model, instructions, input, schema, maxOutputTokens}) {
    return {
        model,
        messages: [
            {role: 'system', content: `${instructions}\nReturn JSON only. The JSON must follow this schema: ${JSON.stringify(schema)}`},
            {role: 'user', content: input}
        ],
        response_format: {type: 'json_object'},
        thinking: {type: 'disabled'},
        max_tokens: maxOutputTokens,
        stream: false
    };
}

function deepSeekResult(data) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.choices) || !data.choices[0]) throw new ModelCallError('DeepSeek 响应结构缺失。', {code: 'invalid_response', provider: 'deepseek', retryable: true});
    const choice = data.choices[0];
    if (choice.finish_reason === 'length') throw new ModelCallError('DeepSeek 输出达到单次上限，未得到完整结果。', {code: 'output_limit', provider: 'deepseek'});
    if (choice.finish_reason && choice.finish_reason !== 'stop') throw new ModelCallError(`DeepSeek 响应未正常完成（${choice.finish_reason}）。`, {code: 'invalid_response', provider: 'deepseek', retryable: choice.finish_reason === 'insufficient_system_resource'});
    return {
        requestId: typeof data.id === 'string' ? data.id : null,
        model: typeof data.model === 'string' ? data.model : null,
        finishReason: choice.finish_reason || 'stop',
        output: parseJsonObject(choice.message?.content, 'deepseek'),
        usage: {
            inputTokens: Number(data.usage?.prompt_tokens) || 0,
            cachedInputTokens: Number(data.usage?.prompt_tokens_details?.cached_tokens ?? data.usage?.prompt_cache_hit_tokens) || 0,
            outputTokens: Number(data.usage?.completion_tokens) || 0,
            reasoningTokens: Number(data.usage?.completion_tokens_details?.reasoning_tokens) || 0,
            totalTokens: Number(data.usage?.total_tokens) || 0
        }
    };
}

function httpError(provider, status) {
    const display = 'DeepSeek';
    if (status === 401 || status === 403) return new ModelCallError(`${display} 身份验证失败，请检查本地 API 密钥和账户权限。`, {code: 'authentication', provider, status});
    if (status === 429) return new ModelCallError(`${display} 当前请求过多或额度受限，请稍后重试。`, {code: 'rate_limit', provider, status, retryable: true});
    if ([408, 409, 500, 502, 503, 504].includes(status)) return new ModelCallError(`${display} 服务暂时不可用（HTTP ${status}）。`, {code: 'service_unavailable', provider, status, retryable: true});
    return new ModelCallError(`${display} 请求失败（HTTP ${status}）。`, {code: 'request_failed', provider, status});
}

async function fetchAttempt({fetchImpl, endpoint, apiKey, body, timeoutMs, provider}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl(endpoint, {
            method: 'POST',
            headers: {'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`},
            body: JSON.stringify(body),
            signal: controller.signal
        });
        if (!response || typeof response.ok !== 'boolean') throw new ModelCallError('模型网络适配器返回了无效响应。', {code: 'network', provider, retryable: true});
        if (!response.ok) throw httpError(provider, response.status);
        const declared = Number(response.headers?.get?.('content-length'));
        if (declared > MAX_RESPONSE_BYTES) throw new ModelCallError('模型响应超过 4 MiB 安全限制。', {code: 'response_too_large', provider});
        const text = await response.text();
        if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new ModelCallError('模型响应超过 4 MiB 安全限制。', {code: 'response_too_large', provider});
        try { return JSON.parse(text); }
        catch (_) { throw new ModelCallError('模型服务返回了无法解析的响应。', {code: 'invalid_response', provider, retryable: true}); }
    } catch (error) {
        if (controller.signal.aborted || error?.name === 'AbortError') throw new ModelCallError(`DeepSeek 请求超时。`, {code: 'timeout', provider, retryable: true});
        if (error instanceof ModelCallError) throw error;
        throw new ModelCallError(`DeepSeek 网络连接失败。`, {code: 'network', provider, retryable: true});
    } finally { clearTimeout(timer); }
}

function createModelClient({config = loadModelConfig(), fetchImpl = globalThis.fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => Date.now(), recordUsage} = {}) {
    if (typeof fetchImpl !== 'function') throw Error('当前 Node.js 环境不支持 fetch');
    const usageRecorder = recordUsage || createUsageRecorder(config.usageFile);
    return {
        config: () => publicModelConfig(config),
        async generate({provider, model, instructions, input, schema, maxOutputTokens, timeoutMs, maxRetries} = {}) {
            if (!PROVIDERS[provider]) throw new ModelCallError('目前仅支持 deepseek。', {code: 'invalid_provider'});
            const selected = config.providers[provider];
            if (!selected?.apiKey) throw new ModelCallError(`DeepSeek 尚未在本地配置 API 密钥。`, {code: 'not_configured', provider});
            const selectedModel = model || selected.defaultModel;
            if (!selected.models.includes(selectedModel)) throw new ModelCallError(`模型 ${selectedModel} 不在本地允许列表中。`, {code: 'invalid_model', provider});
            if (typeof instructions !== 'string' || !instructions.trim() || typeof input !== 'string' || !input.trim()) throw new ModelCallError('模型指令和输入不能为空。', {code: 'invalid_request', provider});
            assertSchema(schema);
            const tokenLimit = Math.min(boundedInteger(maxOutputTokens, config.maxOutputTokens, 1, MAX_ALLOWED_OUTPUT_TOKENS, 'maxOutputTokens'), config.maxOutputTokens);
            const attemptTimeout = boundedInteger(timeoutMs, config.timeoutMs, 1000, 300000, 'timeoutMs');
            const retries = boundedInteger(maxRetries, config.maxRetries, 0, 3, 'maxRetries');
            const body = deepSeekRequest({model: selectedModel, instructions, input, schema, maxOutputTokens: tokenLimit});
            const started = now();
            let lastError;
            for (let attempt = 1; attempt <= retries + 1; attempt++) {
                try {
                    const data = await fetchAttempt({fetchImpl, endpoint: PROVIDERS[provider].endpoint, apiKey: selected.apiKey, body, timeoutMs: attemptTimeout, provider});
                    const normalized = deepSeekResult(data);
                    try { validateJsonSchema(normalized.output, schema); }
                    catch (error) { throw new ModelCallError(`DeepSeek 返回的 JSON 不符合要求：${error.message}`, {code: 'invalid_response', provider, retryable: true}); }
                    const result = {
                        provider,
                        model: normalized.model || selectedModel,
                        requestId: normalized.requestId,
                        output: normalized.output,
                        usage: normalized.usage,
                        finishReason: normalized.finishReason,
                        attempts: attempt,
                        durationMs: Math.max(0, now() - started)
                    };
                    // A local logging failure must never repeat a successful paid request.
                    try { usageRecorder({timestamp: new Date().toISOString(), ...result}); }
                    catch (_) { result.usageRecordFailed = true; }
                    return result;
                } catch (error) {
                    lastError = error instanceof ModelCallError ? error : new ModelCallError('模型调用失败。', {provider});
                    lastError.attempts = attempt;
                    if (!lastError.retryable || attempt > retries) throw lastError;
                    await sleep(Math.min(2000, 250 * 2 ** (attempt - 1)));
                }
            }
            throw lastError;
        }
    };
}

module.exports = {
    PROVIDERS,
    ModelCallError,
    createModelClient,
    createUsageRecorder,
    loadModelConfig,
    parseEnvFile,
    publicModelConfig,
    validateJsonSchema
};
