window.KOTOBA_PUBLIC=true;
import {displayCues, clamp, cueAt, playbackWindow, nextQueueIndex, formatTime, validateCueEdits} from './player-core.mjs';

const $ = id => document.getElementById(id);
const audio = $('audio');
const publicSite = window.KOTOBA_PUBLIC === true;
let staticAdapter;
const paths = {
  play:'<path d="m9 5 11 7-11 7z"/>', pause:'<path d="M8 5v14M16 5v14" stroke-width="3"/>',
  previous:'<path d="M5 5v14m14-14L8 12l11 7z"/>', next:'<path d="M19 5v14M5 5l11 7-11 7z"/>',
  plus:'<path d="M12 5v14M5 12h14"/>', x:'<path d="m6 6 12 12M6 18 18 6"/>',
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  star:'<path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.4l6.1-.9z"/>',
  repeat:'<path d="m17 2 4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4m14-1v2a3 3 0 0 1-3 3H3"/>',
  volume:'<path d="m11 4-6 5H2v6h3l6 5zM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  mute:'<path d="m11 4-6 5H2v6h3l6 5zM16 9l6 6m-6 0 6-6"/>',
  download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>', upload:'<path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5"/>',
  locate:'<circle cx="12" cy="12" r="6"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4"/>',
  list:'<path d="M8 6h13M8 12h13M8 18h13M3 6h.1M3 12h.1M3 18h.1"/>',
  save:'<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2Z"/><path d="M7 3v6h10V3M7 21v-8h10v8"/>',
  help:'<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4m0 3h.01"/>',
  keyboard:'<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.1M10 9h.1M14 9h.1M18 9h.1M6 12h.1M10 12h.1M14 12h.1M18 12h.1M7 16h10"/>',
  menu:'<path d="M4 6h16M4 12h16M4 18h16"/>', 'arrow-right':'<path d="M4 12h16m-6-6 6 6-6 6"/>',
  up:'<path d="m6 14 6-6 6 6"/>', down:'<path d="m6 10 6 6 6-6"/>', check:'<path d="m5 12 4 4L19 6"/>'
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.play}</svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safe = (key, fallback) => {try {return JSON.parse(localStorage.getItem(key)) ?? fallback;} catch {return fallback;}};
const state = {material:null,cues:[],queue:[],saved:[],range:{a:null,b:null},mode:'off',anchor:null,queueIndex:0,window:{start:0,end:0,clip:false},sourceKey:null,sourceVersion:0,pendingPosition:null,loadVersion:0,active:null,follow:true,shiftAnchor:null,job:null,jobFailures:0,sections:[],importType:'text',importStep:1,lastSave:0,loading:false,practiceTab:'queue',rangePicking:null,ttsReady:null,completedMaterial:null,importBusy:false};
let settings = safe('kotoba:v1:settings',{ruby:true,fontSize:20,speed:1,volume:.8});
let rowMap = new Map(), cueMap = new Map(), tokenNodes = new Map();
let scrollProgrammaticUntil = 0, toastTimer, pollTimer, playbackRequested = false, playRequestVersion = 0;

