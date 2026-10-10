'use strict';
const {PROJECT_ROOT} = require('../../server/project-paths.cjs');

const fs = require('node:fs');
const path = require('node:path');
const {parseEnvFile} = require('../../server/reading-models.cjs');

const SEARCH_PROVIDERS = Object.freeze({
    tavily: 'https://api.tavily.com/search'
});
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

class SearchError extends Error {
    constructor(message, {code = 'search_error', provider, status, retryable = false, attempts = 0} = {}) {
        super(message); this.name = 'SearchError'; this.code = code; this.provider = provider; this.status = status; this.retryable = retryable; this.attempts = attempts;
    }
}

function bounded(value, fallback, min, max, label) {
    if (value == null || value === '') return fallback;
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) throw Error(`${label} 必须是 ${min}–${max} 的整数`);
    return number;
}

function loadSearchConfig({root = PROJECT_ROOT, env = process.env} = {}) {
    root = path.resolve(root);
    const file = path.join(root, '.env');
    const values = {...(fs.existsSync(file) ? parseEnvFile(fs.readFileSync(file, 'utf8')) : {}), ...env};
    return {
        timeoutMs: bounded(values.SEARCH_TIMEOUT_MS, 15000, 1000, 60000, 'SEARCH_TIMEOUT_MS'),
        maxRetries: bounded(values.SEARCH_MAX_RETRIES, 1, 0, 2, 'SEARCH_MAX_RETRIES'),
        maxResults: bounded(values.SEARCH_MAX_RESULTS, 5, 1, 10, 'SEARCH_MAX_RESULTS'),
        providers: {
            tavily: {apiKey: values.TAVILY_API_KEY || ''}
        }
    };
}

function publicSearchConfig(config) {
    return {timeoutMs: config.timeoutMs, maxRetries: config.maxRetries, maxResults: config.maxResults, providers: {
        tavily: {configured: Boolean(config.providers.tavily.apiKey)}
    }};
}

function plain(value, max = 50000) {
    return String(value || '').replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/\s+/g, ' ').trim().slice(0, max);
}

function canonicalUrl(value) {
    let url;
    try { url = new URL(value); } catch (_) { return null; }
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
    return url.href;
}

function normalizeResults(provider, data, maxResults) {
    const source = data?.results;
    if (!Array.isArray(source)) throw new SearchError('搜索服务响应中缺少结果数组。', {code: 'invalid_response', provider, retryable: true});
    const seen = new Set(), results = [];
    for (const item of source) {
        const url = canonicalUrl(item?.url);
        if (!url || seen.has(url)) continue;
        const title = plain(item.title, 500), snippet = plain(item.description ?? item.content, 5000);
        if (!title || !snippet) continue;
        seen.add(url);
        results.push({
            title, url, snippet,
            rawContent: plain(item.raw_content, 120000),
            publishedDate: plain(item.published_date ?? item.age ?? item.date, 100)
        });
        if (results.length >= maxResults) break;
    }
    if (!results.length) throw new SearchError('搜索服务没有返回可用的 HTTPS 来源。', {code: 'no_results', provider});
    return results;
}

function requestFor(provider, query, config, maxResults) {
    return {
        url: SEARCH_PROVIDERS.tavily,
        options: {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${config.providers.tavily.apiKey}`}, body: JSON.stringify({query, topic: 'general', search_depth: 'basic', max_results: maxResults, include_answer: false, include_images: false, include_raw_content: 'text'})}
    };
}

function searchHttpError(provider, status) {
    const label = 'Tavily';
    if ([401, 403].includes(status)) return new SearchError(`${label} 配置或访问权限无效。`, {code: 'authentication', provider, status});
    if (status === 429) return new SearchError(`${label} 已达到请求频率或额度限制。`, {code: 'rate_limit', provider, status, retryable: true});
    if ([408, 409, 500, 502, 503, 504].includes(status)) return new SearchError(`${label} 暂时不可用（HTTP ${status}）。`, {code: 'service_unavailable', provider, status, retryable: true});
    return new SearchError(`${label} 请求失败（HTTP ${status}）。`, {code: 'request_failed', provider, status});
}

async function fetchJson(fetchImpl, request, timeoutMs, provider) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl(request.url, {...request.options, signal: controller.signal});
        if (!response.ok) throw searchHttpError(provider, response.status);
        const declared = Number(response.headers?.get?.('content-length'));
        if (declared > MAX_RESPONSE_BYTES) throw new SearchError('搜索响应超过 4 MiB 限制。', {code: 'response_too_large', provider});
        const text = await response.text();
        if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new SearchError('搜索响应超过 4 MiB 限制。', {code: 'response_too_large', provider});
        try { return JSON.parse(text); } catch (_) { throw new SearchError('搜索服务返回内容不是有效 JSON。', {code: 'invalid_response', provider, retryable: true}); }
    } catch (error) {
        if (controller.signal.aborted || error?.name === 'AbortError') throw new SearchError('搜索请求超时。', {code: 'timeout', provider, retryable: true});
        if (error instanceof SearchError) throw error;
        throw new SearchError('搜索服务网络连接失败。', {code: 'network', provider, retryable: true});
    } finally { clearTimeout(timer); }
}

function createSearchClient({config = loadSearchConfig(), fetchImpl = globalThis.fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => new Date()} = {}) {
    return {
        config: () => publicSearchConfig(config),
        async search({provider, query, maxResults, maxAttempts} = {}) {
            if (provider !== 'tavily') throw new SearchError('目前仅支持 tavily。', {code: 'invalid_provider'});
            if (typeof query !== 'string' || !query.trim() || query.length > 600 || query.trim().split(/\s+/).length > 75) throw new SearchError('检索词不能为空，且不得超过 600 字符或 75 个词。', {code: 'invalid_request', provider});
            if (!config.providers.tavily.apiKey) throw new SearchError('Tavily 尚未在本地配置。', {code: 'not_configured', provider});
            const count = bounded(maxResults, config.maxResults, 1, config.maxResults, 'maxResults');
            const attemptsLimit = bounded(maxAttempts, config.maxRetries + 1, 1, config.maxRetries + 1, 'maxAttempts');
            const request = requestFor(provider, query.trim(), config, count);
            let last;
            for (let attempt = 1; attempt <= attemptsLimit; attempt++) {
                try {
                    const data = await fetchJson(fetchImpl, request, config.timeoutMs, provider);
                    const results = normalizeResults(provider, data, count);
                    return {provider, query: query.trim(), retrievedAt: now().toISOString(), attempts: attempt, results, usage: {
                        requests: attempt,
                        credits: provider === 'tavily' && Number.isFinite(Number(data?.usage?.credits)) ? Number(data.usage.credits) : null,
                        estimatedCostUsd: null,
                        actualCostUsd: null
                    }};
                } catch (error) {
                    last = error; last.attempts = attempt;
                    if (!last.retryable || attempt === attemptsLimit) throw last;
                    await sleep(Math.min(1000, 200 * 2 ** (attempt - 1)));
                }
            }
            throw last;
        }
    };
}

module.exports = {SEARCH_PROVIDERS, SearchError, canonicalUrl, createSearchClient, loadSearchConfig, normalizeResults, plain, publicSearchConfig};
