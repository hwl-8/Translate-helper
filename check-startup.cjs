'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {once} = require('node:events');
const {spawn} = require('node:child_process');
const {runServerCLI, openVocabulary} = require('./reading-server.cjs');

async function runBatch(root, fail = false) {
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', '启动词库.cmd', '--no-open'], {
        cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '', paused = false;
    child.stdout.on('data', chunk => {
        stdout += chunk.toString('utf8');
        if (stdout.includes('Press any key') && !paused) { paused = true; child.stdin.write('\r\n'); }
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    const timer = setTimeout(() => child.kill(), 10000);
    try {
        const [code] = await once(child, 'exit');
        assert.equal(code, fail ? 1 : 0, stdout + stderr);
        assert.equal(stderr, '', 'cmd.exe must not report truncated or unknown commands');
        assert(stdout.includes('Starting vocabulary service...'));
        assert.equal(paused, fail, 'Failures must remain visible until a key is pressed');
        const calls = fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
        assert.equal(calls.length, 1, 'One double-click starts exactly one Node process');
        assert.deepEqual(calls[0], ['--open', '--no-open']);
    } finally { clearTimeout(timer); child.stdin.destroy(); }
}

(async () => {
    const batch = fs.readFileSync(path.join(__dirname, '启动词库.cmd'));
    assert(batch.every(byte => byte < 128), 'Batch commands stay ASCII to avoid codepage-dependent parsing');
    assert(!/(?<!\r)\n/.test(batch.toString()), 'Windows batch must use CRLF, including after future edits');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vocabulary-startup-'));
    const root = path.join(temp, "中文路径 & space ' test");
    fs.mkdirSync(root);
    let server;
    try {
        fs.copyFileSync(path.join(__dirname, '启动词库.cmd'), path.join(root, '启动词库.cmd'));
        const stub = 'require("fs").appendFileSync(require("path").join(__dirname,"calls.jsonl"),JSON.stringify(process.argv.slice(2))+"\\n");';
        if (process.platform === 'win32') {
            fs.writeFileSync(path.join(root, 'reading-server.cjs'), stub);
            await runBatch(root);
            fs.unlinkSync(path.join(root, 'calls.jsonl'));
            fs.writeFileSync(path.join(root, 'reading-server.cjs'), stub + 'process.exitCode=17;');
            await runBatch(root, true);

            // Execute the exact encoded command through Windows PowerShell, replacing only
            // its OS browser launch with an output capture; never open a user's browser in tests.
            const target = path.join(root, 'vocabulary.html'), capture = path.join(root, 'opened-path.txt');
            const opened = await openVocabulary(target, {spawn: (exe, args, options) => {
                assert.equal(options.windowsHide, true);
                const encodedIndex = args.indexOf('-EncodedCommand') + 1;
                const command = Buffer.from(args[encodedIndex], 'base64').toString('utf16le');
                assert(!command.includes(target));
                const captureCommand = command.replace('[System.Diagnostics.Process]::Start($startInfo) | Out-Null', '$startInfo.FileName | Set-Content -Encoding UTF8 -LiteralPath $env:TRANSLATE_HELPER_CAPTURE');
                assert.notEqual(command, captureCommand);
                args[encodedIndex] = Buffer.from(captureCommand, 'utf16le').toString('base64');
                return spawn(exe, args, {...options, env: {...options.env, TRANSLATE_HELPER_CAPTURE: capture}});
            }});
            assert.equal(opened, true);
            assert.equal(fs.readFileSync(capture, 'utf8').replace(/^\uFEFF/, '').trim(), target);
        }
        for (const name of ['vocabulary.html', 'learned_words.json']) fs.copyFileSync(path.join(__dirname, name), path.join(root, name));
        const opened = [];
        server = runServerCLI({root, port: 0, open: true, opener: file => opened.push(file)});
        await once(server, 'ready');
        assert.equal(opened.length, 1);
        const port = server.address().port;
        assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);
        const duplicate = runServerCLI({root, port, open: true, opener: file => opened.push(file)});
        // EADDRINUSE is expected and handled by runServerCLI, so do not use once()'s error rejection.
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(Error('Service reuse timed out')), 5000);
            duplicate.once('reused', () => { clearTimeout(timer); resolve(); });
        });
        assert.equal(opened.length, 2, 'Each explicit launch opens the page once, while reusing the one server');
        assert(server.listening);
        assert.equal(process.exitCode || 0, 0);
    } finally {
        if (server?.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
        fs.rmSync(temp, {recursive: true, force: true});
    }
    console.log(JSON.stringify({result: 'PASS', checks: ['real cmd.exe executes the batch', 'CRLF and ASCII launcher', 'Chinese/space/metacharacter paths', 'single server invocation', 'startup error pauses visibly', 'Windows PowerShell path transfer', 'healthy startup before opening', 'repeat launch reuses the server']}, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