function hydrateIcons(root = document) { root.querySelectorAll('[data-icon]').forEach(el => {el.innerHTML = icon(el.dataset.icon);el.removeAttribute('data-icon');}); }
hydrateIcons();
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => {$('toast').hidden = true;}, 3400); }
function notice(message) { $('notice').textContent = message || ''; $('notice').hidden = !message; }
async function api(url, options = {}) {
  if(publicSite){staticAdapter??=import('./static-library.mjs');return (await staticAdapter).staticApi(url,options);}
  const response = await fetch(url,options); let body;
  try { body = await response.json(); } catch { throw new Error(`服务暂时没有响应（${response.status}）。请检查本机服务。`); }
  if (!response.ok) { const error = new Error(typeof body.detail === 'string' ? body.detail : body.error || body.message || `请求失败（${response.status}）`); error.status = response.status; throw error; }
  return body;
}
const post = (url, body) => api(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
function globalTime() { return state.pendingPosition ?? ((audio.currentTime || 0) + (publicSite?0:state.window.start)); }
function saveState() {
  if (!state.material || state.loading) return;
  try {
    localStorage.setItem(`kotoba:v1:material:${state.material.id}`,JSON.stringify({position:globalTime(),queue:state.queue,saved:state.saved,range:state.range,mode:state.mode,anchor:state.anchor,queueIndex:state.queueIndex}));
    localStorage.setItem('kotoba:v1:lastMaterial',JSON.stringify(state.material.id));
    localStorage.setItem('kotoba:v1:settings',JSON.stringify(settings));
  } catch { notice('浏览器存储已满，播放进度暂时无法保存；音频文件仍保存在本机。'); }
}
function applySettings() {
  document.body.classList.toggle('hide-ruby',!settings.ruby);
  document.documentElement.style.setProperty('--reading-size',`${settings.fontSize}px`);
  $('rubyToggle').setAttribute('aria-pressed',String(settings.ruby));
  $('rubyState').textContent=settings.ruby?'显示':'隐藏';
  $('rubyToggle').setAttribute('aria-label',`振假名：${settings.ruby?'显示':'隐藏'}`);
  $('fontSize').value = String(settings.fontSize); $('speed').value = String(settings.speed); $('volume').value = String(settings.volume);
  audio.playbackRate = Number(settings.speed); audio.volume = Number(settings.volume);
}
applySettings();

async function refreshLibrary(preferred) {
  const {materials,storageWarning} = await api('/api/materials');state.storageWarning=storageWarning||'';
  $('materialSelect').innerHTML = materials.map(m => `<option value="${esc(m.id)}">${esc(m.title)}</option>`).join('');
  if (!materials.length) { $('reader').innerHTML = '<div class="initial-state"><p>导入第一份文稿，开始听读。</p><button class="button" id="firstImport">导入资料</button></div>'; $('firstImport').onclick = openImport; return; }
  const id = preferred || safe('kotoba:v1:lastMaterial',null);
  await loadMaterial(materials.find(m => m.id === id)?.id || materials[0].id);
}
async function loadMaterial(id) {
  const requestVersion = ++state.loadVersion;
  saveState(); pausePlayback(); state.loading = true;
  try {
    const material = await api(`/api/materials/${encodeURIComponent(id)}`);
    if (requestVersion !== state.loadVersion) return;
    state.material = material; state.cues = displayCues(material); cueMap = new Map(state.cues.map(c => [c.id,c]));
    const saved = safe(`kotoba:v1:material:${id}`,{});
    state.queue = (saved.queue || []).filter(id => cueMap.has(id));
    state.saved = (saved.saved || []).map(s => ({...s,ids:s.ids.filter(id => cueMap.has(id))}));
    state.range = saved.range || {a:null,b:null};
    if (!cueMap.has(state.range.a)) state.range.a = null; if (!cueMap.has(state.range.b)) state.range.b = null;
    state.mode = saved.mode || 'off'; if (state.mode === 'queue' && !state.queue.length || state.mode === 'range' && (!state.range.a || !state.range.b)) state.mode = 'off';
    state.anchor = cueMap.has(saved.anchor) ? saved.anchor : state.cues[0]?.id; state.queueIndex = clamp(saved.queueIndex || 0,0,Math.max(0,state.queue.length - 1));
    state.active = null; state.sourceKey = null; state.shiftAnchor = null; state.rangePicking = null; state.follow = true;
    $('materialSelect').value = id; $('materialTitle').textContent = material.title;
    $('materialMeta').textContent = `${material.questions.length} 题 · ${formatTime(material.duration)}`;
    $('questionCount').textContent = material.questions.length;
    $('downloadAudio').href = material.audioUrl; $('downloadAudio').download = `${material.title}.mp3`;
    $('totalTime').textContent = formatTime(material.duration); $('seek').max = material.duration;
    $('playingTitle').textContent = material.title; $('playingSubtitle').textContent = material.voice || '本机音频'; $('playButton').disabled = false;
    $('questionSearch').value = ''; renderNav(); renderDocument(); renderQueue(); renderRange(); updateFollow();
    state.loading = false; configurePlayback(clamp(saved.position || 0,0,material.duration),false); updateProgress(true);
    if (/asr|transcri/i.test(String(material.source)) || material.cues.some(c => c.timing === 'asr')) notice('这份字幕由本机自动识别生成，可通过「校正文稿」调整文字和时间。'); else notice(state.storageWarning||'');
    setupMediaSession(); closeDrawers();
  } catch(error) {if (requestVersion !== state.loadVersion) return; state.loading = false;notice(error.message);throw error;}
}
function renderNav() {
  const query = $('questionSearch').value.trim().toLowerCase();
  const questions = state.material.questions.filter(q => !query || `${q.title} ${state.cues.filter(c => c.questionId === q.id).map(c => c.text).join(' ')}`.toLowerCase().includes(query));
  $('questionNav').innerHTML = questions.length ? questions.map(q => `<button class="nav-item" data-question="${esc(q.id)}"><span class="nav-number">${String(q.number).padStart(2,'0')}</span><span>${esc(q.title)}<small>${formatTime(Math.max(0,q.end-q.start))}</small></span></button>`).join('') : '<p class="no-results">没有匹配的题目</p>';
  highlightNav();
}
function labelFor(kind) {return ({question:'问题',answer:'回答',followup_question:'追问',followup_answer:'回答',student_backup_label:'备用提问',student_backup_question:'提问内容'})[kind] || '文稿';}
function renderTokens(cue) {
  const tokens = cue.tokens?.length ? cue.tokens : [{text:cue.text}];
  return tokens.map((token,i) => `<span class="word" data-word="${i}">${token.reading && token.reading !== token.text ? `<ruby>${esc(token.text)}<rt>${esc(token.reading)}</rt></ruby>` : esc(token.text)}</span>`).join('');
}
function renderDocument() {
  const material = state.material;
  let html = `<div class="document"><div class="doc-intro"><span class="pill">${material.source === 'imported' ? '导入音频' : '日语 · 听读'}</span><span>${material.questions.length} 个小节</span><span>·</span><span>${formatTime(material.duration)}</span><span>·</span><span>点击句子，从这里开始</span></div>`;
  if(!state.cues.length) html+='<div class="audio-only-message"><h2>音频已就绪</h2><p>这份音频没有同步字幕，可以直接播放、调速和整份循环。导入时附上 SRT / VTT 字幕，即可按句跳转与复读。</p></div>';
  for (const q of material.questions) {
    html += `<section class="question-block" id="question-${esc(q.id)}" data-qid="${esc(q.id)}"><div class="question-heading"><div class="question-heading-left"><span class="question-index">${String(q.number).padStart(2,'0')}</span><div><h2>${esc(q.title)}</h2><div class="time">${formatTime(q.start)} — ${formatTime(q.end)}</div></div></div><div class="question-heading-actions"><button class="icon-button" data-play-question="${esc(q.id)}" aria-label="播放第 ${q.number} 题" title="从本题开始">${icon('play')}</button><button class="icon-button" data-pick-question="${esc(q.id)}" aria-label="将第 ${q.number} 题加入重点" title="整题加入重点">${icon('star')}</button></div></div>`;
    let previousKind, previousFollowup, groupOpen = false;
    for (const cue of state.cues.filter(c => c.questionId === q.id)) {
      if (cue.kind !== previousKind || cue.followupNumber !== previousFollowup) {
        if (groupOpen) html += '</div>';
        if (cue.followupNumber && cue.followupNumber !== previousFollowup) html += `<div class="followup-heading">追问 ${esc(cue.followupNumber)}</div>`;
        html += `<div class="cue-group"><div class="cue-label ${cue.kind.includes('question')?'question-label':''}">${labelFor(cue.kind)}</div>`; groupOpen = true;
      }
      html += `<div class="cue-row" id="cue-${esc(cue.id)}" data-cue="${esc(cue.id)}"><button class="cue-text" data-start-cue="${esc(cue.id)}" lang="ja" aria-label="从 ${formatTime(cue.start)} 播放：${esc(cue.text)}">${renderTokens(cue)}</button><button class="icon-button cue-star${state.queue.includes(cue.id)?' picked':''}" data-pick="${esc(cue.id)}" aria-label="${state.queue.includes(cue.id)?'移出':'加入'}重点：${esc(cue.text.slice(0,25))}" aria-pressed="${state.queue.includes(cue.id)}" title="加入 / 移出重点">${icon('star')}</button></div>`;
      previousKind = cue.kind; previousFollowup = cue.followupNumber;
    }
    if (groupOpen) html += '</div>'; html += '</section>';
  }
  html += `<p class="source-note">${esc(material.voice || '导入音频')} · ${material.voice?.includes('Nemo') ? '音声：VOICEVOX Nemo。' : ''}假名为自动标注，专有名词请结合实际发音确认。</p></div>`;
  $('reader').innerHTML = html;
  rowMap = new Map([...document.querySelectorAll('.cue-row')].map(row => [row.dataset.cue,row]));
  tokenNodes = new Map([...rowMap].map(([id,row]) => [id,[...row.querySelectorAll('.word')]]));
}
function highlightNav() {const cue = cueMap.get(state.active); document.querySelectorAll('[data-question]').forEach(el => {const active = el.dataset.question === cue?.questionId;el.classList.toggle('active',active);if(active)el.setAttribute('aria-current','true');else el.removeAttribute('aria-current');});}
function setFollow(value) {state.follow=value;updateFollow();if(value)scrollToActive();}
function updateFollow() { $('followToggle').setAttribute('aria-pressed',String(state.follow)); $('followToggle').classList.toggle('selected',state.follow); $('followToggle').title = state.follow?'正在自动跟随播放':'点击回到正在播放的句子'; }
function scrollToActive(force = false) {
  const row = rowMap.get(state.active); if(!row)return;
  const rect=row.getBoundingClientRect(),parent=$('reader').getBoundingClientRect();
  if(force || rect.top < parent.top+24 || rect.bottom > parent.bottom-70) {scrollProgrammaticUntil=Date.now()+800;row.scrollIntoView({block:'center',behavior:force||matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});}
}
function updateProgress(force=false) {
  if(!state.material)return;
  const time=clamp(globalTime(),0,state.material.duration); $('currentTime').textContent=formatTime(time);
  if(document.activeElement!==$('seek'))$('seek').value=time;
  const cue=cueAt(state.cues,time);
  if(!cue && state.active){rowMap.get(state.active)?.classList.remove('active');tokenNodes.get(state.active)?.forEach(n=>n.classList.remove('spoken','token-current'));state.active=null;highlightNav();$('playingTitle').textContent=state.material.title;}
  if(cue && (cue.id!==state.active || force)) {
    rowMap.get(state.active)?.classList.remove('active'); if(state.active) tokenNodes.get(state.active)?.forEach(n=>n.classList.remove('spoken','token-current'));
    state.active=cue.id;rowMap.get(cue.id)?.classList.add('active');
    const q=state.material.questions.find(q=>q.id===cue.questionId);$('playingTitle').textContent=q?`${String(q.number).padStart(2,'0')} · ${q.title}`:state.material.title;
    highlightNav();document.querySelectorAll('.queue-item').forEach(n=>n.classList.toggle('active',n.dataset.queueCue===cue.id));
    if(state.follow)scrollToActive(force);
  }
  if(cue && cue.tokens?.length) {
    const nodes=tokenNodes.get(cue.id)||[];
    cue.tokens.forEach((token,i)=>{if(!nodes[i])return;const start=Number(token.start),end=Number(token.end);const valid=Number.isFinite(start)&&Number.isFinite(end);nodes[i].classList.toggle('spoken',valid&&time>=end);nodes[i].classList.toggle('token-current',valid&&time>=start&&time<end);});
  }
  if(Date.now()-state.lastSave>1500){saveState();state.lastSave=Date.now();}
}
function configurePlayback(position, play) {
  if(!state.material)return;
  const win=playbackWindow(state.material,state.mode,state.anchor,state.range,state.queue,state.queueIndex);
  const target=clamp(position ?? win.start,win.start,Math.max(win.start,win.end-.02))-(publicSite?0:win.start);
  state.pendingPosition=(publicSite?0:win.start)+target;
  state.window=win;$('repeatMode').value=state.mode;$('stopPractice').hidden=state.mode==='off';
  const key=publicSite?`${state.material.id}:full`:`${state.material.id}:${win.start.toFixed(5)}:${win.end.toFixed(5)}:${win.clip}`;
  audio.loop=win.loop&&!(publicSite&&win.clip);
  const version=++state.sourceVersion;
  const setPosition=()=>{if(version!==state.sourceVersion)return;audio.currentTime=clamp(target,0,Math.max(0,(Number.isFinite(audio.duration)?audio.duration:win.end-win.start)-.02));state.pendingPosition=null;audio.playbackRate=Number(settings.speed);updateProgress(true);saveState();};
  if(key!==state.sourceKey){
    state.sourceKey=key;audio.pause();
    audio.src=win.clip&&!publicSite?`/media/${encodeURIComponent(state.material.id)}/clip.mp3?start=${win.start.toFixed(5)}&end=${win.end.toFixed(5)}`:state.material.audioUrl;
    audio.addEventListener('loadedmetadata',setPosition,{once:true});audio.load();
  } else if(audio.readyState>=1){setPosition();} else {audio.addEventListener('loadedmetadata',setPosition,{once:true});}
  if(play)tryPlay();else pausePlayback();updateProgress(true);saveState();
}
function isPlaying(){return playbackRequested||!audio.paused;}
function updatePlayButton(){const playing=isPlaying();$('playButton').innerHTML=icon(playing?'pause':'play');$('playButton').setAttribute('aria-label',playing?'暂停':'播放');}
function pausePlayback(){playbackRequested=false;playRequestVersion++;audio.pause();updatePlayButton();}
async function tryPlay() {const request=++playRequestVersion;playbackRequested=true;updatePlayButton();try{await audio.play();}catch(error){if(request!==playRequestVersion)return;playbackRequested=false;updatePlayButton();if(error.name!=='AbortError'){toast(error.name==='NotAllowedError'?'点击播放按钮继续。':'暂时无法播放，请稍后重试。');}}}
function setMode(mode,play=false) {
  if(mode==='queue'&&!state.queue.length){showPractice('queue');toast('点击文稿旁的星标，把要复读的句子加入清单。');$('repeatMode').value=state.mode;return;}
  if(mode==='range'&&(!state.range.a||!state.range.b)){showPractice('range');beginRangeSelection(state.range.a?'b':'a');$('repeatMode').value=state.mode;return;}
  const position=globalTime();state.anchor=state.active || state.cues[0]?.id;state.mode=mode;
  if(mode==='queue'){state.queueIndex=0;state.anchor=state.queue[0];}
  const win=playbackWindow(state.material,state.mode,state.anchor,state.range,state.queue,state.queueIndex);
  configurePlayback(mode==='queue'||mode==='range'?win.start:clamp(position,win.start,win.end-.02),play||isPlaying());
}
function openCue(id,play=true){const cue=cueMap.get(id);if(!cue)return;state.anchor=id;if(['range','queue'].includes(state.mode))state.mode='off';configurePlayback(cue.start,play);if(state.follow)scrollToActive(true);closeDrawers();}
function navigateCue(direction){
  if(state.mode==='queue'&&state.queue.length){state.queueIndex=nextQueueIndex(state.queueIndex,state.queue.length,direction);state.anchor=state.queue[state.queueIndex];configurePlayback(cueMap.get(state.anchor).start,isPlaying());return;}
  const index=state.cues.findIndex(c=>c.id===state.active);const cue=state.cues[clamp(index+direction,0,state.cues.length-1)];if(cue)openCue(cue.id,isPlaying());
}
function seekGlobal(time) {
  if(!state.material)return;const play=isPlaying();const cue=cueAt(state.cues,time);
  if(['sentence','question'].includes(state.mode))state.anchor=cue?.id;
  if(['queue','range'].includes(state.mode)&&(time<state.window.start||time>=state.window.end))state.mode='off';
  configurePlayback(time,play);
}
function renderQueue() {
  $('queueCount').textContent=state.queue.length;$('queueCountSmall').textContent=state.queue.length;
  $('queueSummary').textContent=state.queue.length?`${state.queue.length} 句 · ${formatTime(state.queue.reduce((sum,id)=>sum+cueMap.get(id).end-cueMap.get(id).start,0))} / 每轮`:'尚未选择句子';
  $('playQueue').disabled=!state.queue.length;$('clearQueue').disabled=!state.queue.length;$('saveQueue').disabled=!state.queue.length;
  $('queueList').innerHTML=state.queue.length?state.queue.map((id,index)=>{const c=cueMap.get(id);const q=state.material.questions.find(q=>q.id===c.questionId);return `<div class="queue-item${state.active===id?' active':''}" data-queue-cue="${esc(id)}"><div class="queue-item-top"><span>${String(index+1).padStart(2,'0')} · ${esc(q?.title||'重点')}</span><div class="queue-item-buttons"><button class="icon-button" data-queue-up="${index}" aria-label="重点 ${index+1} 上移" ${index===0?'disabled':''}>${icon('up')}</button><button class="icon-button" data-queue-down="${index}" aria-label="重点 ${index+1} 下移" ${index===state.queue.length-1?'disabled':''}>${icon('down')}</button><button class="icon-button" data-queue-remove="${esc(id)}" aria-label="移除重点 ${index+1}">${icon('x')}</button></div></div><button class="queue-item-text" data-queue-play="${index}" lang="ja">${esc(c.text)}</button></div>`;}).join(''):`<div class="empty-state">${icon('star')}<p>还没有选择重点</p><p>点句子旁的 ☆，<br>把想多听几次的话收在这里。</p></div>`;
  const selected=$('queueSelect').value;$('queueSelect').innerHTML='<option value="">当前选择</option>'+state.saved.map((s,i)=>`<option value="${i}">${esc(s.name)} · ${s.ids.length} 句</option>`).join('');$('queueSelect').value=selected;
  document.querySelectorAll('[data-pick]').forEach(button=>{const picked=state.queue.includes(button.dataset.pick);button.classList.toggle('picked',picked);button.setAttribute('aria-pressed',String(picked));const cue=cueMap.get(button.dataset.pick);button.setAttribute('aria-label',`${picked?'移出':'加入'}重点：${cue?.text.slice(0,25)||''}`);});
  saveState();
}
function changeQueue(next) {
  const oldId=state.queue[state.queueIndex];state.queue=[...new Set(next)].filter(id=>cueMap.has(id));$('queueSelect').value='';
  if(state.mode==='queue'){
    const play=isPlaying();if(!state.queue.length){state.mode='off';configurePlayback(globalTime(),false);}else{state.queueIndex=Math.max(0,state.queue.indexOf(oldId));state.anchor=state.queue[state.queueIndex];configurePlayback(cueMap.get(state.anchor).start,play);}
  }renderQueue();
}
function togglePick(id){if(!cueMap.has(id))return;changeQueue(state.queue.includes(id)?state.queue.filter(x=>x!==id):[...state.queue,id]);}
function switchPractice(type){
  state.practiceTab=type;
  ['queue','range'].forEach(name=>{$(`${name}Tab`).setAttribute('aria-selected',String(name===type));$(`${name}Panel`).hidden=name!==type;});
  if(type!=='range'){state.rangePicking=null;renderRange();}
}
function showPractice(type){switchPractice(type);if(matchMedia('(max-width:1199px)').matches&&!$('practice').classList.contains('open'))toggleDrawer('practice');}
function renderRange(){
  const a=cueMap.get(state.range.a),b=cueMap.get(state.range.b);$('playRange').disabled=!(a&&b)||!!state.rangePicking;$('rangeB').disabled=!a;
  $('rangeDescription').textContent=a&&b?`${formatTime(Math.min(a.start,b.start))} — ${formatTime(Math.max(a.end,b.end))} · ${state.cues.filter(c=>c.start>=Math.min(a.start,b.start)&&c.end<=Math.max(a.end,b.end)+.01).length} 句 · ${formatTime(Math.max(a.end,b.end)-Math.min(a.start,b.start))}`:a?'起句已选好，接下来在文稿中选择结束句。':'选好两句后，这里会显示区间时长。';
  for(const [point,cue]of [['a',a],['b',b]]){
    const key=point.toUpperCase(),button=$(`range${key}`),text=$(`range${key}Text`);
    button.classList.toggle('filled',!!cue);button.classList.toggle('choosing',state.rangePicking===point);
    button.querySelector('strong').textContent=cue?`${point==='a'?'起句':'结束句'} · ${formatTime(point==='a'?cue.start:cue.end)}`:point==='a'?'选择起句':'选择结束句';
    text.textContent=cue?cue.text:point==='a'?'点击后，在文稿中选择一句':'包含结束句的完整音频';
    if(cue)text.lang='ja';else text.removeAttribute('lang');
  }
  $('clearRange').disabled=!(a||b||state.rangePicking);
  $('selectionBanner').hidden=!state.rangePicking;
  $('selectionInstruction').textContent=state.rangePicking==='a'?'第 1 步：点击文稿中的起句':'第 2 步：点击结束句（包含这一整句）';
  $('reader').classList.toggle('selecting-range',!!state.rangePicking);
  rowMap.forEach((row,id)=>{const c=cueMap.get(id);row.querySelector('[data-start-cue]').setAttribute('aria-label',state.rangePicking?`选为${state.rangePicking==='a'?'起句':'结束句'}：${c.text}`:`从 ${formatTime(c.start)} 播放：${c.text}`);row.classList.toggle('in-range',!!(a&&b&&c.start>=Math.min(a.start,b.start)&&c.end<=Math.max(a.end,b.end)+.01));row.classList.toggle('range-start',id===a?.id);row.classList.toggle('range-end',id===b?.id);});saveState();
}
function beginRangeSelection(point){
  pausePlayback();state.rangePicking=point;switchPractice('range');setFollow(false);renderRange();closeDrawers();
}
function selectRangePoint(point,id){
  if(!cueMap.has(id))return;
  state.range[point]=id;
  if(point==='a'&&!state.range.b){state.rangePicking='b';}
  else{state.rangePicking=null;if(state.range.a&&state.range.b&&cueMap.get(state.range.a).start>cueMap.get(state.range.b).start)[state.range.a,state.range.b]=[state.range.b,state.range.a];showPractice('range');}
  renderRange();
  if(!state.rangePicking&&state.mode==='range')setMode('range',false);
}
function closeDrawers(){$('sidebar').classList.remove('open');$('practice').classList.remove('open');$('drawerShade').hidden=true;}
function toggleDrawer(id){const open=$(id).classList.contains('open');closeDrawers();if(!open){$(id).classList.add('open');$('drawerShade').hidden=false;}}

function enforcePublicBoundary(){
  if(!publicSite||!state.material||!state.window.clip||!isPlaying()||state.pendingPosition!==null||audio.currentTime<state.window.end-.025)return;
  if(state.mode==='queue'){state.queueIndex=nextQueueIndex(state.queueIndex,state.queue.length);state.anchor=state.queue[state.queueIndex];configurePlayback(cueMap.get(state.anchor).start,true);}
  else if(state.window.loop){audio.currentTime=state.window.start;if(audio.paused)tryPlay();updateProgress(true);}
}
function updateTextCount(){$('textCount').textContent=`${$('importText').value.length.toLocaleString()} 字`;}
function openImport(){
  if(state.completedMaterial&&!state.job){state.importStep=1;state.completedMaterial=null;state.sections=[];$('importTitle').value='';$('importText').value='';$('textFile').value='';$('pasteStep').hidden=false;$('sectionStep').hidden=true;}
  if(state.job)state.importStep=3;
  updateImportButton();updateTextCount();$('importDialog').showModal();$('importError').hidden=true;
}
function switchImport(type){state.importType=type;$('textImport').hidden=type!=='text';$('audioImport').hidden=type!=='audio';['text','audio'].forEach(t=>{$(`${t}Tab`).classList.toggle('active',type===t);$(`${t}Tab`).setAttribute('aria-selected',String(type===t));});updateImportButton();}
function updateImportButton(){
  const generating=state.importStep===3,done=!!state.completedMaterial,cloudText=publicSite&&state.importType==='text';
  $('importSteps').hidden=state.importType!=='text'||publicSite;
  $('cloudTextNotice').hidden=!cloudText;$('textImport').hidden=state.importType!=='text'||cloudText;$('importTitle').hidden=cloudText;$('importTitleLabel').hidden=cloudText;$('importNext').hidden=cloudText;
  document.querySelectorAll('[data-step]').forEach(el=>{const step=Number(el.dataset.step);if(step===state.importStep)el.setAttribute('aria-current','step');else el.removeAttribute('aria-current');el.classList.toggle('complete',step<state.importStep||done);});
  $('importForm').hidden=generating;$('generationResult').hidden=!generating;
  $('textTab').disabled=generating||state.importBusy;$('audioTab').disabled=generating||state.importBusy;
  $('importDismiss').textContent=generating?(done?'关闭':'后台处理'):'取消';
  $('importNext').disabled=state.importBusy||(generating&&!done);
  $('importNext').innerHTML=generating?(done?`开始听读${icon('play')}`:'正在生成…'):state.importType==='audio'?'保存音频并导入':state.importStep===1?`下一步：确认分题${icon('arrow-right')}`:`生成日语音频${icon('arrow-right')}`;
  $('importHeading').textContent=state.importType==='audio'?'导入已有音频':'把文稿变成听读资料';
}
function syncSections(){document.querySelectorAll('.section-edit').forEach(el=>{const index=Number(el.dataset.section),section=state.sections[index];if(!section)return;section.title=el.querySelector('[data-field="title"]').value;section.question=el.querySelector('[data-field="question"]').value;section.answer=el.querySelector('[data-field="answer"]').value;el.querySelectorAll('[data-followup]').forEach(f=>{const i=Number(f.dataset.followup);section.followups[i]={question:f.querySelector('[data-field="fq"]').value,answer:f.querySelector('[data-field="fa"]').value};});});}
function renderSections(){
  $('sectionsCount').textContent=`${state.sections.length} 个主问题 · ${state.sections.reduce((n,s)=>n+(s.followups?.length||0),0)} 个追问`;
  $('sectionEditor').innerHTML=state.sections.map((s,i)=>`<details class="section-edit" data-section="${i}" ${i===0?'open':''}><summary><span class="count">${String(i+1).padStart(2,'0')}</span><span class="section-preview">${esc(s.title||s.question||'新小节')}</span></summary><div class="section-edit-body"><div class="section-edit-header"><label class="field-label section-title-field">目录标题<input aria-label="第 ${i+1} 题标题" data-field="title" value="${esc(s.title||'')}" placeholder="小节标题"></label><button class="icon-button" data-remove-section="${i}" aria-label="删除第 ${i+1} 节">${icon('x')}</button></div><label class="field-label">主问题<textarea rows="2" data-field="question" aria-label="第 ${i+1} 题主问题">${esc(s.question||'')}</textarea></label><label class="field-label">回答<textarea rows="4" data-field="answer" aria-label="第 ${i+1} 题回答">${esc(s.answer||'')}</textarea></label>${(s.followups||[]).map((f,j)=>`<div class="followup-edit" data-followup="${j}"><label class="field-label">追问 ${j+1}<textarea rows="2" data-field="fq" aria-label="第 ${i+1} 题追问 ${j+1}">${esc(f.question)}</textarea></label><label class="field-label">追问回答<textarea rows="3" data-field="fa" aria-label="第 ${i+1} 题追问回答 ${j+1}">${esc(f.answer)}</textarea></label><button class="text-button" data-remove-followup="${i}:${j}">删除这条追问</button></div>`).join('')}<div class="section-edit-actions"><button class="text-button" data-add-followup="${i}">${icon('plus')}增加追问</button><button class="text-button" data-split-section="${i}" title="在回答文字的光标位置，将后文拆成新小节">从回答光标处拆分</button>${i>0?`<button class="text-button" data-merge-section="${i}">合并到上一节</button>`:''}</div></div></details>`).join('');
}
async function submitImport(){
  if(state.importBusy)return;
  $('importError').hidden=true;const button=$('importNext');
  if(state.completedMaterial){$('importDialog').close();tryPlay();return;}
  state.importBusy=true;updateImportButton();button.disabled=true;button.textContent=state.importStep===1&&state.importType==='text'?'正在识别分题…':'正在提交…';
  try{
    if(state.importType==='text'&&state.importStep===1){
      if(!$('importText').value.trim())throw new Error('先粘贴或导入一段日语文稿。');
      const parsed=await post('/api/parse',{text:$('importText').value,title:$('importTitle').value});state.sections=parsed.sections.map(s=>({...s,followups:s.followups||[]}));
      if(!state.sections.length)throw new Error('没有识别到可朗读的内容。');
      state.importStep=2;$('pasteStep').hidden=true;$('sectionStep').hidden=false;$('parseWarnings').textContent=(parsed.warnings||[]).join(' ');renderSections();updateImportButton();
    } else {
      if(state.job)throw new Error('已有任务正在处理，完成后可以继续导入。');
      let result;
      if(state.importType==='text') {if(state.ttsReady===false)throw new Error('本机语音引擎尚未就绪，请通过启动文件重新打开工作台。');syncSections();if(!state.sections.length)throw new Error('请至少保留一个小节。');result=await post('/api/generate',{title:$('importTitle').value.trim()||'我的日语文稿',sections:state.sections,voice:10005});}
      else {const file=$('audioFile').files[0];if(!file)throw new Error('请选择音频文件。');if(file.size>500*1024*1024)throw new Error('音频超过 500 MB，请先分成较小的文件。');const form=new FormData();form.append('file',file);form.append('title',$('importTitle').value.trim()||file.name.replace(/\.[^.]+$/,''));if($('subtitleText').value.trim())form.append('transcript',$('subtitleText').value);form.append('transcribe',String($('transcribeAudio').checked));result=await api('/api/import-audio',{method:'POST',body:form});}
      state.importStep=3;state.completedMaterial=null;$('generationSymbol').innerHTML='<span class="spinner"></span>';$('generationTitle').textContent=state.importType==='text'?'正在生成日语音频':'正在准备听读资料';$('generationMessage').textContent='正在准备文稿…';$('generationProgress').value=0;$('generationHelp').textContent=publicSite?'音频保存在当前浏览器，其他访客看不到你的导入文件。':'在这台电脑上生成和保存。关闭此窗口后，任务仍会继续。';updateImportButton();startJob(result.jobId);
    }
  }catch(error){$('importError').textContent=error.message;$('importError').hidden=false;}finally{state.importBusy=false;updateImportButton();}
}
function startJob(jobId){clearTimeout(pollTimer);state.job=jobId;state.jobFailures=0;localStorage.setItem('kotoba:v1:job',JSON.stringify(jobId));$('jobBanner').hidden=false;pollJob();}
async function pollJob(){
  if(!state.job)return;
  let fetchedJob=false;
  try{
    const job=await api(`/api/jobs/${encodeURIComponent(state.job)}`);fetchedJob=true;state.jobFailures=0;$('jobTitle').textContent=job.status==='queued'?'等待处理':'正在准备新资料';$('jobMessage').textContent=`${Math.round((Number(job.progress)||0)*100)}% · ${job.message||'处理中'}`;$('jobProgress').value=Number(job.progress)||0;
    $('generationMessage').textContent=$('jobMessage').textContent;$('generationProgress').value=Number(job.progress)||0;
    if(job.status==='complete'){await refreshLibrary(job.materialId);if(state.material?.id!==job.materialId)throw new Error('新资料暂时未能载入，正在重试。');state.job=null;state.completedMaterial=job.materialId;state.importStep=3;localStorage.removeItem('kotoba:v1:job');$('jobBanner').hidden=true;$('generationSymbol').innerHTML=icon('check');$('generationTitle').textContent=state.importType==='audio'?'音频已保存到资料库':'音频已生成，已保存到资料库';$('generationHelp').textContent='点击「开始听读」播放，也可以关闭窗口后从资料库打开。';$('generationMessage').textContent=`${formatTime(state.material.duration)} · ${state.material.questions.length} 题 · ${state.cues.length} 句 · ${state.material.voice||'导入音频'}`;$('generationProgress').value=1;updateImportButton();toast('新资料已保存，可以开始听读。');return;}
    if(['error','cancelled'].includes(job.status)){state.job=null;localStorage.removeItem('kotoba:v1:job');$('jobBanner').hidden=true;const message=job.error||job.message||(job.status==='cancelled'?'任务已取消。':'生成失败，请重试。');notice(message);state.importStep=state.sections.length?2:1;updateImportButton();$('importError').textContent=message;$('importError').hidden=false;return;}
  }catch(error){if(error.status===404&&!fetchedJob){notice('任务记录已失效。已完成的资料仍在资料库中，可从左侧选择。');state.job=null;localStorage.removeItem('kotoba:v1:job');$('jobBanner').hidden=true;state.importStep=state.sections.length?2:1;updateImportButton();return;}state.jobFailures++;$('jobTitle').textContent='正在重新连接';$('jobMessage').textContent='任务编号已保留，恢复连接后继续查看进度。';}
  pollTimer=setTimeout(pollJob,Math.min(15000,1500 * (state.jobFailures + 1)));
}
async function readTextFile(){const file=$('textFile').files[0];if(!file)return;try{const form=new FormData();form.append('file',file);const result=await api('/api/read-text',{method:'POST',body:form});$('importText').value=result.text;updateTextCount();if(!$('importTitle').value)$('importTitle').value=file.name.replace(/\.[^.]+$/,'');toast('文稿已导入，接下来检查题目分节。');}catch(error){$('importError').textContent=error.message;$('importError').hidden=false;}}

function openTranscript(){if(!state.material)return;pausePlayback();state.editCues=structuredClone(state.material.cues);state.editQuestions=state.material.questions.map(q=>({id:q.id,title:q.title}));renderCueEditor();$('editError').hidden=true;$('editDialog').showModal();}
function syncCueEditor(){
  document.querySelectorAll('[data-edit-cue]').forEach((el,i)=>{const c=state.editCues[i];c.text=el.querySelector('[data-edit-text]').value;c.start=Number(el.querySelector('[data-edit-start]').value);c.end=Number(el.querySelector('[data-edit-end]').value);c.kind=el.querySelector('[data-edit-kind]').value;});
  document.querySelectorAll('[data-edit-question-title]').forEach(el=>{const q=state.editQuestions.find(q=>q.id===el.dataset.editQuestionTitle);if(q)q.title=el.value;});
}
function renderCueEditor(){
  let previousQuestion=null,number=0;
  $('cueEditor').innerHTML=state.editCues.map((c,i)=>{let header='';if(c.questionId!==previousQuestion){number++;const q=state.editQuestions.find(q=>q.id===c.questionId);header=`<div class="edit-section-heading"><span class="count">${number}</span><input data-edit-question-title="${esc(c.questionId)}" value="${esc(q?.title||'新小节')}" aria-label="小节 ${number} 标题">${i>0?`<button class="text-button" data-merge-cues="${i}">并入上一题</button>`:''}</div>`;previousQuestion=c.questionId;}
    const kinds=['question','answer','followup_question','followup_answer','student_backup_label','student_backup_question','narration'];
    return `${header}<div class="cue-edit-row" data-edit-cue="${esc(c.id)}"><div class="cue-edit-head"><label class="field-label" for="edit-text-${i}">第 ${i+1} 句</label><select data-edit-kind aria-label="第 ${i+1} 句类型">${kinds.map(k=>`<option value="${k}" ${k===c.kind?'selected':''}>${k==='narration'?'语音导航':labelFor(k)}</option>`).join('')}</select>${i>0?`<button class="text-button" data-split-cues="${i}">从这里分题</button>`:''}</div><textarea id="edit-text-${i}" data-edit-text rows="2" lang="ja">${esc(c.text)}</textarea><div class="cue-edit-times"><label>起点 <input aria-label="第 ${i+1} 句起点" data-edit-start type="number" min="0" step="0.01" value="${Number(c.start).toFixed(3)}"></label><span>→</span><label>终点 <input aria-label="第 ${i+1} 句终点" data-edit-end type="number" min="0" step="0.01" value="${Number(c.end).toFixed(3)}"></label><span>秒</span></div></div>`;}).join('');
}
async function saveTranscript(){const button=$('saveTranscript');button.disabled=true;try{syncCueEditor();const error=validateCueEdits(state.editCues,state.material.duration);if(error)throw new Error(error);await post(`/api/materials/${encodeURIComponent(state.material.id)}/cues`,{cues:state.editCues,questions:state.editQuestions});$('editDialog').close();await loadMaterial(state.material.id);toast('文稿、分节与时间已保存。');}catch(error){$('editError').textContent=error.message;$('editError').hidden=false;}finally{button.disabled=false;}}

function setupMediaSession(){if(!('mediaSession'in navigator))return;navigator.mediaSession.metadata=new MediaMetadata({title:state.material.title,artist:state.material.voice||'ことば',album:'日语听读'});const handlers={play:tryPlay,pause:pausePlayback,previoustrack:()=>navigateCue(-1),nexttrack:()=>navigateCue(1),seekbackward:()=>seekGlobal(globalTime()-5),seekforward:()=>seekGlobal(globalTime()+5),seekto:event=>seekGlobal(event.seekTime)};for(const [type,handler]of Object.entries(handlers))try{navigator.mediaSession.setActionHandler(type,handler);}catch{}}

// Playback clock: source clips supply precise native loops; animation only updates visible text.
audio.addEventListener('play',()=>{if(audio.paused)return;playbackRequested=true;updatePlayButton();if('mediaSession'in navigator)navigator.mediaSession.playbackState='playing';});
audio.addEventListener('pause',()=>{updatePlayButton();saveState();if('mediaSession'in navigator)navigator.mediaSession.playbackState='paused';});
audio.addEventListener('timeupdate',()=>{enforcePublicBoundary();updateProgress();});
audio.addEventListener('ended',()=>{if(publicSite&&state.window.clip&&state.window.loop){audio.currentTime=state.window.start;tryPlay();return;}if(state.mode==='queue'&&state.queue.length){state.queueIndex=nextQueueIndex(state.queueIndex,state.queue.length);state.anchor=state.queue[state.queueIndex];configurePlayback(cueMap.get(state.anchor).start,true);}else{pausePlayback();updateProgress(true);}});
audio.addEventListener('error',()=>{if(state.material)notice('音频暂时无法读取。请检查本机服务是否仍在运行，再点击播放。');});
const tick=()=>{if(!audio.paused&&!document.hidden){enforcePublicBoundary();updateProgress();}requestAnimationFrame(tick);};requestAnimationFrame(tick);
$('playButton').onclick=()=>{if(!isPlaying()){if(audio.ended)configurePlayback(state.window.start,true);else tryPlay();}else pausePlayback();};
$('previousCue').onclick=()=>navigateCue(-1);$('nextCue').onclick=()=>navigateCue(1);
$('seek').oninput=()=>{$('currentTime').textContent=formatTime($('seek').value);};$('seek').onchange=()=>seekGlobal(Number($('seek').value));
$('speed').onchange=()=>{settings.speed=Number($('speed').value);audio.playbackRate=settings.speed;saveState();};
$('volume').oninput=()=>{settings.volume=Number($('volume').value);audio.volume=settings.volume;audio.muted=false;saveState();};
$('muteButton').onclick=()=>{audio.muted=!audio.muted;$('muteButton').innerHTML=icon(audio.muted?'mute':'volume');$('muteButton').setAttribute('aria-label',audio.muted?'取消静音':'静音');};
$('repeatMode').onchange=()=>setMode($('repeatMode').value);
$('rubyToggle').onclick=()=>{settings.ruby=!settings.ruby;applySettings();saveState();};$('fontSize').onchange=()=>{settings.fontSize=Number($('fontSize').value);applySettings();saveState();};
$('followToggle').setAttribute('aria-label','跟随播放');$('followToggle').onclick=()=>setFollow(!state.follow);
['wheel','touchmove'].forEach(type=>$('reader').addEventListener(type,()=>{if(Date.now()>scrollProgrammaticUntil)setFollow(false);},{passive:true}));
$('reader').addEventListener('pointerdown',event=>{if(event.target===$('reader'))setFollow(false);});
$('questionSearch').oninput=renderNav;$('materialSelect').onchange=()=>loadMaterial($('materialSelect').value).catch(()=>{});
$('questionNav').onclick=event=>{const button=event.target.closest('[data-question]');if(!button)return;const cue=state.cues.find(c=>c.questionId===button.dataset.question);if(cue){openCue(cue.id,isPlaying());scrollToActive(true);}else{const q=state.material.questions.find(q=>q.id===button.dataset.question);if(q)configurePlayback(q.start,isPlaying());}};
$('reader').onclick=event=>{
  const pick=event.target.closest('[data-pick]');if(pick){togglePick(pick.dataset.pick);return;}
  const question=event.target.closest('[data-play-question]');if(question){const c=state.cues.find(c=>c.questionId===question.dataset.playQuestion);if(c)openCue(c.id);else{const q=state.material.questions.find(q=>q.id===question.dataset.playQuestion);if(q)configurePlayback(q.start,true);}return;}
  const pickQuestion=event.target.closest('[data-pick-question]');if(pickQuestion){changeQueue([...state.queue,...state.cues.filter(c=>c.questionId===pickQuestion.dataset.pickQuestion).map(c=>c.id)]);toast('整题已加入重点清单。');return;}
  const start=event.target.closest('[data-start-cue]');if(!start)return;const id=start.dataset.startCue;
  if(state.rangePicking){selectRangePoint(state.rangePicking,id);return;}
  if(event.shiftKey){pausePlayback();if(!state.shiftAnchor){state.shiftAnchor=id;state.range={a:id,b:null};renderRange();toast('已设起点；按住 Shift 再点击终点。');}else{state.range.a=state.shiftAnchor;state.shiftAnchor=null;selectRangePoint('b',id);showPractice('range');toast('连续区间已选好，可以开始循环。');}}else openCue(id);
};
$('queueList').onclick=event=>{const remove=event.target.closest('[data-queue-remove]');if(remove){togglePick(remove.dataset.queueRemove);return;}const move=event.target.closest('[data-queue-up],[data-queue-down]');if(move){const index=Number(move.dataset.queueUp??move.dataset.queueDown),target=index+(move.hasAttribute('data-queue-up')?-1:1);const ids=[...state.queue];[ids[index],ids[target]]=[ids[target],ids[index]];changeQueue(ids);return;}const play=event.target.closest('[data-queue-play]');if(play){state.mode='queue';state.queueIndex=Number(play.dataset.queuePlay);state.anchor=state.queue[state.queueIndex];configurePlayback(cueMap.get(state.anchor).start,true);}};
$('playQueue').onclick=()=>setMode('queue',true);$('clearQueue').onclick=()=>{changeQueue([]);toast('已清空当前选择；已保存清单仍保留。');};
$('saveQueue').onclick=()=>{$('queueName').value='';$('saveDialog').showModal();};
$('saveQueueForm').onsubmit=event=>{event.preventDefault();const name=$('queueName').value.trim();if(!name)return;const existing=state.saved.find(s=>s.name===name);if(existing)existing.ids=[...state.queue];else state.saved.push({name,ids:[...state.queue]});$('saveDialog').close();renderQueue();$('queueSelect').value=String(state.saved.findIndex(s=>s.name===name));toast('复读清单已保存。');};
$('queueSelect').onchange=()=>{if($('queueSelect').value==='')return;const index=Number($('queueSelect').value);changeQueue(state.saved[index].ids);$('queueSelect').value=String(index);};
$('queueTab').onclick=()=>switchPractice('queue');$('rangeTab').onclick=()=>switchPractice('range');
$('rangeA').onclick=()=>beginRangeSelection('a');$('rangeB').onclick=()=>beginRangeSelection('b');$('playRange').onclick=()=>{setMode('range',true);closeDrawers();};
$('cancelSelection').onclick=()=>{state.rangePicking=null;renderRange();};$('stopPractice').onclick=()=>setMode('off');
$('clearRange').onclick=()=>{state.range={a:null,b:null};state.shiftAnchor=null;state.rangePicking=null;if(state.mode==='range')setMode('off');renderRange();};
$('navToggle').onclick=()=>toggleDrawer('sidebar');$('queueToggle').onclick=()=>toggleDrawer('practice');$('closeQueue').onclick=closeDrawers;$('drawerShade').onclick=closeDrawers;
['importSide','importTop'].forEach(id=>$(id).onclick=openImport);$('helpButton').onclick=()=>$('helpDialog').showModal();$('editTranscript').onclick=openTranscript;$('saveTranscript').onclick=saveTranscript;
document.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>$(button.dataset.close).close());
document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.close();}}));
$('textTab').onclick=()=>switchImport('text');$('audioTab').onclick=()=>switchImport('audio');$('importNext').onclick=submitImport;$('textFile').onchange=readTextFile;$('importText').oninput=updateTextCount;
$('audioFile').onchange=()=>{const file=$('audioFile').files[0];$('audioFileLabel').textContent=file?.name||'选择音频文件';};
$('subtitleFile').onchange=async()=>{const file=$('subtitleFile').files[0];if(file)$('subtitleText').value=await file.text();};
$('backToText').onclick=()=>{state.importStep=1;$('pasteStep').hidden=false;$('sectionStep').hidden=true;updateImportButton();};
$('addSection').onclick=()=>{syncSections();state.sections.push({title:'新小节',question:'',answer:'',followups:[]});renderSections();};
$('sectionEditor').onclick=event=>{
  const btn=event.target.closest('button');if(!btn)return;syncSections();
  if(btn.dataset.removeSection!==undefined){state.sections.splice(Number(btn.dataset.removeSection),1);renderSections();}
  else if(btn.dataset.addFollowup!==undefined){state.sections[Number(btn.dataset.addFollowup)].followups.push({question:'',answer:''});renderSections();}
  else if(btn.dataset.removeFollowup){const[i,j]=btn.dataset.removeFollowup.split(':').map(Number);state.sections[i].followups.splice(j,1);renderSections();}
  else if(btn.dataset.mergeSection!==undefined){const i=Number(btn.dataset.mergeSection),s=state.sections[i],p=state.sections[i-1];p.answer=[p.answer,s.question,s.answer].filter(Boolean).join('\n\n');p.followups.push(...s.followups);state.sections.splice(i,1);renderSections();}
  else if(btn.dataset.splitSection!==undefined){const i=Number(btn.dataset.splitSection),field=btn.closest('.section-edit').querySelector('[data-field="answer"]'),point=field.selectionStart;if(point<=0||point>=field.value.length){toast('先在回答文字中放置光标，再点击拆分。');field.focus();return;}const text=field.value;state.sections[i].answer=text.slice(0,point).trim();state.sections.splice(i+1,0,{title:'拆分的小节',question:'',answer:text.slice(point).trim(),followups:state.sections[i].followups});state.sections[i].followups=[];renderSections();}
};
$('cueEditor').onclick=event=>{const split=event.target.closest('[data-split-cues]'),merge=event.target.closest('[data-merge-cues]');if(!split&&!merge)return;syncCueEditor();const index=Number(split?.dataset.splitCues??merge?.dataset.mergeCues),old=state.editCues[index].questionId;let next;
  if(split){next=`section-${Date.now().toString(36)}`;state.editQuestions.push({id:next,title:'新小节'});}else{next=state.editCues[index-1].questionId;}
  for(let i=index;i<state.editCues.length&&state.editCues[i].questionId===old;i++)state.editCues[i].questionId=next;
  renderCueEditor();toast(split?'已从这句开始分出新题，可修改标题。':'已并入上一题。');
};
$('cancelJob').onclick=async()=>{if(!state.job)return;try{await post(`/api/jobs/${encodeURIComponent(state.job)}/cancel`,{});toast('已请求取消。');}catch(error){notice(error.message);}};
document.addEventListener('keydown',event=>{if(event.key==='Escape'){closeDrawers();state.rangePicking=null;renderRange();}if(event.target.closest('input,textarea,select,[contenteditable=true],dialog')||!state.material||event.metaKey||event.ctrlKey||event.altKey)return;if(event.code==='Space'){if(event.target.closest('button,a'))return;event.preventDefault();$('playButton').click();}else if(event.key==='j'||event.key==='J'){navigateCue(-1);}else if(event.key==='k'||event.key==='K'){navigateCue(1);}else if(event.key==='ArrowLeft'){event.preventDefault();seekGlobal(globalTime()-5);}else if(event.key==='ArrowRight'){event.preventDefault();seekGlobal(globalTime()+5);}});
window.addEventListener('pagehide',saveState);document.addEventListener('visibilitychange',saveState);
if(publicSite){
  $('importStorage').textContent='导入文件仅保存在当前浏览器';$('transcribeAudio').disabled=true;$('transcribeAudio').closest('label').hidden=true;
  $('importTextFileLabel').textContent='选择 TXT / MD';$('textFile').accept='.txt,.md';
  $('helpCredit').textContent='音声：VOICEVOX Nemo · 女声1。共享页面可在线听读；新语音合成需使用本机工作台。';
  $('helpSource').textContent='共享文稿的校正只保存在当前浏览器，不会修改其他人看到的版本。自动假名与字幕仍需核对。';
  switchImport('audio');
}
refreshLibrary().catch(error=>{$('reader').innerHTML=`<div class="initial-state"><p>${esc(error.message)}</p><button class="button" id="retryLoad">重新载入</button></div>`;$('retryLoad').onclick=()=>location.reload();});
api('/api/health').then(health=>{state.ttsReady=health.ttsReady;if(publicSite){if(health.storageWarning){state.storageWarning=health.storageWarning;notice(health.storageWarning);}$('localStatus').textContent='共享资料 · 浏览器保存';$('asrHelp').textContent='可附上 SRT / VTT 字幕，按句跳转和复读；没有字幕也可保存与播放。';return;}$('localStatus').textContent=health.ttsReady?'本机语音引擎已就绪':'本机语音引擎未就绪';$('ttsStatus').textContent=health.ttsReady?'引擎已就绪':'引擎未就绪';$('ttsStatus').style.color=health.ttsReady?'var(--positive)':'var(--warning)';$('asrHelp').textContent=health.asrModelCached?'语音识别模型已保存在本机，可离线转写。识别后可以校正文字、时间和问题分节。':'自动转写首次使用需要下载本机模型。没有字幕也能保存和播放，之后可编辑字幕。';}).catch(()=>{$('localStatus').textContent='服务连接中断';});
const pendingJob=safe('kotoba:v1:job',null);if(pendingJob)startJob(pendingJob);
