const $=s=>document.querySelector(s);
const UI_KEY='textAutoUiV1';
const IMAGE_UI_KEY='imageAutoUiV1';
const refs=window.ChatGptImageRefs;
let poll=null;
let refFiles=[];

function esc(s){return String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));}
function hasChrome(){return typeof chrome!=='undefined'&&!!chrome.runtime?.sendMessage;}
function msg(m){if(!hasChrome())return Promise.resolve({ok:false,error:'NO_EXTENSION_RUNTIME'});return chrome.runtime.sendMessage(m);}
function setStatus(t,err=false){const e=$('#statusLine');e.textContent=t;e.style.color=err?'#ff9aa2':'#aeb8c5';}
function setImageStatus(t,err=false){const e=$('#imageStatus');e.textContent=t;e.style.color=err?'#ff9aa2':'#aeb8c5';}
function chars(){ $('#initialChars').textContent=`${$('#initialText').value.length.toLocaleString()} ký tự`; $('#repeatChars').textContent=`${$('#repeatText').value.length.toLocaleString()} ký tự`; }
function imageLines(){if(!refs)return [];return refs.splitPromptLines($('#imageText').value);}
function refreshImageCount(){ $('#imageLineCount').textContent=`${imageLines().length} dòng`; }
function fileText(file){return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(String(r.result||''));r.onerror=()=>rej(r.error);r.readAsText(file,'utf-8');});}
async function activeChatTab(){if(!hasChrome()||!chrome.tabs)return null;const [tab]=await chrome.tabs.query({active:true,currentWindow:true});if(!tab)return null;return /^https:\/\/(chatgpt\.com|chat\.openai\.com)(?:\/|$)/i.test(String(tab.url||''))?tab:null;}

function showView(which){
  const image=which==='image';
  $('#viewText').hidden=image;
  $('#viewImage').hidden=!image;
  $('#tabText').classList.toggle('active',!image);
  $('#tabImage').classList.toggle('active',image);
  if(hasChrome()&&chrome.storage?.local)chrome.storage.local.set({activeToolView:which});
}

function readUi(){return {
  sendInitial:$('#sendInitial').checked,
  initialText:$('#initialText').value,
  repeatText:$('#repeatText').value,
  repeatCount:Math.max(0,Math.min(9999,Math.floor(Number($('#repeatCount').value||0)))),
  stableSec:Math.max(2,Math.min(60,Number($('#stableSec').value||5))),
  nextDelaySec:Math.max(0,Math.min(60,Number($('#nextDelaySec').value||1))),
  responseTimeoutMin:Math.max(1,Math.min(360,Number($('#responseTimeoutMin').value||30))),
  projectName:String($('#projectName').value||'PROJECT_001'),
  saveEachResponse:$('#saveEachResponse').checked,
  cdpFallback:$('#cdpFallback').checked,
  composerSelector:String($('#composerSelector').value||''),
  sendSelector:String($('#sendSelector').value||'')
};}
function applyUi(v={}){
  if('sendInitial'in v)$('#sendInitial').checked=!!v.sendInitial;
  if('initialText'in v)$('#initialText').value=String(v.initialText??'');
  if('repeatText'in v)$('#repeatText').value=String(v.repeatText??'');
  if('repeatCount'in v)$('#repeatCount').value=v.repeatCount;
  if('stableSec'in v)$('#stableSec').value=v.stableSec;
  if('nextDelaySec'in v)$('#nextDelaySec').value=v.nextDelaySec;
  if('responseTimeoutMin'in v)$('#responseTimeoutMin').value=v.responseTimeoutMin;
  if('projectName'in v)$('#projectName').value=v.projectName;
  if('saveEachResponse'in v)$('#saveEachResponse').checked=!!v.saveEachResponse;
  if('cdpFallback'in v)$('#cdpFallback').checked=!!v.cdpFallback;
  if('composerSelector'in v)$('#composerSelector').value=v.composerSelector||'';
  if('sendSelector'in v)$('#sendSelector').value=v.sendSelector||'';
  chars();
}
function readImageUi(){return {
  imageText:$('#imageText').value,
  imagePrefix:String($('#imagePrefix').value||''),
  imageProject:String($('#imageProject').value||'ANH_001'),
  imageStableSec:Math.max(2,Math.min(60,Number($('#imageStableSec').value||4))),
  imageDelaySec:Math.max(0,Math.min(60,Number($('#imageDelaySec').value||2))),
  imageTimeoutMin:Math.max(1,Math.min(360,Number($('#imageTimeoutMin').value||15))),
  imageCdp:$('#imageCdp').checked,
  plusSelector:String($('#plusSelector').value||''),
  createImageSelector:String($('#createImageSelector').value||'')
};}
function applyImageUi(v={}){
  if('imageText'in v)$('#imageText').value=String(v.imageText??'');
  if('imagePrefix'in v)$('#imagePrefix').value=String(v.imagePrefix??'');
  if('imageProject'in v)$('#imageProject').value=String(v.imageProject??'ANH_001');
  if('imageStableSec'in v)$('#imageStableSec').value=v.imageStableSec;
  if('imageDelaySec'in v)$('#imageDelaySec').value=v.imageDelaySec;
  if('imageTimeoutMin'in v)$('#imageTimeoutMin').value=v.imageTimeoutMin;
  if('imageCdp'in v)$('#imageCdp').checked=!!v.imageCdp;
  if('plusSelector'in v)$('#plusSelector').value=v.plusSelector||'';
  if('createImageSelector'in v)$('#createImageSelector').value=v.createImageSelector||'';
  refreshImageCount();
}

