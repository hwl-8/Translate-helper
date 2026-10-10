'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {once} = require('node:events');
const {createTranslationService,validateTranslationCard,translationCardWarnings,evaluateCandidates,normalizeInput} = require('./translation-service.cjs');
const {loadModelConfig,createModelClient} = require('./reading-models.cjs');
const {startServer,readLibrary,audit} = require('./reading-server.cjs');

const example = 'A resilient team learns from setbacks.';
const card = {word:'resilient',uk:'rɪˈzɪliənt',us:'rɪˈzɪliənt',pos:'形容词',chinese:'有韧性的；能恢复的',english:'able to recover after difficulty',example,translation:'有韧性的团队从挫折中学习。',evidence:example,uncertain:false};
async function finish(service,id) { for (let i=0;i<100;i++) { const job=service.get(id); if(job.state!=='running') return job; await new Promise(resolve=>setTimeout(resolve,5)); } throw Error('Mock task timed out'); }
(async()=>{
    const original=readLibrary(__dirname), root=fs.mkdtempSync(path.join(os.tmpdir(),'translation-check-'));
    let server;
    try {
        for(const name of ['vocabulary.html','learned_words.json']) fs.copyFileSync(path.join(__dirname,name),path.join(root,name));
        const config={enabled:true,modelConfig:loadModelConfig({root,env:{DEEPSEEK_API_KEY:'mock-only',MODEL_USAGE_FILE:'off'}})};
        const request = (text=example,extra={})=>({requestId:crypto.randomUUID(),input:{type:'text',text},direction:'en-zh',confirm:true,...extra});
        assert.throws(()=>normalizeInput({type:'text',text:''}),e=>e.code==='EMPTY_INPUT');
        assert.throws(()=>normalizeInput({type:'text',text:'😀'.repeat(10001)}),e=>e.code==='INPUT_TOO_LONG');
        const full=normalizeInput({type:'text',text:'😀'.repeat(10000)});
        assert.equal(Array.from(full.text).length,10000); assert.equal(full.chunks.map(c=>c.text).join(''),full.text);
        for(const type of ['url','file']) assert.throws(()=>normalizeInput({type,url:'https://example.org',path:'C:/private'}),e=>e.code==='INPUT_NOT_SUPPORTED');
        const paragraphs=normalizeInput({type:'text',text:'First sentence.\r\n\r\n第二段。'});
        assert.equal(paragraphs.paragraphs.length,2);
        assert.equal(paragraphs.batches.length,1,'Short paragraphs share a model call');
        assert.equal(validateTranslationCard({...card,word:' Resilient '}).word,'resilient');
        for(const bad of [{...card,uk:''},{...card,uncertain:true},{...card,pos:'unknown'},{...card,english:'TODO'},{...card,example:''},{...card,example:'仅中文例句。'}]) assert.throws(()=>validateTranslationCard(bad));
        const inflected = {...card,word:'adapt',pos:'动词',uk:'əˈdæpt',us:'əˈdæpt',chinese:'适应；调整',english:'to change to suit new conditions',example:'The team adapted to change.',translation:'团队适应了变化。',evidence:'Teams adapt to change.'};
        assert.equal(validateTranslationCard(inflected).word,'adapt');
        assert.equal(translationCardWarnings(inflected).length,1);
        assert.deepEqual(translationCardWarnings(card),[]);
        const changedStem={...card,word:'study',pos:'动词',example:'She studied the report.',evidence:'They study the report.'};
        assert.equal(validateTranslationCard(changedStem).word,'study');
        assert.equal(translationCardWarnings(changedStem).length,1,'Stem changes must not become hard errors in another check');
        const evaluated=evaluateCandidates([inflected,{...inflected,uk:''}],inflected.evidence);
        assert(evaluated[0].valid);assert.equal(evaluated[0].warnings.length,1);assert.deepEqual(evaluated[0].issues,[]);
        assert(!evaluated[1].valid,'A yellow warning must not override other missing fields');
        let calls=[], failCandidates=false, failedPiece=false;
        const diagnostics=[];
        const client={generate:async args=>{
            calls.push(args); assert.equal(args.provider,'deepseek'); assert.equal(args.maxRetries,0);
            const input=JSON.parse(args.input);
            if(input.segment){
                if(input.segment.includes('FAIL_ONCE') && !failedPiece){failedPiece=true;throw Object.assign(Error('secret source must not log'),{code:'timeout'});}
                const translated = segment=>({translation:input.direction==='zh-en'?example:'译文：'+segment,analyses:segment.includes('BAD_ANALYSIS')?'bad':[]});
                return {output:input.segments.length>1?{translation:'',translations:input.segments.map(s=>({index:s.index,...translated(s.text)}))}:translated(input.segment),usage:{inputTokens:10,outputTokens:20}};
            }
            if(failCandidates) {failCandidates=false;throw Object.assign(Error('private raw'),{code:'rate_limit'});}
            return {output:{candidates:[card,{...card,word:'complex',example:'A complex system needs care.',evidence:'not in source'}, {...card,word:'incomplete',uk:''}]},usage:{inputTokens:11,outputTokens:21}};
        }};
        const service=createTranslationService({root,config,client,diagnostic:r=>diagnostics.push(r),getWords:()=>original.index.words});
        const input=request(), started=service.start(input);
        assert.equal(service.start(input).id,started.id);
        assert.throws(()=>service.start({...input,input:{type:'text',text:'different'}}),e=>e.code==='REQUEST_ID_CONFLICT');
        let result=await finish(service,started.id);
        assert.equal(calls.length,2);assert.equal(result.state,'complete');assert(result.candidates[0].valid);assert(!result.candidates[1].valid);assert(result.candidates[1].exists);assert(!result.candidates[2].valid);
        assert(!JSON.stringify(diagnostics).includes('private raw'));assert(!JSON.stringify(diagnostics).includes(example));
        assert.equal(service.start(input).id,started.id);assert.equal(calls.length,2);
        const analysis=await finish(service,service.start(request('BAD_ANALYSIS')).id);assert(analysis.warnings.some(w=>w.includes('分析格式')));assert(analysis.paragraphs[0].translation);
        failCandidates=true;
        const partialId=service.start(request()).id;
        result=await finish(service,partialId);assert.equal(result.state,'partial');assert(result.paragraphs[0].translation);assert.equal(result.error.code,'rate_limit');
        let count=calls.length;const retryId=crypto.randomUUID();service.retry(partialId,{confirm:true,requestId:retryId});
        result=await finish(service,partialId);assert.equal(result.state,'complete');assert.equal(calls.length,count+1);service.retry(partialId,{confirm:true,requestId:retryId});assert.equal(calls.length,count+1);
        const pieceId=service.start(request('First.'.repeat(200)+'\n\nFAIL_ONCE\n\nThird.')).id;
        result=await finish(service,pieceId);assert.equal(result.state,'partial');assert.equal(result.paragraphs[0].status,'complete');assert.equal(result.paragraphs[1].status,'failed');assert.equal(result.paragraphs[2].status,'failed');
        count=calls.length;service.retry(pieceId,{confirm:true,requestId:crypto.randomUUID()});result=await finish(service,pieceId);assert.equal(result.state,'complete');assert.equal(calls.length,count+2);
        const bilingual=await finish(service,service.start(request('这是一个有韧性的团队。',{direction:'zh-en'})).id);assert.equal(bilingual.paragraphs[0].translation,example);assert(bilingual.candidates[0].valid);
        const batchShape=await finish(service,service.start(request('One.\n\nTwo.')).id);assert.equal(batchShape.state,'complete');assert.equal(batchShape.paragraphs.length,2);assert(batchShape.paragraphs.every(p=>p.translation && p.status==='complete'));
        const missingService=createTranslationService({root,config,client:{generate:async()=>({output:{translation:'',translations:[]}})},diagnostic:()=>{}});
        const missing=await finish(missingService,missingService.start(request('One.\n\nTwo.')).id);assert.equal(missing.state,'failed');assert(missing.paragraphs.every(p=>p.status==='failed'));
        const disabled=createTranslationService({root,config:{...config,enabled:false},client});assert.throws(()=>disabled.start(request()),e=>e.code==='EXTERNAL_DISABLED');
        for(const status of [401,429,500]) {
            const model=createModelClient({config:config.modelConfig,recordUsage:()=>{},fetchImpl:async()=>new Response('{}',{status})});
            const failing=createTranslationService({root,config,client:model,diagnostic:()=>{}});
            const job=await finish(failing,failing.start(request()).id);assert.equal(job.state,'failed');assert.equal(job.usage.calls,1);assert(job.error.message);
        }
        server=startServer({root,port:0,translationFactory:options=>createTranslationService({...options,config,client,diagnostic:()=>{}})});
        await once(server,'ready');const origin=`http://127.0.0.1:${server.address().port}`;
        const publicConfig=await (await fetch(origin+'/api/translation/config')).json();assert(!JSON.stringify(publicConfig).includes('mock-only'));
        const headers={Origin:origin,'Content-Type':'application/json','X-Reading-Token':publicConfig.token};
        const post=(route,body,extra={})=>fetch(origin+route,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
        const beforeValidation=readLibrary(root), beforeCalls=calls.length;
        const validated=await (await post('/api/translation/candidates/validate',{cards:[inflected,{...inflected,uk:''}],englishText:inflected.evidence})).json();
        assert(validated.candidates[0].valid);assert.equal(validated.candidates[0].warnings.length,1);assert(!validated.candidates[1].valid);
        assert.equal(calls.length,beforeCalls,'History revalidation must not call a model');assert.deepEqual(readLibrary(root),beforeValidation);
        assert.equal((await post('/api/translation/candidates/validate',{cards:[inflected],englishText:42})).status,400);
        assert.equal((await post('/api/translation/words',{confirm:true,items:[{card,reviewed:true}]},{'X-Reading-Token':'wrong'})).status,403);
        assert.equal((await post('/api/translation/jobs',request(),{Origin:'https://evil.test'})).status,403);
        assert.equal((await post('/api/translation/jobs',request(),{Origin:'null'})).status,202);
        let save=await (await post('/api/translation/words',{confirm:true,items:[{card,reviewed:false}]})).json();assert.equal(save.results[0].code,'REVIEW_REQUIRED');
        save=await (await post('/api/translation/words',{confirm:true,items:[{card,reviewed:true},{card:{...card,word:'unfinished',us:''},reviewed:true}]})).json();
        assert.equal(save.results[0].status,'added',JSON.stringify(save));assert.equal(save.results[1].status,'failed');assert(save.results[0].html.includes('翻译学习词'));assert(!save.results[0].html.includes('href='));
        save=await (await post('/api/translation/words',{confirm:true,items:[{card,reviewed:true}]})).json();assert.equal(save.results[0].status,'exists');
        const saved=readLibrary(root);assert.equal(audit(saved.html,saved.index).names.length,original.index.words.length+1);assert.equal(saved.index.words.filter(w=>w==='resilient').length,1);
        save=await(await post('/api/translation/words',{confirm:true,items:[{card:inflected,reviewed:true}]})).json();
        assert.equal(save.results[0].status,'added',JSON.stringify(save));assert(save.results[0].html.includes(inflected.example));
        assert.equal(audit(readLibrary(root).html,readLibrary(root).index).names.length,original.index.words.length+2);
        // Exact failure injection tests the existing transaction, not a mocked success response.
        const before=readLibrary(root), rename=fs.renameSync;let injected=false;
        fs.renameSync=(from,to)=>{if(String(to).endsWith('learned_words.json')&&!injected){injected=true;throw Error('simulated disk failure');}return rename(from,to);};
        try {save=await(await post('/api/translation/words',{confirm:true,items:[{card:{...card,word:'resilience',pos:'名词',chinese:'恢复力；韧性',english:'the ability to recover after difficulty',example:'Resilience helps a team recover.',evidence:'Resilience helps a team recover.'},reviewed:true}]})).json();}finally{fs.renameSync=rename;}
        assert(injected);assert.equal(save.results[0].code,'SAVE_FAILED');assert.deepEqual(readLibrary(root),before);
        assert.deepEqual(readLibrary(__dirname),original);
        console.log(JSON.stringify({result:'PASS',checks:['10000 Unicode boundary; reserved inputs no IO','independent translation and candidate failure','partial chunks retry no repeat','analysis failure keeps usable translation','known/invalid cards; explicit review','auth/rate/server failures no automatic retry','file origin token and secret safety','transactional import, duplicate and disk rollback','formal library unchanged']},null,2));
    } finally {if(server)await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
