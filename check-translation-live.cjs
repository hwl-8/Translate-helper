'use strict';
// Explicit opt-in only. Never included in npm test. No search service is loaded here.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {createBudget} = require('./translation-budget.cjs');
const {createTranslationService,loadTranslationConfig,normalizeInput,evaluateCandidates,candidateInstructions,candidateSchema,safeIssue} = require('./translation-service.cjs');
const {createModelClient} = require('./reading-models.cjs');
const samples = require('./translation-live-samples.cjs');
const {readLibrary,audit} = require('./reading-server.cjs');

(async()=>{
    if (!process.argv.includes('--live') || !process.argv.includes('--authorize-cny=5')) throw Error('必须显式指定 --live --authorize-cny=5；本工具不会复用旧预算。');
    const original=readLibrary(__dirname), skill=fs.readFileSync(path.join(__dirname,'translation_skill.md'));
    const loaded=loadTranslationConfig({root:__dirname});
    if (!loaded.modelConfig.providers.deepseek.apiKey) throw Error('本机未配置 DeepSeek 密钥，尚未发起请求。');
    if (!loaded.modelConfig.providers.deepseek.models.includes('deepseek-flash')) throw Error('deepseek-flash 不在本机允许列表中，尚未发起请求。');
    const ledger=path.join(__dirname,'.translation-live-budget.json');
    const budget=createBudget({filename:ledger,maxCny:4,maxCalls:20,model:'deepseek-flash',rates:{input:2,output:8},pricingDate:'2026-10-10'});
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'translation-live-'));
    const output=path.join(__dirname,'output','翻译真实验收-2026-10-10.json');
    const previous=process.argv.includes('--resume') && fs.existsSync(output) ? JSON.parse(fs.readFileSync(output,'utf8')) : null;
    const results=previous?.results || [], protocol=[];
    try {
        for(const file of ['vocabulary.html','learned_words.json']) fs.copyFileSync(path.join(__dirname,file),path.join(root,file));
        // Real key remains in memory. No .env or credentials are copied to fixtures.
        const modelConfig={...loaded.modelConfig,usageFile:null,maxOutputTokens:Math.min(6000,loaded.modelConfig.maxOutputTokens)};
        const client=createModelClient({config:modelConfig,fetchImpl:async(url,args)=>{
            const response=await fetch(url,args);
            if(response.ok) {
                try {
                    const data=await response.clone().json(), content=data.choices?.[0]?.message?.content;
                    const record={finishReason:data.choices?.[0]?.finish_reason,contentType:typeof content};
                    try {const json=JSON.parse(content);record.keys=Object.keys(json).map(k=>['translation','translations','analyses','candidates'].includes(k)?k:'<other>');if(Array.isArray(json.candidates))record.candidateCount=json.candidates.length;if(Array.isArray(json.translations))record.translationCount=json.translations.length;}
                    catch(_){record.jsonSyntaxValid=false;record.fenced=typeof content==='string' && /^\s*```/.test(content);}
                    protocol.push(record);
                }catch(_){protocol.push({envelopeInvalid:true});}
            }
            return response;
        }});
        const service=createTranslationService({root,config:{enabled:true,modelConfig},client,budget,getWords:()=>audit(original.html,original.index).names});
        for(const sample of samples){
            const existing=results.find(r=>r.sample===sample.name);
            if(existing?.state==='complete')continue;
            const completedPrefix=[];
            if(existing?.stage==='translation')for(const paragraph of existing.paragraphs){if(paragraph.status!=='complete' || paragraph.translationCharacters!==Array.from(paragraph.translationPreview).length)break;completedPrefix.push(paragraph);}
            const runText=completedPrefix.length ? normalizeInput({type:'text',text:sample.text}).paragraphs.slice(completedPrefix.length).join('\n\n') : sample.text;
            const normalized=normalizeInput({type:'text',text:runText});
            const before=budget.snapshot();
            if(before.calls>=20 || before.reservedCny>=4) break;
            console.log(JSON.stringify({event:'starting',sample:sample.name,characters:Array.from(sample.text).length,estimatedCalls:normalized.batches.length+1,reservedCny:before.reservedCny}));
            if(existing?.stage==='candidates' && sample.direction==='en-zh') {
                // Reuse the genuinely completed translation; only retry extraction.
                const args={provider:'deepseek',model:'deepseek-flash',instructions:candidateInstructions,input:JSON.stringify({englishText:sample.text}),schema:candidateSchema,maxOutputTokens:modelConfig.maxOutputTokens,maxRetries:0};
                const reservation=budget.reserve(args);
                try {const result=await client.generate(args);budget.settle(reservation,{usage:result.usage});existing.candidates=evaluateCandidates(result.output.candidates,sample.text,original.index.words);existing.state='complete';existing.error=null;existing.usage.calls++;existing.usage.inputTokens+=result.usage.inputTokens;existing.usage.outputTokens+=result.usage.outputTokens;}
                catch(err){budget.settle(reservation,{errorCode:err.code});existing.error=safeIssue(err);console.log(JSON.stringify({event:'retry-failed',sample:sample.name,error:existing.error,protocol:protocol.at(-1)}));}
                continue;
            }
            let result=service.start({requestId:crypto.randomUUID(),input:{type:'text',text:runText},direction:sample.direction,model:'deepseek-flash',confirm:true});
            let lastCalls=-1;
            while(result.state==='running'){
                if(result.usage.calls!==lastCalls){lastCalls=result.usage.calls;console.log(JSON.stringify({event:'progress',sample:sample.name,stage:result.stage,calls:lastCalls,completedParagraphs:result.paragraphs.filter(p=>p.status==='complete').length}));}
                await new Promise(resolve=>setTimeout(resolve,1000));result=service.get(result.id);
            }
            const usage=completedPrefix.length ? Object.fromEntries(['calls','inputTokens','outputTokens'].map(key=>[key,(existing.usage[key] || 0)+(result.usage[key] || 0)])) : result.usage;
            const item={sample:sample.name,direction:sample.direction,characters:Array.from(sample.text).length,state:result.state,stage:result.stage,error:result.error,paragraphs:[...completedPrefix,...result.paragraphs.map(p=>({characters:Array.from(p.original).length,translationCharacters:Array.from(p.translation).length,status:p.status,translationPreview:p.translation.slice(0,240),analyses:p.analyses}))],candidates:result.candidates,warnings:[...result.warnings,...(completedPrefix.length?['验收续译复用了前次完整译文；本次候选从剩余英语段落提取。']:[])],usage};
            if(existing){item.previousAttempts=[...(existing.previousAttempts || []),{state:existing.state,error:existing.error,usage:existing.usage}];results[results.indexOf(existing)]=item;}else results.push(item);
            console.log(JSON.stringify({event:'finished',sample:sample.name,state:result.state,error:result.error,validCandidates:result.candidates.filter(c=>c.valid).length,calls:result.usage.calls,reservedCny:budget.snapshot().reservedCny,protocol:protocol.at(-1)}));
            if(['authentication','budget_unavailable','budget_blocked','budget_exhausted','call_limit'].includes(result.error?.code))break;
        }
        if(JSON.stringify(readLibrary(__dirname))!==JSON.stringify(original) || !fs.readFileSync(path.join(__dirname,'translation_skill.md')).equals(skill))throw Error('正式数据发生意外变化。');
        const report={date:'2026-10-10',mode:'live',provider:'deepseek',model:'deepseek-flash',authorizationCny:5,searchRequests:0,budget:budget.snapshot(),protocol:[...(previous?.protocol || []),...protocol],results,formalCounts:{html:audit(original.html,original.index).names.length,json:original.index.words.length},limitations:['费用按接口用量及保守高峰价估算，未核对账户账单','候选释义、音标、分析仍需人工核对；程序检查不保证完整语义准确','本工具真实验证翻译服务；浏览器交互、入库及故障另使用隔离模拟验收']};
        fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
        console.log(JSON.stringify({report:path.basename(output),calls:report.budget.calls,reservedCny:report.budget.reservedCny,estimatedCny:report.budget.records.reduce((sum,r)=>sum+r.estimatedCny,0),actualBillCny:null,completed:results.filter(r=>r.state==='complete').length,attempted:results.length}));
    } finally {fs.rmSync(root,{recursive:true,force:true});}
})().catch(error=>{console.error('真实验收停止：'+(error.code || 'PRECHECK_FAILED')+'。请检查本地配置、预算账本或网络；不会输出密钥或原文。');process.exitCode=1;});
