'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');
const {canonicalUrl, plain} = require('./reading-search.cjs');

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const ALLOWED_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain'];

class SourceError extends Error {
    constructor(message, code = 'source_error') { super(message); this.name = 'SourceError'; this.code = code; }
}

function privateAddress(address) {
    if (net.isIPv4(address)) {
        const p = address.split('.').map(Number);
        return p[0] === 10 || p[0] === 127 || p[0] === 0 || p[0] === 169 && p[1] === 254 || p[0] === 172 && p[1] >= 16 && p[1] <= 31 || p[0] === 192 && p[1] === 168 || p[0] >= 224;
    }
    if (net.isIPv6(address)) {
        const value = address.toLowerCase().split('%')[0];
        return value === '::1' || value === '::' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb');
    }
    return true;
}

async function assertPublicHttps(value, lookup = dns.lookup) {
    const url = canonicalUrl(value);
    if (!url) throw new SourceError('正文来源必须是无账号信息的 HTTPS 网址。', 'unsafe_url');
    const parsed = new URL(url);
    if (parsed.hostname === 'localhost' || net.isIP(parsed.hostname) && privateAddress(parsed.hostname)) throw new SourceError('拒绝访问本机或内网来源。', 'unsafe_url');
    let addresses;
    try { addresses = await lookup(parsed.hostname, {all: true, verbatim: true}); }
    catch (_) { throw new SourceError('无法解析正文来源域名。', 'dns_error'); }
    if (!Array.isArray(addresses) || !addresses.length || addresses.some(item => privateAddress(item.address))) throw new SourceError('正文来源解析到本机、内网或无效地址。', 'unsafe_url');
    return url;
}

function extractText(raw, contentType = 'text/html') {
    let text = String(raw || '');
    if (!contentType.startsWith('text/plain')) {
        text = text.replace(/<!--[^]*?-->/g, ' ').replace(/<(script|style|noscript|svg|template|iframe)\b[^]*?<\/\1\s*>/gi, ' ');
    }
    return plain(text, 160000);
}

async function fetchSource(url, {fetchImpl = globalThis.fetch, lookup = dns.lookup, timeoutMs = 15000, maxRedirects = 3} = {}) {
    let current = await assertPublicHttps(url, lookup);
    for (let redirects = 0; redirects <= maxRedirects; redirects++) {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
        let response;
        try { response = await fetchImpl(current, {method: 'GET', redirect: 'manual', headers: {Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9', 'User-Agent': 'TranslateHelper/1.0'}, signal: controller.signal}); }
        catch (error) {
            if (controller.signal.aborted || error?.name === 'AbortError') throw new SourceError('获取来源正文超时。', 'timeout');
            throw new SourceError('获取来源正文时网络连接失败。', 'network');
        } finally { clearTimeout(timer); }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            if (redirects === maxRedirects) throw new SourceError('来源网页重定向次数过多。', 'redirect_limit');
            const location = response.headers.get('location');
            if (!location) throw new SourceError('来源网页重定向缺少目标地址。', 'bad_redirect');
            current = await assertPublicHttps(new URL(location, current).href, lookup);
            continue;
        }
        if (!response.ok) throw new SourceError(`来源网页返回 HTTP ${response.status}。`, 'http_error');
        const type = String(response.headers.get('content-type') || '').split(';')[0].toLowerCase();
        if (!ALLOWED_TYPES.includes(type)) throw new SourceError(`不支持的正文类型：${type || 'unknown'}。`, 'unsupported_type');
        const declared = Number(response.headers.get('content-length'));
        if (declared > MAX_SOURCE_BYTES) throw new SourceError('来源正文超过 2 MiB 限制。', 'too_large');
        const raw = await response.text();
        if (Buffer.byteLength(raw, 'utf8') > MAX_SOURCE_BYTES) throw new SourceError('来源正文超过 2 MiB 限制。', 'too_large');
        const content = extractText(raw, type);
        if (content.length < 300) throw new SourceError('来源网页没有足够的可用正文。', 'too_short');
        return {url: current, content, bytes: Buffer.byteLength(raw, 'utf8')};
    }
    throw new SourceError('无法获取来源正文。');
}

async function collectSources(searchBundles, supplements = [], options = {}) {
    const maxSources = Number.isInteger(options.maxSources) ? options.maxSources : 8;
    const website = [], skipped = [], seen = new Set();
    for (const bundle of searchBundles) for (const result of bundle.results || []) {
        if (website.length >= maxSources) break;
        const url = canonicalUrl(result.url);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        try {
            const fetched = result.rawContent && result.rawContent.length >= 300
                ? {url, content: extractText(result.rawContent, 'text/plain'), bytes: Buffer.byteLength(result.rawContent)}
                : await fetchSource(url, options);
            website.push({id: `web-${website.length + 1}`, title: plain(result.title, 500), url: fetched.url, date: plain(result.publishedDate || '检索时获取', 100), sourceType: 'website', content: fetched.content, bytes: fetched.bytes});
        } catch (error) { skipped.push({url, reason: error.message}); }
    }
    const auxiliary = [];
    for (const item of supplements) {
        if (auxiliary.length >= 4) break;
        const type = item?.sourceType;
        const content = extractText(item?.content, 'text/plain');
        const url = canonicalUrl(item?.url);
        if (!['input_file', 'user_input'].includes(type) || !url || content.length < 100) { skipped.push({title: plain(item?.title, 100), reason: '辅助材料缺少类型、HTTPS 来源或足够正文'}); continue; }
        auxiliary.push({id: `aux-${auxiliary.length + 1}`, title: plain(item.title, 500), url, date: plain(item.date || '用户提供', 100), sourceType: type, content, bytes: Buffer.byteLength(String(item.content || ''), 'utf8')});
    }
    if (!website.length && !auxiliary.length) throw new SourceError('没有取得可用于生成的正文。', 'no_sources');
    return {sources: [...website, ...auxiliary], websiteCount: website.length, auxiliaryCount: auxiliary.length, skipped};
}

module.exports = {MAX_SOURCE_BYTES, SourceError, assertPublicHttps, collectSources, extractText, fetchSource, privateAddress};