let saveTimer=null;
function scheduleSave(){if(!hasChrome()||!chrome.storage?.local)return;clearTimeout(saveTimer);saveTimer=setTimeout(()=>chrome.storage.local.set({[UI_KEY]:readUi(),[IMAGE_UI_KEY]:readImageUi()}),250);}

function renderFolder(){
  const index=refs.indexRefFiles(refFiles.map(f=>({name:f.name})));
  const keys=Object.keys(index).sort();
  $('#imageFolderInfo').textContent=keys.length?`${keys.length} ảnh khớp mã`:'Chưa có ảnh CHAR_/BG_';
  $('#imageFolderList').textContent=keys.length?keys.join(', '):'Chọn thư mục có file kiểu CHAR_01.png, BG_02.jpg.';
}

async function fileToPayload(file,id){
  const buf=await file.arrayBuffer();
  const bytes=new Uint8Array(buf);
  let bin='';
  const step=0x8000;
  for(let i=0;i<bytes.length;i+=step) bin+=String.fromCharCode(...bytes.subarray(i,i+step));
  return {id,name:file.name,type:file.type||'image/png',data:btoa(bin)};
}

function collectImagePayloads(lines){
  const index=refs.indexRefFiles(refFiles);
  const wanted=new Set();
  const preview=[];
  for(const line of lines){
    const hit=refs.matchLineFiles(line,index);
    preview.push(hit);
    for(const item of hit.found) wanted.add(item.id);
  }
  return {index,wanted:[...wanted],preview};
}

$('#tabText').onclick=()=>showView('text');
$('#tabImage').onclick=()=>showView('image');

$('#initialFile').onchange=async e=>{const f=e.target.files?.[0];if(f){$('#initialText').value=await fileText(f);chars();scheduleSave();}};
$('#repeatFile').onchange=async e=>{const f=e.target.files?.[0];if(f){$('#repeatText').value=await fileText(f);chars();scheduleSave();}};
$('#imageTextFile').onchange=async e=>{const f=e.target.files?.[0];if(f){$('#imageText').value=await fileText(f);refreshImageCount();scheduleSave();}};
$('#imageFolder').onchange=e=>{
  refFiles=[...e.target.files||[]].filter(f=>refs.isImageName(f.name));
  renderFolder();
};
$('#imageText').addEventListener('input',()=>{refreshImageCount();scheduleSave();});
for(const el of document.querySelectorAll('#viewText textarea,#viewText input,#plusSelector,#createImageSelector,#imagePrefix,#imageProject,#imageStableSec,#imageDelaySec,#imageTimeoutMin')){
  el.addEventListener('input',()=>{chars();scheduleSave();});
}
for(const el of document.querySelectorAll('input[type=checkbox]')) el.addEventListener('change',scheduleSave);

function selectors(){return {
  composer:$('#composerSelector').value,
  send:$('#sendSelector').value,
  plus:$('#plusSelector').value,
  createImage:$('#createImageSelector').value
};}

