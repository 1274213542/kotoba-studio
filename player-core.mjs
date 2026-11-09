export const displayCues = material => material.cues.filter(c => c.kind !== 'narration' && c.kind !== 'navigation_label' && !c.noTranscript);
export function questionSelection(cues, questionId, queue) {
  const ids = [...new Set(displayCues({cues}).filter(c => c.questionId === questionId).map(c => c.id))];
  const picked = new Set(queue), selected = ids.filter(id => picked.has(id)).length;
  return {ids, selected, total:ids.length, status:!selected ? 'none' : selected === ids.length ? 'all' : 'partial'};
}
export function removeQuestionSelection(cues, questionId, queue) {
  const ids = new Set(questionSelection(cues, questionId, queue).ids);
  return [...new Set(queue)].filter(id => !ids.has(id));
}
export function toggleQuestionSelection(cues, questionId, queue) {
  const selection = questionSelection(cues, questionId, queue);
  if (selection.status === 'all') return removeQuestionSelection(cues, questionId, queue);
  return [...new Set([...queue, ...selection.ids])];
}
export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export function cueAt(cues, time) {
  if (!cues.length) return null;
  let low = 0, high = cues.length - 1;
  while (low <= high) { const mid = (low + high) >> 1; if (cues[mid].start <= time + .015) low = mid + 1; else high = mid - 1; }
  return high < 0 ? null : cues[high];
}
export function playbackWindow(material, mode, anchorId, range, queue, queueIndex = 0) {
  const cues = displayCues(material), anchor = cues.find(c => c.id === anchorId) || cues[0];
  if (mode === 'sentence' && anchor) return {start:anchor.start, end:anchor.end, clip:true, loop:true};
  if (mode === 'question' && anchor) { const q = material.questions.find(q => q.id === anchor.questionId); if (q) return {start:q.start, end:q.end, clip:true, loop:true}; }
  if (mode === 'range' && range?.a && range?.b) {
    const a = cues.find(c => c.id === range.a), b = cues.find(c => c.id === range.b);
    if (a && b) return {start:Math.min(a.start,b.start), end:Math.max(a.end,b.end), clip:true, loop:true};
  }
  if (mode === 'queue' && queue.length) { const cue = cues.find(c => c.id === queue[queueIndex % queue.length]); if (cue) return {start:cue.start,end:cue.end,clip:true,loop:false}; }
  return {start:0,end:material.duration,clip:false,loop:mode === 'all'};
}
export function nextQueueIndex(index, length, direction = 1) { return length ? (index + direction + length) % length : 0; }
export function formatTime(value) { const seconds = Math.max(0, Math.floor(Number(value) || 0)); const minutes = Math.floor(seconds / 60); return `${String(minutes).padStart(2,'0')}:${String(seconds % 60).padStart(2,'0')}`; }
export function validateCueEdits(cues, duration) {
  let previousEnd = 0;
  for (const [i,cue] of cues.entries()) {
    if (!cue.text.trim()) return `第 ${i + 1} 句不能为空。`;
    if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || cue.end <= cue.start || cue.end > duration + .05) return `第 ${i + 1} 句的起止时间不正确。`;
    if (cue.start < previousEnd - .025) return `第 ${i + 1} 句与上一句重叠，请调整时间。`;
    previousEnd = cue.end;
  }
  return null;
}
