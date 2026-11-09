/** GitHub Pages adapter: shared assets are read-only; imports stay in IndexedDB. */
const BASE = new URL('./', import.meta.url);
const DB_NAME = `kotoba-static-v1:${BASE.pathname}`;
const MAX_AUDIO_BYTES = 500 * 1024 * 1024;
const MAX_DURATION = 12 * 60 * 60;
const blobURLs = new Map();
let databasePromise;
let storageWarning = '';

function failure(message, status = 400, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function storageFailure(error, writing = false) {
  if (error?.name === 'QuotaExceededError') {
    return failure('浏览器存储空间不足，这次音频或修改没有保存。请释放此网站的存储空间，或改用本机版。', 507, 'STORAGE_QUOTA');
  }
  return failure(writing
    ? '浏览器无法保存这次导入或修改。请允许此网站使用本地存储，或改用本机版；共享资料不受影响。'
    : '浏览器本地资料暂时无法读取。共享资料仍可播放；请允许此网站使用本地存储后再导入或编辑。', 503, 'STORAGE_UNAVAILABLE');
}

function validID(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) throw failure('资料编号无效。');
  return value;
}

function newID(prefix) {
  const value = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${value}`;
}

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(storageFailure()); return; }
    let request;
    try { request = indexedDB.open(DB_NAME, 1); } catch (error) { reject(storageFailure(error)); return; }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('materials')) db.createObjectStore('materials', {keyPath: 'id'});
      if (!db.objectStoreNames.contains('jobs')) db.createObjectStore('jobs', {keyPath: 'id'});
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); databasePromise = undefined; };
      storageWarning = '';
      resolve(db);
    };
    request.onerror = () => reject(storageFailure(request.error));
    request.onblocked = () => reject(failure('本地资料库被其他页面占用，请关闭同一网站的旧标签页后重试。共享资料仍可播放。', 503, 'STORAGE_BLOCKED'));
  }).catch(error => { databasePromise = undefined; storageWarning = error.message; throw error; });
  return databasePromise;
}

async function readStore(store, id) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    let transaction, request;
    try {
      transaction = db.transaction(store, 'readonly');
      request = id === undefined ? transaction.objectStore(store).getAll() : transaction.objectStore(store).get(id);
    } catch (error) { reject(storageFailure(error)); return; }
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = transaction.onerror = () => reject(storageFailure(transaction.error || request.error));
  });
}

async function saveRecord(record, job) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    let transaction;
    try {
      transaction = db.transaction(job ? ['materials', 'jobs'] : ['materials'], 'readwrite');
      transaction.objectStore('materials').put(record);
      if (job) transaction.objectStore('jobs').put(job);
    } catch (error) { reject(storageFailure(error, true)); return; }
    // A successful put request is not a committed save. Resolve only on complete.
    transaction.oncomplete = () => { storageWarning = ''; resolve(); };
    transaction.onabort = transaction.onerror = event => reject(storageFailure(transaction.error || event.target?.error, true));
  });
}

async function fetchJSON(url, label) {
  let response;
  try { response = await fetch(url, {credentials: 'omit', cache: 'no-cache'}); }
  catch { throw failure(`${label}暂时无法载入，请检查网络后重试。浏览器内已保存的音频没有被删除。`, 503, 'LIBRARY_NETWORK'); }
  if (!response.ok) throw failure(`${label}载入失败（${response.status}）。请重新载入页面，或联系网站维护者检查共享文件。`, response.status, 'LIBRARY_HTTP');
  try { return await response.json(); }
  catch { throw failure(`${label}文件格式不正确，暂时无法使用。`, 500, 'LIBRARY_FORMAT'); }
}

function sharedAudioURL(id, value) {
  validID(id);
  const directory = new URL(`materials/${encodeURIComponent(id)}/`, BASE);
  const legacy = `/media/${id}/audio.mp3`;
  if (!value || value === legacy) return new URL('audio.mp3', directory).href;
  if (typeof value !== 'string' || /[\\\u0000-\u001f]/.test(value)) throw failure('共享音频地址无效。', 500);
  const relativeToRoot = /^\.?\/?materials\//.test(value);
  const candidate = new URL(value, relativeToRoot ? BASE : directory);
  if (candidate.origin !== BASE.origin || !candidate.pathname.startsWith(directory.pathname)
      || !/^https?:$/.test(candidate.protocol) || candidate.username || candidate.password || candidate.search || candidate.hash) {
    throw failure('共享音频必须位于这份资料的站内目录中。', 500, 'UNSAFE_ASSET_URL');
  }
  return candidate.href;
}

function validateMaterial(material, expectedID) {
  if (!material || material.id !== expectedID || !Array.isArray(material.questions) || !Array.isArray(material.cues)
      || !Number.isFinite(Number(material.duration)) || Number(material.duration) <= 0) {
    throw failure('这份资料的文稿或时长信息不完整，请联系网站维护者检查资料文件。', 500, 'LIBRARY_FORMAT');
  }
  return {...material, duration: Number(material.duration)};
}

function hydrateRecord(record) {
  const material = validateMaterial(record.material, record.id);
  if (record.audioBlob instanceof Blob) {
    let entry = blobURLs.get(record.id);
    const signature = `${record.audioKey || record.id}:${record.audioBlob.size}:${record.audioBlob.type}`;
    if (!entry || entry.signature !== signature) {
      if (entry) URL.revokeObjectURL(entry.url);
      entry = {signature, url: URL.createObjectURL(record.audioBlob)};
      blobURLs.set(record.id, entry);
    }
    return {...material, audioUrl: entry.url, browserLocal: true};
  }
  return {...material, audioUrl: sharedAudioURL(record.id, material.audioUrl), browserLocal: true, localOverride: true};
}

function summary(material) {
  return {
    id: material.id, title: material.title || '未命名资料', subtitle: material.subtitle || '',
    duration: Number(material.duration), voice: material.voice || '原始录音',
    questionCount: material.questions?.length ?? Number(material.questionCount || 0),
    createdAt: material.createdAt || '', audioUrl: material.audioUrl,
    source: material.source || 'shared', browserLocal: !!material.browserLocal, localOverride: !!material.localOverride,
  };
}

async function listMaterials() {
  const localPromise = readStore('materials').catch(error => { storageWarning = error.message; return []; });
  const manifest = await fetchJSON(new URL('manifest.json', BASE), '共享资料库');
  if (!manifest || !Array.isArray(manifest.materials)) throw failure('共享资料库清单格式不正确。', 500, 'LIBRARY_FORMAT');
  const rows = new Map();
  for (const row of manifest.materials) {
    validID(row.id);
    if (!Number.isFinite(Number(row.duration)) || Number(row.duration) <= 0) throw failure('共享资料库中有缺少时长的资料。', 500, 'LIBRARY_FORMAT');
    rows.set(row.id, {...summary(row), audioUrl: sharedAudioURL(row.id, row.audioUrl)});
  }
  for (const record of await localPromise) rows.set(record.id, summary(hydrateRecord(record)));
  return {materials: [...rows.values()], ...(storageWarning ? {storageWarning} : {})};
}

async function getMaterial(id) {
  validID(id);
  let local;
  try { local = await readStore('materials', id); }
  catch (error) {
    storageWarning = error.message;
    if (id.startsWith('local-')) throw error;
  }
  if (local) return hydrateRecord(local);
  if (id.startsWith('local-')) throw failure('这份音频不在当前浏览器中。导入音频只保存在导入时使用的浏览器里。', 404, 'LOCAL_MATERIAL_MISSING');
  const material = validateMaterial(await fetchJSON(new URL(`materials/${encodeURIComponent(id)}/material.json`, BASE), '共享文稿'), id);
  return {...material, audioUrl: sharedAudioURL(id, material.audioUrl), shared: true};
}

function decodeEntities(text) {
  const named = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '};
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (raw, entity) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? raw;
    const number = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return number >= 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : raw;
  });
}

function subtitleTime(value) {
  const parts = value.replace(',', '.').split(':').map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some(n => !Number.isFinite(n) || n < 0)) throw failure('字幕中有无法识别的时间。');
  const seconds = parts.pop(), minutes = parts.pop(), hours = parts.pop() || 0;
  if (seconds >= 60 || minutes >= 60) throw failure('字幕时间的分和秒必须小于 60。');
  return hours * 3600 + minutes * 60 + seconds;
}

/** Pure parser, also exported for non-browser boundary regression tests. */
export function parseTimedSubtitles(text, duration, title = '导入音频') {
  if (typeof text !== 'string' || text.length > 2_000_000) throw failure('字幕文件过大，最多支持 200 万字。');
  if (!Number.isFinite(duration) || duration <= 0) throw failure('音频时长无效。');
  const blocks = text.replace(/^\uFEFF/, '').replace(/\r/g, '').trim().split(/\n[ \t]*\n/);
  const cues = [], questions = [];
  let current, followup = 0, previousEnd = 0;
  for (const block of blocks) {
    if (/^(?:WEBVTT|NOTE(?:\s|$)|STYLE(?:\s|$)|REGION(?:\s|$))/.test(block)) continue;
    const lines = block.split('\n'), index = lines.findIndex(line => line.includes('-->'));
    if (index < 0) throw failure(`第 ${cues.length + 1} 条字幕缺少时间戳，请使用完整的 SRT 或 VTT 字幕。`);
    const timing = lines[index].match(/^\s*((?:\d+:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)(?:\s+.*)?$/);
    if (!timing) throw failure(`第 ${cues.length + 1} 条字幕的时间格式不正确，请使用 SRT 或 VTT。`);
    let start = subtitleTime(timing[1]), end = subtitleTime(timing[2]);
    const originalText = decodeEntities(lines.slice(index + 1).join(' ').replace(/<rt\b[^>]*>[\s\S]*?<\/rt>/gi, '').replace(/<[^>]+>/g, '')).trim();
    if (!originalText) throw failure(`第 ${cues.length + 1} 条字幕没有文字。`);
    if (!(start >= 0 && start < end && end <= duration + .05)) throw failure(`第 ${cues.length + 1} 条字幕超出音频时长，或结束时间不大于开始时间。`);
    if (cues.length && start < previousEnd - .001) throw failure(`第 ${cues.length + 1} 条字幕与上一条重叠，请调整时间后重试。`);
    start = Math.max(start, previousEnd); end = Math.min(end, duration);
    if (start >= end) throw failure(`第 ${cues.length + 1} 条字幕的有效时段为空。`);
    const main = originalText.match(/^(?:[QＱqｑ]\s*[0-9０-９]+|第\s*[0-9０-９]+\s*[問題题])\s*[.．:：、)）-]?\s*(.*)$/);
    const follow = originalText.match(/^(?:追問|追问|追加(?:の)?質問)\s*[0-9０-９]*\s*[.．:：、]?\s*(.*)$/);
    const answer = originalText.match(/^(?:回答|答え|答案|[AＡaａ])\s*[.．:：)）]\s*(.*)$/);
    let kind = followup ? 'followup_answer' : 'answer', cueText = originalText;
    if (!current || main) {
      current = {id: `q${questions.length + 1}`, number: questions.length + 1, title: main?.[1] || title, start, end};
      questions.push(current); followup = 0;
    }
    if (main) { kind = 'question'; cueText = main[1] || originalText; }
    else if (follow) { followup++; kind = 'followup_question'; cueText = follow[1] || originalText; }
    else if (answer) { kind = followup ? 'followup_answer' : 'answer'; cueText = answer[1] || originalText; }
    const cue = {id: `c${String(cues.length + 1).padStart(4, '0')}`, questionId: current.id, kind, text: cueText, start, end, tokens: [], timing: 'manual', tokenTiming: 'unavailable'};
    if (followup) cue.followupNumber = followup;
    if (cueText !== originalText) cue.originalSubtitleText = originalText;
    cues.push(cue); current.end = end; previousEnd = end;
    if (cues.length > 20_000) throw failure('字幕超过 20,000 句，请分成多个文件导入。');
  }
  if (!cues.length) throw failure('没有识别到带时间戳的字幕，请粘贴 SRT / VTT；普通文稿不能直接当作同步字幕。');
  return {cues, questions};
}

async function measureAudio(file) {
  if (typeof Audio === 'undefined') throw failure('此浏览器不支持音频预览，请换用较新的 Chrome、Edge 或 Safari。');
  const url = URL.createObjectURL(file), audio = new Audio();
  audio.preload = 'metadata';
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, duration) => {
      if (settled) return; settled = true; clearTimeout(timer);
      audio.onloadedmetadata = null; audio.onerror = null;
      audio.removeAttribute('src'); audio.load(); URL.revokeObjectURL(url);
      if (error) reject(error); else resolve(duration);
    };
    const timer = setTimeout(() => finish(failure('读取音频时长超时，文件尚未保存。请换用 MP3 / M4A / WAV，或在本机版导入。')), 25000);
    audio.onloadedmetadata = () => {
      const duration = Number(audio.duration);
      if (!Number.isFinite(duration) || duration <= 0) finish(failure('浏览器无法确定此音频的时长。请转换为 MP3 / M4A / WAV，或使用本机版导入。'));
      else if (duration > MAX_DURATION) finish(failure('单份音频最长支持 12 小时，请分成多个文件导入。'));
      else finish(null, duration);
    };
    audio.onerror = () => finish(failure('浏览器无法播放这个音频格式，文件尚未保存。请换用 MP3 / M4A / WAV，或使用本机版。'));
    audio.src = url; audio.load();
  });
}

async function importAudio(form) {
  if (!(form instanceof FormData)) throw failure('音频上传格式不正确，请重新选择文件。');
  if (String(form.get('transcribe')).toLowerCase() === 'true') throw failure('共享网页版不能自动转写音频。请导入 SRT/VTT 字幕，或在本机版中使用日语自动转写。', 501, 'LOCAL_ENGINE_REQUIRED');
  const file = form.get('file');
  if (!(file instanceof Blob) || !file.size) throw failure('请先选择一个非空音频文件。');
  if (file.size > MAX_AUDIO_BYTES) throw failure('音频超过 500 MB，请先分成较小文件。', 413);
  if (!/^audio\//.test(file.type) && !/\.(mp3|wav|m4a|aac|ogg|opus|flac|webm|aiff?|mp4)$/i.test(file.name || '')) throw failure('请选择 MP3、M4A、WAV 或其他浏览器支持的音频文件。');
  await openDatabase();
  const duration = await measureAudio(file);
  const id = newID('local'), timestamp = new Date().toISOString();
  const title = String(form.get('title') || (file.name || '导入音频').replace(/\.[^.]+$/, '')).trim().slice(0, 160) || '导入音频';
  const subtitle = String(form.get('transcript') || '').trim();
  const transcript = subtitle ? parseTimedSubtitles(subtitle, duration, title) : {
    questions: [{id: 'q1', number: 1, title, start: 0, end: duration}],
    cues: [{id: 'c0001', questionId: 'q1', kind: 'answer', text: '此音频尚无同步文稿，可在校正文稿中补充文字和时间。', start: 0, end: duration, tokens: [], timing: 'manual', noTranscript: true}],
  };
  const material = {id, title, subtitle: subtitle ? '浏览器保存 · 导入字幕' : '浏览器保存 · 纯音频', createdAt: timestamp, duration, voice: '原始录音', source: 'audio', browserLocal: true,
    ...transcript, timingNote: subtitle ? '句子时间来自导入的字幕，尚未生成自动假名。' : '没有同步字幕；音频可正常播放。'};
  const job = {id: newID('local-job'), status: 'complete', progress: 1, message: '音频和文稿已保存在当前浏览器，可以开始听读。', materialId: id, createdAt: timestamp, updatedAt: timestamp};
  await saveRecord({id, material, audioBlob: file, audioKey: id, audioName: file.name || 'audio', updatedAt: timestamp}, job);
  return {jobId: job.id};
}

function jsonBody(options) {
  let value;
  try { value = typeof options.body === 'string' ? JSON.parse(options.body) : options.body; }
  catch { throw failure('请求中的文字格式不正确。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('请求格式不正确。');
  return value;
}

async function editCues(id, body) {
  await openDatabase();
  const material = await getMaterial(id), oldRecord = await readStore('materials', id);
  if (!Array.isArray(body.cues) || !body.cues.length || body.cues.length > 20_000) throw failure('请保留 1–20,000 句字幕。');
  const originals = new Map(material.cues.map(cue => [cue.id, cue]));
  const seen = new Set(), groups = new Map();
  const allowedKinds = new Set(['question', 'answer', 'followup_question', 'followup_answer', 'student_backup_label', 'student_backup_question', 'narration', 'navigation_label']);
  let previousEnd = 0, previousQuestion;
  const cues = body.cues.map((item, index) => {
    const cueID = validID(item.id || `c${String(index + 1).padStart(4, '0')}`), questionId = validID(item.questionId || 'q1');
    if (seen.has(cueID)) throw failure('字幕编号重复，请重新打开校正文稿后再试。');
    seen.add(cueID);
    const text = String(item.text ?? '').trim(), start = Number(item.start), end = Number(item.end);
    if (!text || text.length > 10_000) throw failure(`第 ${index + 1} 句的文字为空或过长。`);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > material.duration + .02) throw failure(`第 ${index + 1} 句的时间需在音频范围内，结束时间应晚于开始时间。`);
    if (start < previousEnd - .001) throw failure(`第 ${index + 1} 句与上一句重叠，请调整时间。`);
    if (!allowedKinds.has(item.kind)) throw failure(`第 ${index + 1} 句的类型无效。`);
    if (questionId !== previousQuestion && groups.has(questionId)) throw failure('同一题的句子必须连续。分散的句子请加入复读清单。');
    const original = originals.get(cueID), changed = !original || original.text !== text || original.start !== start || original.end !== end;
    const cue = {...original, id: cueID, questionId, kind: item.kind, text, start, end};
    if (changed) { cue.tokens = []; cue.timing = 'manual'; cue.tokenTiming = 'unavailable'; }
    if (original?.text !== text) delete cue.noTranscript;
    if (!groups.has(questionId)) groups.set(questionId, []);
    groups.get(questionId).push(cue); previousQuestion = questionId; previousEnd = end;
    return cue;
  });
  const titles = new Map(material.questions.map(q => [q.id, q.title]));
  if (body.questions !== undefined) {
    if (!Array.isArray(body.questions) || body.questions.length > 500) throw failure('小节信息格式不正确。');
    for (const question of body.questions) titles.set(validID(question.id), String(question.title || '未命名小节').slice(0, 160));
  }
  const questions = [...groups].map(([questionId, group], index) => ({id: questionId, number: index + 1, title: titles.get(questionId) || `小节 ${index + 1}`, start: group[0].start, end: group[group.length - 1].end}));
  const updatedAt = new Date().toISOString();
  const updated = {...material, cues, questions, updatedAt, browserLocal: true, localOverride: !oldRecord?.audioBlob};
  // Blob URLs are page-lifetime handles, never persist them in the database.
  if (oldRecord?.audioBlob) delete updated.audioUrl;
  const record = {...oldRecord, id, material: updated, updatedAt};
  await saveRecord(record);
  return hydrateRecord(record);
}

async function readText(form) {
  if (!(form instanceof FormData)) throw failure('请选择一个文稿文件。');
  const file = form.get('file');
  if (!(file instanceof Blob)) throw failure('请选择一个文稿文件。');
  if (/\.docx$/i.test(file.name || '')) throw failure('共享网页版暂不读取 DOCX。请另存为 TXT / Markdown，或在本机版中导入 DOCX。', 501, 'LOCAL_DOCUMENT_REQUIRED');
  if (!/\.(txt|md)$/i.test(file.name || '')) throw failure('共享网页版支持 UTF-8 TXT 和 Markdown 文件。');
  if (file.size > 15 * 1024 * 1024) throw failure('文稿文件最大 15 MB。', 413);
  let text;
  try { text = new TextDecoder('utf-8', {fatal: true}).decode(await file.arrayBuffer()).replace(/^\uFEFF/, ''); }
  catch { throw failure('文稿不是 UTF-8 编码。请另存为 UTF-8 TXT 或 Markdown 后再导入。'); }
  if (text.length > 200_000) throw failure('文稿超过 200,000 字，请分成多个文件。');
  return {text};
}

/** Return API-shaped JSON values; errors have .status and a user-facing message. */
export async function staticApi(url, options = {}) {
  const parsedURL = new URL(url, BASE);
  if (parsedURL.origin !== BASE.origin) throw failure('只能访问当前网站内的资料。', 403);
  let route = parsedURL.pathname;
  if (route.startsWith(BASE.pathname + 'api/')) route = '/api/' + route.slice((BASE.pathname + 'api/').length);
  const method = String(options.method || 'GET').toUpperCase();
  if (method === 'GET' && route === '/api/health') {
    let storageReady = true;
    try { await openDatabase(); } catch (error) { storageReady = false; storageWarning = error.message; }
    return {ok: true, staticSite: true, ttsReady: false, asrReady: false, asrModelCached: false, storage: 'browser', storageReady, ...(storageWarning ? {storageWarning} : {}), maxUploadMB: 500};
  }
  if (method === 'GET' && route === '/api/materials') return listMaterials();
  let match = route.match(/^\/api\/materials\/([^/]+)$/);
  if (method === 'GET' && match) return getMaterial(decodeURIComponent(match[1]));
  match = route.match(/^\/api\/jobs\/([^/]+)$/);
  if (method === 'GET' && match) {
    const job = await readStore('jobs', validID(decodeURIComponent(match[1])));
    if (!job) throw failure('当前浏览器找不到这项导入记录；已经保存的资料仍在资料库中。', 404, 'JOB_MISSING');
    return job;
  }
  if (method === 'POST' && route === '/api/import-audio') return importAudio(options.body);
  if (method === 'POST' && route === '/api/read-text') return readText(options.body);
  if (method === 'POST' && ['/api/parse', '/api/generate'].includes(route)) throw failure('文字转日语语音需要运行本机版 VOICEVOX Nemo。共享网站可以播放已有材料，也可导入音频和 SRT/VTT 字幕。', 501, 'LOCAL_ENGINE_REQUIRED');
  match = route.match(/^\/api\/materials\/([^/]+)\/cues$/);
  if (method === 'POST' && match) return editCues(validID(decodeURIComponent(match[1])), jsonBody(options));
  match = route.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
  if (method === 'POST' && match) {
    const job = await readStore('jobs', validID(decodeURIComponent(match[1])));
    if (!job) throw failure('当前浏览器找不到这项任务。', 404);
    return {ok: true, status: job.status, message: '这份音频已经保存完成。'};
  }
  throw failure('共享网页版暂不支持这项操作，请使用本机版。', 404, 'STATIC_ROUTE_UNSUPPORTED');
}

if (typeof window !== 'undefined') window.addEventListener('pagehide', event => {
  if (event.persisted) return;
  for (const {url} of blobURLs.values()) URL.revokeObjectURL(url);
  blobURLs.clear();
});