$('#probeBtn').onclick=async()=>{
  const tab=await activeChatTab();if(!tab)return setStatus('Tab hiện tại không phải ChatGPT.',true);
  const r=await msg({type:'PROBE_UI',tabId:tab.id,selectors:selectors()});
  setStatus(r?.ok?`UI OK • composer=${r.composer?'có':'không'} • send=${r.sendButton?'có':'không'} • generating=${r.generating?'có':'không'}`:`UI chưa sẵn sàng: ${r?.error||'UNKNOWN'}`,!r?.ok);
};

$('#imageProbeBtn').onclick=async()=>{
  const tab=await activeChatTab();if(!tab)return setImageStatus('Tab hiện tại không phải ChatGPT.',true);
  const r=await msg({type:'PROBE_UI',tabId:tab.id,selectors:selectors()});
  setImageStatus(r?.ok?`UI OK • cộng=${r.plus?'có':'không'} • tạo ảnh=${r.createImage?'có':'chưa mở menu'} • composer=${r.composer?'có':'không'} • send=${r.sendButton?'có':'không'}`:`UI chưa sẵn sàng: ${r?.error||'UNKNOWN'}`,!r?.ok);
};

$('#startBtn').onclick=async()=>{
  const v=readUi();
  if(v.sendInitial && !v.initialText.trim())return setStatus('Đã bật gửi ban đầu nhưng văn bản ban đầu đang trống.',true);
  if(v.repeatCount>0 && !v.repeatText.trim())return setStatus('Số lần lặp > 0 nhưng văn bản lặp đang trống.',true);
  if(!v.sendInitial && v.repeatCount<=0)return setStatus('Không có lượt nào để gửi.',true);
  const tab=await activeChatTab();if(!tab)return setStatus('Hãy mở đúng cuộc chat ChatGPT rồi bấm CHẠY.',true);
  if(hasChrome()&&chrome.storage?.local)await chrome.storage.local.set({[UI_KEY]:v});
  const r=await msg({type:'START_RUN',tabId:tab.id,config:v});
  setStatus(r?.ok?`Đã bắt đầu trên tab hiện tại • ${v.sendInitial?'1 initial + ':''}${v.repeatCount} lượt lặp.`:`Không chạy được: ${r?.error||'UNKNOWN'}`,!r?.ok);
  refresh();
};
$('#stopBtn').onclick=async()=>{const r=await msg({type:'STOP_RUN'});setStatus(r?.ok?'Đã dừng. Không đóng tab ChatGPT.':`Không dừng được: ${r?.error||'UNKNOWN'}`,!r?.ok);refresh();};
$('#resumeBtn').onclick=async()=>{const tab=await activeChatTab();if(!tab)return setStatus('Hãy mở đúng conversation ChatGPT cần tiếp tục.',true);const r=await msg({type:'RESUME_RUN',tabId:tab.id});setStatus(r?.ok?'Đã nối lại workflow.':`Không nối lại được: ${r?.error||'UNKNOWN'}`,!r?.ok);refresh();};

$('#imageStartBtn').onclick=async()=>{
  try{
    if(!refs)return setImageStatus('Thiếu image_refs.js. Reload extension.',true);
    const lines=imageLines();
    if(!lines.length)return setImageStatus('Chưa có dòng prompt ảnh.',true);
    setImageStatus(`Đang chuẩn bị ${lines.length} dòng…`);
    const tab=await activeChatTab();if(!tab)return setImageStatus('Hãy bấm vào tab ChatGPT rồi bấm TẠO ẢNH. Tool chỉ điều khiển tab đang mở.',true);
    const pack=collectImagePayloads(lines);
    const payloads=[];
    for(const id of pack.wanted){
      const file=pack.index[id];
      if(file) payloads.push(await fileToPayload(file,id));
    }
    const ui=readImageUi();
    if(hasChrome()&&chrome.storage?.local)await chrome.storage.local.set({[IMAGE_UI_KEY]:ui});
    const r=await msg({
      type:'START_IMAGE_RUN',
      tabId:tab.id,
      config:{
        lines,
        outputPrefix:ui.imagePrefix,
        projectName:ui.imageProject,
        stableSec:ui.imageStableSec,
        nextDelaySec:ui.imageDelaySec,
        responseTimeoutMin:ui.imageTimeoutMin,
        cdpFallback:ui.imageCdp,
        selectors:selectors()
      },
      files:payloads
    });
    const missing=pack.preview.flatMap(p=>p.missing);
    setImageStatus(r?.ok?`Đã bắt đầu ${lines.length} dòng • ${payloads.length} ảnh tham chiếu.${missing.length?` Thiếu: ${[...new Set(missing)].join(', ')} (vẫn chạy).`:''}`:`Không chạy được: ${r?.error||'UNKNOWN'}`,!r?.ok);
    refresh();
  }catch(e){setImageStatus(`Lỗi khi bắt đầu: ${e?.message||e}`,true);}
};
$('#imageStopBtn').onclick=async()=>{const r=await msg({type:'STOP_RUN'});setImageStatus(r?.ok?'Đã dừng tạo ảnh.':`Không dừng được: ${r?.error||'UNKNOWN'}`,!r?.ok);refresh();};

