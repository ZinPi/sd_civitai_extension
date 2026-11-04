importScripts('image_refs.js');
const STORAGE_KEY='chatgptTextAutoStateV1';
const imageRefs=self.ChatGptImageRefs;
const DEFAULTS={stableSec:5,nextDelaySec:1,responseTimeoutMin:30,saveEachResponse:true,cdpFallback:true,composerSelector:'',sendSelector:''};
let state={run:null,logs:[]};
let loaded=false;
const ready=(async()=>{const got=await chrome.storage.local.get(STORAGE_KEY);if(got[STORAGE_KEY])state=got[STORAGE_KEY];loaded=true;})();

chrome.runtime.onInstalled.addListener(()=>{try{chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true});}catch(_){}});
chrome.runtime.onStartup.addListener(()=>{try{chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true});}catch(_){}});

function nowIso(){return new Date().toISOString();}
function uid(p='id'){return `${p}_${Date.now()}_${Math.random().toString(36).slice(2,9)}`;}
function safeName(s){return String(s||'PROJECT_001').trim().replace(/[\\/:*?"<>|]/g,'_').slice(0,120)||'PROJECT_001';}
function clone(v){return JSON.parse(JSON.stringify(v));}
function persistableState(){
  const run=state.run,pending=run?.pendingTurn,keep=pending?.refFiles;
  if(pending&&keep)pending.refFiles=keep.map(f=>({id:f.id,name:f.name,type:f.type}));
  try{return clone(state);}finally{if(pending&&keep)pending.refFiles=keep;}
}
function log(level,message,data=null){state.logs ||= [];state.logs.push({ts:nowIso(),level,message,data});if(state.logs.length>300)state.logs.splice(0,state.logs.length-300);save();}
let saveTimer=null;
function save(){clearTimeout(saveTimer);saveTimer=setTimeout(()=>chrome.storage.local.set({[STORAGE_KEY]:persistableState()}),80);}
async function saveNow(){clearTimeout(saveTimer);await chrome.storage.local.set({[STORAGE_KEY]:persistableState()});}
function isChatUrl(u=''){return /^https:\/\/(chatgpt\.com|chat\.openai\.com)(?:\/|$)/i.test(String(u||''));}
function conversationId(u=''){try{const x=new URL(u);const m=x.pathname.match(/(?:^|\/)c\/([^/?#]+)/i);return m?m[1]:'';}catch(_){return '';}}

const CONTENT_VERSION='1.0.7';
const IMAGE_CHUNK=3500000;
async function pingContent(tabId){try{return await chrome.tabs.sendMessage(tabId,{type:'PING_TEXT_AUTO'});}catch(_){return null;}}
async function waitTabComplete(tabId,ms=15000){
  const end=Date.now()+ms;
  while(Date.now()<end){
    const tab=await chrome.tabs.get(tabId).catch(()=>null);
    if(tab?.status==='complete'&&isChatUrl(tab.url||'')){await new Promise(r=>setTimeout(r,500));return true;}
    await new Promise(r=>setTimeout(r,200));
  }
  return false;
}
async function ensureContent(tabId){
  let p=await pingContent(tabId);
  if(p?.ok&&p.version===CONTENT_VERSION)return {ok:true,method:'PING'};
  if(p?.ok&&p.version!==CONTENT_VERSION){
    await chrome.tabs.reload(tabId);
    await waitTabComplete(tabId);
    p=await pingContent(tabId);
    if(p?.ok&&p.version===CONTENT_VERSION)return {ok:true,method:'RELOAD'};
  }
  try{
    await chrome.scripting.executeScript({target:{tabId},files:['content.js']});
    await new Promise(r=>setTimeout(r,400));
    p=await pingContent(tabId);
    if(p?.ok&&p.version===CONTENT_VERSION)return {ok:true,method:'INJECT'};
    await chrome.tabs.reload(tabId);
    await waitTabComplete(tabId);
    p=await pingContent(tabId);
    if(p?.ok&&p.version===CONTENT_VERSION)return {ok:true,method:'RELOAD_AFTER_INJECT'};
  }catch(e){return {ok:false,error:String(e?.message||e)};}
  return {ok:false,error:'CONTENT_SCRIPT_UNAVAILABLE'};
}
async function validateTarget(run,tabId){
  let tab;try{tab=await chrome.tabs.get(tabId);}catch(_){return {ok:false,error:'TARGET_TAB_NOT_FOUND'};}
  if(!isChatUrl(tab.url||''))return {ok:false,error:'TARGET_TAB_NOT_CHATGPT'};
  const id=conversationId(tab.url||'');
  if(run.conversationId && id && id!==run.conversationId)return {ok:false,error:'CONVERSATION_CHANGED'};
  if(run.conversationId && !id && /\/c\//.test(String(run.conversationUrl||'')))return {ok:false,error:'CONVERSATION_CHANGED'};
  if(!run.conversationId && id)run.conversationId=id;
  run.conversationUrl=tab.url||run.conversationUrl;
  return {ok:true,tab};
}
function totalTurns(cfg){return (cfg.sendInitial?1:0)+Number(cfg.repeatCount||0);}
function payloadFor(run,index){
  if(run.config.sendInitial && index===0)return {kind:'INITIAL',text:run.initialText};
  const ordinal=index-(run.config.sendInitial?1:0)+1;
  return {kind:`REPEAT_${ordinal}`,text:run.repeatText};
}

async function startRun(tabId,config){
  if(state.run?.status==='RUNNING')return {ok:false,error:'RUN_ALREADY_RUNNING'};
  tabId=Number(tabId);if(!tabId)return {ok:false,error:'NO_TAB'};
  let tab;try{tab=await chrome.tabs.get(tabId);}catch(_){return {ok:false,error:'TAB_NOT_FOUND'};}
  if(!isChatUrl(tab.url||''))return {ok:false,error:'TAB_NOT_CHATGPT'};
  const cfg={...DEFAULTS,...config};
  cfg.sendInitial=cfg.sendInitial!==false;
  cfg.initialText=String(config?.initialText??'');cfg.repeatText=String(config?.repeatText??'');
  cfg.repeatCount=Math.max(0,Math.min(9999,Math.floor(Number(cfg.repeatCount||0))));
  cfg.stableSec=Math.max(2,Math.min(60,Number(cfg.stableSec||5)));
  cfg.nextDelaySec=Math.max(0,Math.min(60,Number(cfg.nextDelaySec||1)));
  cfg.responseTimeoutMin=Math.max(1,Math.min(360,Number(cfg.responseTimeoutMin||30)));
  if(cfg.sendInitial && !cfg.initialText.trim())return {ok:false,error:'INITIAL_TEXT_EMPTY'};
  if(cfg.repeatCount>0 && !cfg.repeatText.trim())return {ok:false,error:'REPEAT_TEXT_EMPTY'};
  if(!cfg.sendInitial && cfg.repeatCount===0)return {ok:false,error:'NO_TURNS'};
  const cs=await ensureContent(tabId);if(!cs.ok)return cs;
  state.run={id:uid('run'),kind:'TEXT',status:'RUNNING',phase:'READY',startedAt:nowIso(),finishedAt:null,targetTabId:tabId,conversationUrl:tab.url||'',conversationId:conversationId(tab.url||''),config:{sendInitial:cfg.sendInitial,repeatCount:cfg.repeatCount,stableSec:cfg.stableSec,nextDelaySec:cfg.nextDelaySec,responseTimeoutMin:cfg.responseTimeoutMin,saveEachResponse:cfg.saveEachResponse!==false,cdpFallback:cfg.cdpFallback!==false,composerSelector:String(cfg.composerSelector||''),sendSelector:String(cfg.sendSelector||'')},initialText:cfg.initialText,repeatText:cfg.repeatText,projectName:safeName(cfg.projectName),totalTurns:totalTurns(cfg),repeatSent:0,outputs:[],outputMeta:[],pendingTurn:null,error:'',completionReason:'',lastVerification:''};
  log('INFO','Started long-payload text run',{tabId,totalTurns:state.run.totalTurns,initialChars:cfg.initialText.length,repeatChars:cfg.repeatText.length,repeatCount:cfg.repeatCount});
  await saveNow();setTimeout(()=>pump().catch(e=>failRun(String(e?.message||e))),150);return {ok:true,runId:state.run.id};
}
async function pump(){
  const run=state.run;if(!run||run.kind==='IMAGE'||run.status!=='RUNNING'||run.pendingTurn)return;
  const index=run.outputs.length;
  if(index>=run.totalTurns)return finishRun('ALL_TURNS_COMPLETED');
  const target=await validateTarget(run,run.targetTabId);if(!target.ok)return failRun(target.error);
  const cs=await ensureContent(run.targetTabId);if(!cs.ok)return failRun(cs.error);
  const p=payloadFor(run,index);
  const turn={id:uid('turn'),index,kind:p.kind,prompt:p.text,startedAt:nowIso(),sentConfirmed:false,stage:'PREPARE',conversationId:run.conversationId||conversationId(target.tab.url||''),baseline:null};
  run.pendingTurn=turn;run.phase='PREPARE_TURN';save();
  const r=await chrome.tabs.sendMessage(run.targetTabId,{type:'RUN_TEXT_TURN',turn,settings:{stableSec:run.config.stableSec,responseTimeoutMin:run.config.responseTimeoutMin,cdpFallback:run.config.cdpFallback,selectors:{composer:run.config.composerSelector,send:run.config.sendSelector}}}).catch(e=>({ok:false,error:String(e?.message||e)}));
  if(!r?.ok)return failRun(r?.error||'TURN_START_FAILED');
}
async function finishRun(reason){const run=state.run;if(!run)return;run.status='DONE';run.phase='DONE';run.finishedAt=nowIso();run.completionReason=reason;run.pendingTurn=null;await exportCombined(run);log('INFO','Run completed',{reason,turns:run.outputs.length});await saveNow();}
function failRun(err){const run=state.run;if(!run||run.status!=='RUNNING')return;const error=String(err||'UNKNOWN_ERROR');if(/STOPPED_BY_USER/.test(error)){run.status='STOPPED';run.phase='STOPPED_BY_USER';run.completionReason='USER_STOP';run.finishedAt=nowIso();save();return;}run.status='STOPPED';run.phase='ERROR';run.error=error;run.finishedAt=nowIso();log('ERROR','Run stopped',{error:run.error,turn:run.pendingTurn?.index+1});save();abortTab(run.targetTabId);}
async function abortTab(tabId){if(!tabId)return;try{await chrome.tabs.sendMessage(tabId,{type:'ABORT_TEXT_AUTO'});}catch(_){}}
async function stopRun(){await ready;if(!state.run)return {ok:false,error:'NO_RUN'};state.run.status='STOPPED';state.run.phase='STOPPED_BY_USER';state.run.finishedAt=nowIso();state.run.completionReason='USER_STOP';save();await abortTab(state.run.targetTabId);return {ok:true};}
async function resumeRun(tabId){
  await ready;const run=state.run;if(!run||run.status!=='STOPPED')return {ok:false,error:'RUN_NOT_STOPPED'};
  tabId=Number(tabId||run.targetTabId);let tab;try{tab=await chrome.tabs.get(tabId);}catch(_){return {ok:false,error:'TAB_NOT_FOUND'};}
  if(!isChatUrl(tab.url||''))return {ok:false,error:'TAB_NOT_CHATGPT'};
  const id=conversationId(tab.url||'');if(run.conversationId&&id&&id!==run.conversationId)return {ok:false,error:'CONVERSATION_CHANGED'};
  const cs=await ensureContent(tabId);if(!cs.ok)return cs;
  if(run.pendingTurn && !run.pendingTurn.sentConfirmed && /SEND_CONFIRM_UNCERTAIN/.test(String(run.error||''))) return {ok:false,error:'UNCERTAIN_SEND: hãy kiểm tra cuộc chat trước khi tạo run mới; tool không tự gửi lại để tránh trùng.'};
  run.targetTabId=tabId;run.conversationUrl=tab.url||run.conversationUrl;if(!run.conversationId&&id)run.conversationId=id;run.status='RUNNING';run.error='';run.finishedAt=null;
  if(run.kind==='IMAGE'){
    if(run.pendingTurn?.sentConfirmed){run.outputs[run.pendingTurn.index]=run.outputs[run.pendingTurn.index]||'IMAGE_RESUME_SKIPPED';run.pendingTurn=null;}
    else run.pendingTurn=null;
    run.phase='READY';save();setTimeout(()=>pumpImage().catch(e=>failRun(String(e?.message||e))),150);return {ok:true};
  }
  if(run.pendingTurn?.sentConfirmed){run.phase='RECOVER_WAIT_RESPONSE';save();const rr=await chrome.tabs.sendMessage(tabId,{type:'RECOVER_TEXT_TURN',turn:run.pendingTurn,settings:{stableSec:run.config.stableSec,responseTimeoutMin:run.config.responseTimeoutMin,cdpFallback:run.config.cdpFallback,selectors:{composer:run.config.composerSelector,send:run.config.sendSelector}}}).catch(e=>({ok:false,error:String(e?.message||e)}));if(!rr?.ok)return failRun(rr?.error||'RECOVERY_START_FAILED'),{ok:false,error:rr?.error};}
  else {run.pendingTurn=null;run.phase='READY';save();setTimeout(()=>pump().catch(e=>failRun(String(e?.message||e))),150);}
  return {ok:true};
}

let autoRecoverBusy=false;
async function nudgePendingResponse(tabId,reason='NUDGE'){
  await ready;const run=state.run,turn=run?.pendingTurn;
  if(autoRecoverBusy||!run||run.kind==='IMAGE'||run.status!=='RUNNING'||!turn?.sentConfirmed||Number(tabId)!==Number(run.targetTabId))return;
  autoRecoverBusy=true;
  try{
    const target=await validateTarget(run,run.targetTabId);if(!target.ok)return;
    const cs=await ensureContent(run.targetTabId);if(!cs.ok)return;
    const ping=await chrome.tabs.sendMessage(run.targetTabId,{type:'PING_TEXT_AUTO'}).catch(()=>null);
    if(ping?.activeTurnId===turn.id||ping?.activeTurnId)return;
    const rr=await chrome.tabs.sendMessage(run.targetTabId,{type:'RECOVER_TEXT_TURN',turn,settings:{stableSec:run.config.stableSec,responseTimeoutMin:run.config.responseTimeoutMin,cdpFallback:run.config.cdpFallback,selectors:{composer:run.config.composerSelector,send:run.config.sendSelector}}}).catch(e=>({ok:false,error:String(e?.message||e)}));
    if(rr?.ok){run.phase='RECOVER_WAIT_RESPONSE';log('INFO','Auto recovery attached',{reason,turn:turn.index+1,tabId:run.targetTabId});save();}
  }finally{autoRecoverBusy=false;}
}
chrome.tabs.onActivated.addListener(info=>{nudgePendingResponse(info.tabId,'TAB_ACTIVATED').catch(()=>{});});
chrome.tabs.onUpdated.addListener((tabId,changeInfo)=>{if(changeInfo.status==='complete')nudgePendingResponse(tabId,'TAB_RELOADED_OR_RESTORED').catch(()=>{});});
ready.then(()=>setTimeout(()=>{const id=state.run?.targetTabId;if(id)nudgePendingResponse(id,'SERVICE_WORKER_RESTART').catch(()=>{});},800));

async function onTextEvent(tabId,event){
  const run=state.run,turn=run?.pendingTurn;if(!run||run.kind==='IMAGE'||run.status!=='RUNNING'||tabId!==run.targetTabId)return {ok:false,error:'RUN_NOT_ACTIVE'};
  if(turn&&event.turnId&&turn.id!==event.turnId)return {ok:false,error:'STALE_TURN_EVENT'};
  if(event.kind==='PROGRESS'){run.phase=event.phase||run.phase;if(event.verification)run.lastVerification=event.verification;save();return {ok:true};}
  if(event.kind==='SENT'){
    if(!turn)return {ok:false,error:'NO_PENDING_TURN'};
    turn.sentConfirmed=true;turn.stage='WAIT_RESPONSE';turn.sentAt=nowIso();turn.baseline=event.baseline||turn.baseline;
    if(turn.kind.startsWith('REPEAT_'))run.repeatSent++;
    run.phase='WAIT_RESPONSE';run.lastVerification=event.verification||'SEND_CONFIRMED';save();log('INFO','Send confirmed',{turn:turn.index+1,kind:turn.kind,method:event.method||'',chars:turn.prompt.length});return {ok:true};
  }
  if(event.kind==='FAILED'){return failRun(event.error||event.detail||'TURN_FAILED'),{ok:true};}
  if(event.kind==='DONE'){
    if(!turn)return {ok:false,error:'NO_PENDING_TURN'};
    const out=String(event.text||'');run.outputs[turn.index]=out;run.outputMeta[turn.index]={finishedAt:nowIso(),method:event.method||'',chars:out.length,kind:turn.kind};run.pendingTurn=null;run.phase='TURN_DONE';
    if(run.config.saveEachResponse!==false)await downloadText(run,`PART_${String(turn.index+1).padStart(3,'0')}.txt`,out);
    log('INFO','Response complete',{turn:turn.index+1,chars:out.length,method:event.method||''});save();
    if(run.outputs.length>=run.totalTurns)return finishRun('ALL_TURNS_COMPLETED'),{ok:true};
    setTimeout(()=>pump().catch(e=>failRun(String(e?.message||e))),Math.max(0,Number(run.config.nextDelaySec||0))*1000);return {ok:true};
  }
  return {ok:true};
}
let imageFileStore={};
let imageChunkBuf={};

function clearImageFiles(){imageFileStore={};imageChunkBuf={};return {ok:true};}
function storeImageChunk(msg){
  const id=String(msg.id||'').toUpperCase();
  if(!id)return {ok:false,error:'NO_IMAGE_ID'};
  const total=Math.max(1,Number(msg.total||1));
  const index=Math.max(0,Number(msg.index||0));
  imageChunkBuf[id]||={name:msg.name||`${id}.png`,type:msg.mime||'image/png',chunks:[],total};
  imageChunkBuf[id].name=msg.name||imageChunkBuf[id].name;
  imageChunkBuf[id].type=msg.mime||imageChunkBuf[id].type;
  imageChunkBuf[id].total=total;
  imageChunkBuf[id].chunks[index]=String(msg.data||'');
  const got=imageChunkBuf[id].chunks.filter(x=>typeof x==='string').length;
  if(got>=total){
    imageFileStore[id]={id,name:imageChunkBuf[id].name,type:imageChunkBuf[id].type,data:imageChunkBuf[id].chunks.join('')};
    delete imageChunkBuf[id];
    return {ok:true,stored:true,id};
  }
  return {ok:true,stored:false,id,got,total};
}
function getImageFileMeta(id){
  const file=imageFileStore[String(id||'').toUpperCase()];
  if(!file)return {ok:false,error:'FILE_NOT_STORED'};
  const total=Math.max(1,Math.ceil(String(file.data||'').length/IMAGE_CHUNK));
  return {ok:true,id:file.id,name:file.name,type:file.type,total};
}
function getImageFileChunk(id,index){
  const file=imageFileStore[String(id||'').toUpperCase()];
  if(!file)return {ok:false,error:'FILE_NOT_STORED'};
  const i=Math.max(0,Number(index||0));
  return {ok:true,id:file.id,index:i,data:String(file.data||'').slice(i*IMAGE_CHUNK,(i+1)*IMAGE_CHUNK)};
}

function filesForLine(line){
  const ids=imageRefs.parseRefIds(line);
  return ids.filter(id=>!!imageFileStore[id]);
}

async function startImageRun(tabId,config){
  if(!imageRefs)return {ok:false,error:'IMAGE_REFS_MISSING: reload extension trên chrome://extensions'};
  if(state.run?.status==='RUNNING')return {ok:false,error:'RUN_ALREADY_RUNNING'};
  tabId=Number(tabId);if(!tabId)return {ok:false,error:'NO_TAB'};
  let tab;try{tab=await chrome.tabs.get(tabId);}catch(_){return {ok:false,error:'TAB_NOT_FOUND'};}
  if(!isChatUrl(tab.url||''))return {ok:false,error:'TAB_NOT_CHATGPT'};
  const fromCfg=imageRefs.splitPromptLines(Array.isArray(config?.lines)?config.lines.join('\n'):String(config?.lines||''));
  if(!fromCfg.length)return {ok:false,error:'NO_IMAGE_LINES'};
  const cs=await ensureContent(tabId);if(!cs.ok)return cs;
  await abortTab(tabId);
  const prefix=imageRefs.sanitizePrefix(config?.outputPrefix||'');
  state.run={id:uid('img'),kind:'IMAGE',status:'RUNNING',phase:'READY',startedAt:nowIso(),finishedAt:null,targetTabId:tabId,conversationUrl:tab.url||'',conversationId:conversationId(tab.url||''),config:{stableSec:Math.max(2,Math.min(60,Number(config?.stableSec||4))),nextDelaySec:Math.max(0,Math.min(60,Number(config?.nextDelaySec||2))),responseTimeoutMin:Math.max(1,Math.min(360,Number(config?.responseTimeoutMin||15))),cdpFallback:config?.cdpFallback!==false,composerSelector:String(config?.selectors?.composer||''),sendSelector:String(config?.selectors?.send||''),plusSelector:String(config?.selectors?.plus||''),createImageSelector:String(config?.selectors?.createImage||'')},lines:fromCfg,outputPrefix:prefix,projectName:safeName(config?.projectName||'ANH_001'),totalTurns:fromCfg.length,outputs:[],outputMeta:[],savedCount:0,lastSavedName:'',pendingTurn:null,error:'',completionReason:'',lastVerification:''};
  log('INFO','Started image run',{tabId,totalTurns:fromCfg.length,refFiles:Object.keys(imageFileStore).length,prefix:prefix||'ANH'});
  await saveNow();setTimeout(()=>pumpImage().catch(e=>failRun(String(e?.message||e))),150);return {ok:true,runId:state.run.id};
}

async function pumpImage(){
  const run=state.run;if(!run||run.kind!=='IMAGE'||run.status!=='RUNNING'||run.pendingTurn)return;
  const index=run.outputs.length;
  if(index>=run.totalTurns)return finishImageRun('ALL_TURNS_COMPLETED');
  const target=await validateTarget(run,run.targetTabId);if(!target.ok)return failRun(target.error);
  const cs=await ensureContent(run.targetTabId);if(!cs.ok)return failRun(cs.error);
  const prompt=run.lines[index];
  const refIds=imageRefs.parseRefIds(prompt);
  const turn={id:uid('imgturn'),index,kind:`IMAGE_${index+1}`,prompt,refIds,startedAt:nowIso(),sentConfirmed:false,stage:'PREPARE',conversationId:run.conversationId||conversationId(target.tab.url||'')};
  run.pendingTurn=turn;run.phase='PREPARE_TURN';save();
  const payload={type:'RUN_IMAGE_TURN',turn:{id:turn.id,index:turn.index,kind:turn.kind,prompt,refIds},settings:{stableSec:run.config.stableSec,responseTimeoutMin:run.config.responseTimeoutMin,cdpFallback:run.config.cdpFallback,selectors:{composer:run.config.composerSelector,send:run.config.sendSelector,plus:run.config.plusSelector,createImage:run.config.createImageSelector}}};
  let r=await chrome.tabs.sendMessage(run.targetTabId,payload).catch(e=>({ok:false,error:String(e?.message||e)}));
  if(!r?.ok&&/UNKNOWN_MESSAGE|Receiving end does not exist/i.test(String(r?.error||''))){
    const cs2=await ensureContent(run.targetTabId);if(!cs2.ok)return failRun(cs2.error);
    r=await chrome.tabs.sendMessage(run.targetTabId,payload).catch(e=>({ok:false,error:String(e?.message||e)}));
  }
  if(!r?.ok)return failRun(r?.error||'IMAGE_TURN_START_FAILED');
}

async function finishImageRun(reason){const run=state.run;if(!run)return;run.status='DONE';run.phase='DONE';run.finishedAt=nowIso();run.completionReason=reason;run.pendingTurn=null;log('INFO','Image run completed',{reason,turns:run.outputs.length,saved:run.savedCount});await saveNow();}

async function onImageEvent(tabId,event){
  const run=state.run,turn=run?.pendingTurn;if(!run||run.kind!=='IMAGE'||run.status!=='RUNNING'||tabId!==run.targetTabId)return {ok:false,error:'RUN_NOT_ACTIVE'};
  if(turn&&event.turnId&&turn.id!==event.turnId)return {ok:false,error:'STALE_TURN_EVENT'};
  if(event.kind==='PROGRESS'){run.phase=event.phase||run.phase;if(event.verification)run.lastVerification=event.verification;save();return {ok:true};}
  if(event.kind==='SENT'){if(!turn)return {ok:false,error:'NO_PENDING_TURN'};turn.sentConfirmed=true;turn.stage='WAIT_IMAGE';turn.sentAt=nowIso();run.phase='WAIT_IMAGE';run.lastVerification=event.verification||'SEND_CONFIRMED';save();log('INFO','Image send confirmed',{turn:turn.index+1,refs:turn.refIds,method:event.method||''});return {ok:true};}
  if(event.kind==='FAILED'){return failRun(event.error||event.detail||'IMAGE_TURN_FAILED'),{ok:true};}
  if(event.kind==='DONE'){
    if(!turn)return {ok:false,error:'NO_PENDING_TURN'};
    run.outputs[turn.index]=event.text||`IMAGE_${turn.index+1}`;
    const saved=await saveGeneratedImage(run,turn.index+1,event.image);
    run.outputMeta[turn.index]={finishedAt:nowIso(),method:event.method||'',refs:turn.refIds,savedName:saved.name,chars:(event.text||'').length};
    if(saved.name){run.savedCount++;run.lastSavedName=saved.name;}
    run.pendingTurn=null;run.phase='TURN_DONE';
    log('INFO','Image turn complete',{turn:turn.index+1,saved:saved.name||'',refs:turn.refIds});save();
    if(run.outputs.length>=run.totalTurns)return finishImageRun('ALL_TURNS_COMPLETED'),{ok:true};
    setTimeout(()=>pumpImage().catch(e=>failRun(String(e?.message||e))),Math.max(0,Number(run.config.nextDelaySec||0))*1000);return {ok:true};
  }
  return {ok:true};
}

async function saveGeneratedImage(run,number,image){
  if(!image?.data)return {name:''};
  const ext=(String(image.mime||'image/png').split('/')[1]||'png').replace('jpeg','jpg');
  const name=imageRefs.outputName(run.outputPrefix,number,ext);
  try{
    const bin=atob(image.data);
    const bytes=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
    const url=URL.createObjectURL(new Blob([bytes],{type:image.mime||'image/png'}));
    try{
      await chrome.downloads.download({url,filename:`ChatGPT_Text_Auto/${safeName(run.projectName)}/${name}`,saveAs:false,conflictAction:'uniquify'});
    }finally{URL.revokeObjectURL(url);}
    return {name};
  }catch(e){
    log('WARN','Image download failed',{name,error:String(e?.message||e)});
    return {name:''};
  }
}

async function downloadText(run,name,text){
  try{const root='ChatGPT_Text_Auto';const data='data:text/plain;charset=utf-8,'+encodeURIComponent(text||'');await chrome.downloads.download({url:data,filename:`${root}/${safeName(run.projectName)}/${name}`,saveAs:false,conflictAction:'overwrite'});}catch(e){log('WARN','Download failed',{name,error:String(e?.message||e)});}
}
async function exportCombined(run){const joined=(run.outputs||[]).map((x,i)=>`===== PART ${String(i+1).padStart(3,'0')} =====\n${x||''}`).join('\n\n');await downloadText(run,'FINAL_COMBINED.txt',joined);}

async function withDebugger(tabId,fn){
  const target={tabId};let attached=false;
  try{await chrome.debugger.attach(target,'1.3');attached=true;return await fn(target);}finally{if(attached)try{await chrome.debugger.detach(target);}catch(_){}}
}
async function cdpInsert(tabId,text){return withDebugger(tabId,t=>chrome.debugger.sendCommand(t,'Input.insertText',{text:String(text??'')}));}
async function cdpEnter(tabId){return withDebugger(tabId,async t=>{await chrome.debugger.sendCommand(t,'Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});await chrome.debugger.sendCommand(t,'Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});});}

chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
  (async()=>{await ready;switch(msg?.type){
    case 'GET_STATE':return {ok:true,state:persistableState()};
    case 'START_RUN':return startRun(msg.tabId,msg.config||{});
    case 'CLEAR_IMAGE_FILES':return clearImageFiles();
    case 'STORE_IMAGE_CHUNK':return storeImageChunk(msg);
    case 'GET_IMAGE_FILE_META':return getImageFileMeta(msg.id);
    case 'GET_IMAGE_FILE_CHUNK':return getImageFileChunk(msg.id,msg.index);
    case 'START_IMAGE_RUN':return startImageRun(msg.tabId,msg.config||{});
    case 'STOP_RUN':return stopRun();
    case 'RESUME_RUN':return resumeRun(msg.tabId);
    case 'TEXT_EVENT':return onTextEvent(sender.tab?.id,msg.event||{});
    case 'IMAGE_EVENT':return onImageEvent(sender.tab?.id,msg.event||{});
    case 'PROBE_UI':{const tabId=Number(msg.tabId);const cs=await ensureContent(tabId);if(!cs.ok)return cs;return chrome.tabs.sendMessage(tabId,{type:'PROBE_TEXT_UI',selectors:msg.selectors||{}});}
    case 'CDP_INSERT_TEXT':if(!sender.tab?.id)return {ok:false,error:'NO_SENDER_TAB'};try{await cdpInsert(sender.tab.id,msg.text||'');return {ok:true};}catch(e){return {ok:false,error:String(e?.message||e)};}
    case 'CDP_PRESS_ENTER':if(!sender.tab?.id)return {ok:false,error:'NO_SENDER_TAB'};try{await cdpEnter(sender.tab.id);return {ok:true};}catch(e){return {ok:false,error:String(e?.message||e)};}
    default:return {ok:false,error:'UNKNOWN_MESSAGE'};
  }})().then(sendResponse).catch(e=>sendResponse({ok:false,error:String(e?.message||e)}));return true;
});