function render(run){
  if(!run){$('#progress').textContent='Chưa chạy.';return;}
  const total=Number(run.totalTurns||0),done=(run.outputs||[]).length,p=run.pendingTurn;
  const pct=total?Math.round(done/total*1000)/10:0;
  const kind=run.kind==='IMAGE'?'Tạo ảnh':'Văn bản';
  $('#progress').innerHTML=`<b>${esc(run.status)}</b> • ${esc(kind)} • ${done}/${total} lượt hoàn tất (${pct}%)`+
    (run.kind==='IMAGE'
      ?`<br>Ảnh đã lưu: ${run.savedCount||0}/${total}${run.lastSavedName?` • ${esc(run.lastSavedName)}`:''}`
      :`<br>Initial: ${run.config?.sendInitial?'BẬT':'TẮT'} • Repeat đã gửi: ${run.repeatSent||0}/${run.config?.repeatCount||0}`)+
    `${run.phase?`<br>Pha: <b>${esc(run.phase)}</b>`:''}`+
    `${p?`<br>Lượt hiện tại: ${p.index+1}/${total} • ${esc(p.kind||'')}${p.refIds?.length?` • ${esc(p.refIds.join(', '))}`:''} • ${p.sentConfirmed?'đã xác minh SEND':'chưa xác minh SEND'}`:''}`+
    `${run.lastVerification?`<br>Xác minh gần nhất: ${esc(run.lastVerification)}`:''}`+
    `${run.completionReason?`<br>Kết thúc: ${esc(run.completionReason)}`:''}`+
    `${run.error?`<br><span style="color:#ff9aa2">${esc(run.error)}</span>`:''}`;
  if(run.kind==='IMAGE'){
    if(run.status==='RUNNING')setImageStatus(`Đang chạy: ${run.phase||''} • lượt ${Math.min((run.outputs||[]).length+1,total)}/${total}${run.lastVerification?` • ${run.lastVerification}`:''}`);
    else if(run.error)setImageStatus(run.error,true);
    else if(run.status==='DONE')setImageStatus(`Xong ${done}/${total} ảnh.${run.lastSavedName?` Cuối: ${run.lastSavedName}`:''}`);
  }
}
async function refresh(){
  const r=await msg({type:'GET_STATE'}).catch(()=>null);if(!r?.ok)return;
  render(r.state?.run||null);
  const logs=r.state?.logs||[];$('#logBox').textContent=logs.slice(-80).map(x=>`${String(x.ts||'').slice(11,19)} [${x.level}] ${x.message}${x.data?' '+JSON.stringify(x.data):''}`).join('\n');
}
(async()=>{
  if(!refs){setImageStatus('Thiếu image_refs.js',true);return;}
  if(!hasChrome()){chars();refreshImageCount();showView('text');setStatus('Bản xem giao diện (không phải extension).');return;}
  const bag=await chrome.storage.local.get([UI_KEY,IMAGE_UI_KEY,'activeToolView']);
  if(bag[UI_KEY])applyUi(bag[UI_KEY]);else chars();
  if(bag[IMAGE_UI_KEY])applyImageUi(bag[IMAGE_UI_KEY]);else refreshImageCount();
  showView(bag.activeToolView==='image'?'image':'text');
  await refresh();
  poll=setInterval(refresh,1200);
})();
