// 보이스 드럼패드
'use strict';

// ---------- 상수 ----------

// 키보드 배치 (event.code 기준, 왼쪽 위부터 행 순서)
const KEY_LAYOUT = [
  ['Digit4', 'Digit5', 'Digit6', 'Digit7'],
  ['KeyR',   'KeyT',   'KeyY',   'KeyU'],
  ['KeyF',   'KeyG',   'KeyH',   'KeyJ'],
  ['KeyV',   'KeyB',   'KeyN',   'KeyM'],
];
const KEY_CODES = KEY_LAYOUT.flat();
const KEY_LABELS = KEY_CODES.map((c) => c.replace(/^(Key|Digit)/, ''));
const PAD_COUNT = KEY_CODES.length;

const MAX_RECORD_MS = 5000;        // 최대 녹음 길이
const TRIM_WINDOW_SEC = 0.01;      // 무음 판정 창 (10ms)
const TRIM_MIN_GAP_SEC = 0.02;     // 시작점과 끝점 최소 간격

const DB_NAME = 'voice-drumpad';
const DB_VERSION = 1;
const DB_STORE = 'pads';

// ---------- 상태 ----------

const state = {
  // 각 칸: null 또는 { blob, buffer, start, end }
  pads: new Array(PAD_COUNT).fill(null),
  audioCtx: null,
  started: false,
  editMode: false,
  moveFrom: -1,        // 위치 바꾸기 중인 패드 번호
  modal: null,         // 'menu' | 'record' | 'trim' | null
};

const $ = (id) => document.getElementById(id);
const padEls = [];

// ---------- IndexedDB ----------

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: 'index' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function dbRequest(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, mode);
    const store = tx.objectStore(DB_STORE);
    const req = fn(store);
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

const dbGetAll = () => dbRequest('readonly', (s) => s.getAll());
const dbPut = (record) => dbRequest('readwrite', (s) => s.put(record));
const dbDelete = (index) => dbRequest('readwrite', (s) => s.delete(index));
const dbClear = () => dbRequest('readwrite', (s) => s.clear());

// 패드 하나의 현재 상태를 저장 (비어 있으면 삭제)
async function savePad(index) {
  const pad = state.pads[index];
  try {
    if (pad) {
      await dbPut({
        index,
        blob: pad.blob,
        start: pad.start,
        end: pad.end,
      });
    } else {
      await dbDelete(index);
    }
  } catch (err) {
    console.error('저장 실패', err);
    alert('저장에 실패했습니다. 브라우저 저장 공간을 확인해 주세요.');
  }
}

// ---------- 오디오 ----------

function ensureAudioContext() {
  if (!state.audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    state.audioCtx = new Ctx();
  }
  return state.audioCtx;
}

function resumeAudio() {
  const ctx = ensureAudioContext();
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function blobToArrayBuffer(blob) {
  if (blob.arrayBuffer) return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(blob);
  });
}

async function decodeBlob(blob) {
  const ctx = ensureAudioContext();
  if (!ctx) throw new Error('AudioContext 없음');
  const data = await blobToArrayBuffer(blob);
  // 콜백 형태: 구형 사파리까지 지원
  return new Promise((resolve, reject) => {
    ctx.decodeAudioData(data, resolve, (e) => reject(e || new Error('decode failed')));
  });
}

// 녹음된 그대로, 선택 구간만 재생. 매번 새 노드를 만들어 겹쳐 재생된다.
function playBuffer(buffer, start, end) {
  const ctx = resumeAudio();
  if (!ctx) return null;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  const dur = Math.max(0.005, end - start);
  src.start(0, start, dur);
  return src;
}

// 앞뒤 무음 자동 자르기: 10ms 창의 RMS 가 기준 이하이면 무음
function findTrim(buffer) {
  const sr = buffer.sampleRate;
  const win = Math.max(1, Math.floor(sr * TRIM_WINDOW_SEC));
  const chCount = buffer.numberOfChannels;
  const channels = [];
  for (let c = 0; c < chCount; c++) channels.push(buffer.getChannelData(c));
  const len = buffer.length;
  const nWin = Math.ceil(len / win);
  const rms = new Float32Array(nWin);
  let peak = 0;
  for (let w = 0; w < nWin; w++) {
    const s0 = w * win;
    const s1 = Math.min(len, s0 + win);
    let sum = 0;
    for (let c = 0; c < chCount; c++) {
      const d = channels[c];
      for (let i = s0; i < s1; i++) sum += d[i] * d[i];
    }
    const v = Math.sqrt(sum / ((s1 - s0) * chCount));
    rms[w] = v;
    if (v > peak) peak = v;
  }
  const threshold = Math.max(0.004, peak * 0.06);
  let first = -1;
  let last = -1;
  for (let w = 0; w < nWin; w++) {
    if (rms[w] > threshold) {
      if (first < 0) first = w;
      last = w;
    }
  }
  if (first < 0) return [0, buffer.duration];
  const start = Math.max(0, (first - 1) * win) / sr;
  const end = Math.min(len, (last + 2) * win) / sr;
  return [start, Math.max(end, start + TRIM_MIN_GAP_SEC)];
}

// ---------- 패드 화면 ----------

function buildPads() {
  const grid = $('pad-grid');
  grid.innerHTML = '';
  for (let i = 0; i < PAD_COUNT; i++) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'pad empty';
    el.tabIndex = -1;
    el.dataset.index = String(i);
    el.innerHTML = `<span class="pad-key">${KEY_LABELS[i]}</span><span class="pad-info"></span>`;
    grid.appendChild(el);
    padEls.push(el);
  }

  // Pointer Events 로 마우스·터치를 한 번에 처리 (중복 재생 방지). 연주는 손가락이 닿는 순간 소리가 나야 한다.
  grid.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.pad');
    if (!el) return;
    e.preventDefault();
    if (!state.editMode) pressPad(Number(el.dataset.index));
  });
  // 수정 모드의 메뉴 열기는 click 으로. 터치가 끝나면 브라우저가 그 자리에 click 을 한 번 더 보내는데,
  // pointerdown 에서 창을 열면 그 click 이 방금 뜬 창 위에 떨어져 창이 닫히거나 버튼이 눌린다.
  grid.addEventListener('click', (e) => {
    const el = e.target.closest('.pad');
    if (!el || !state.editMode) return;
    pressPad(Number(el.dataset.index));
  });
  grid.addEventListener('contextmenu', (e) => e.preventDefault());
}

function renderPad(i) {
  const el = padEls[i];
  const pad = state.pads[i];
  el.classList.toggle('filled', !!pad);
  el.classList.toggle('empty', !pad);
}

function renderAllPads() {
  for (let i = 0; i < PAD_COUNT; i++) renderPad(i);
}

function flashPad(i, cls) {
  const el = padEls[i];
  el.classList.remove('hit', 'shake');
  void el.offsetWidth; // 애니메이션 재시작
  el.classList.add(cls);
}

function pressPad(i) {
  if (!state.started) return;
  if (state.editMode) {
    if (state.moveFrom >= 0) doMove(i);
    else openMenu(i);
    return;
  }
  playPad(i);
}

function playPad(i) {
  const pad = state.pads[i];
  if (!pad || !pad.buffer) {
    flashPad(i, 'shake');
    return;
  }
  flashPad(i, 'hit');
  playBuffer(pad.buffer, pad.start, pad.end);
}

// ---------- 키보드 ----------

function onKeyDown(e) {
  if (e.repeat) return;
  if (e.key === 'Escape') {
    if (state.modal) cancelModal();
    else if (state.moveFrom >= 0) cancelMove();
    return;
  }
  if (!state.started || state.modal) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const i = KEY_CODES.indexOf(e.code);   // 물리 키 위치: 한글 입력 상태에서도 동작
  if (i < 0) return;
  e.preventDefault();
  pressPad(i);
}

// ---------- 모달 ----------

function openModal(name) {
  state.modal = name;
  $(`${name}-modal`).hidden = false;
}

function closeModal() {
  if (!state.modal) return;
  $(`${state.modal}-modal`).hidden = true;
  state.modal = null;
}

function cancelModal() {
  if (state.modal === 'record') cancelRecording();
  else if (state.modal === 'trim') closeTrim();
  else closeModal();
}

// ---------- 수정 모드 ----------

function setEditMode(on) {
  state.editMode = on;
  document.body.classList.toggle('edit-mode', on);
  $('edit-banner').hidden = !on;
  $('clear-all-btn').hidden = !on;
  const btn = $('edit-toggle-btn');
  btn.classList.toggle('active', on);
  btn.textContent = on ? '수정 끝내기' : '수정 모드';
  if (!on) {
    cancelMove();
    cancelModal();
  }
}

function openMenu(i) {
  const pad = state.pads[i];
  $('menu-title').textContent = `패드 ${KEY_LABELS[i]} ${pad ? '(채워짐)' : '(비어 있음)'}`;
  const actions = $('menu-actions');
  actions.innerHTML = '';
  const add = (label, cls, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn ${cls || ''}`;
    b.textContent = label;
    b.addEventListener('click', fn);
    actions.appendChild(b);
  };
  if (!pad) {
    add('녹음', 'btn-primary', () => { closeModal(); openRecord(i); });
  } else {
    add('다시 녹음', 'btn-primary', () => { closeModal(); openRecord(i); });
    add('구간 편집', '', () => { closeModal(); openTrim(i); });
    add('위치 바꾸기', '', () => { closeModal(); startMove(i); });
    add('지우기', 'btn-danger', () => { closeModal(); clearPad(i); });
  }
  openModal('menu');
}

async function clearPad(i) {
  state.pads[i] = null;
  renderPad(i);
  await savePad(i);
}

async function clearAll() {
  if (!confirm('정말 모두 지울까요?')) return;
  cancelMove();
  for (let i = 0; i < PAD_COUNT; i++) state.pads[i] = null;
  renderAllPads();
  try {
    await dbClear();
  } catch (err) {
    console.error(err);
  }
}

// 위치 바꾸기
function startMove(i) {
  state.moveFrom = i;
  padEls[i].classList.add('move-source');
  $('move-text').textContent = `패드 ${KEY_LABELS[i]}의 소리를 옮깁니다. 바꿀 자리를 누르세요.`;
  $('move-banner').hidden = false;
}

function cancelMove() {
  if (state.moveFrom >= 0) padEls[state.moveFrom].classList.remove('move-source');
  state.moveFrom = -1;
  $('move-banner').hidden = true;
}

async function doMove(to) {
  const from = state.moveFrom;
  cancelMove();
  if (from === to) return;
  const a = state.pads[from];
  state.pads[from] = state.pads[to];
  state.pads[to] = a;
  renderPad(from);
  renderPad(to);
  await savePad(from);
  await savePad(to);
}

// ---------- 녹음 ----------

const rec = {
  index: -1,
  stream: null,
  recorder: null,
  chunks: [],
  mimeType: '',
  startedAt: 0,
  tickTimer: null,
  stopTimer: null,
  recording: false,
  cancelled: false,
};

function pickMimeType() {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

function setRecordUI(phase, message, isError) {
  const ind = $('record-indicator');
  const btn = $('record-btn');
  const status = $('record-status');
  ind.classList.toggle('recording', phase === 'recording');
  btn.disabled = phase === 'processing';
  btn.textContent = phase === 'recording' ? '정지' : '녹음 시작';
  status.classList.toggle('error', !!isError);
  if (message !== undefined) status.textContent = message;
}

function openRecord(i) {
  rec.index = i;
  rec.cancelled = false;
  $('record-title').textContent = `패드 ${KEY_LABELS[i]} 녹음`;
  $('record-time').textContent = '0.0 / 5.0초';
  setRecordUI('idle', '녹음 시작을 누르면 마이크 권한을 요청합니다. 최대 5초.', false);
  openModal('record');
}

function micErrorMessage(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return '마이크 권한이 거부되어 녹음할 수 없습니다.\n'
      + 'PC·안드로이드 크롬: 주소창 왼쪽 자물쇠(또는 ⓘ) 아이콘 → 마이크 → 허용으로 바꾼 뒤 새로고침하세요.\n'
      + '아이폰 사파리: 주소창의 "가가" 아이콘 → 웹 사이트 설정 → 마이크 허용, 또는 설정 → Safari → 마이크를 확인하세요.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return '사용할 수 있는 마이크를 찾지 못했습니다. 마이크가 연결되어 있는지 확인하세요.';
  }
  if (name === 'NotReadableError') {
    return '다른 프로그램이 마이크를 사용 중이라 열 수 없습니다. 다른 앱을 닫고 다시 시도하세요.';
  }
  return `마이크를 열 수 없습니다. (${name || err})`;
}

async function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setRecordUI('idle', '이 브라우저에서는 마이크를 쓸 수 없습니다. HTTPS 주소(또는 localhost)로 열어야 합니다.', true);
    return;
  }
  if (!window.MediaRecorder) {
    setRecordUI('idle', '이 브라우저는 녹음(MediaRecorder)을 지원하지 않습니다. 최신 크롬 또는 사파리를 사용하세요.', true);
    return;
  }
  resumeAudio();
  setRecordUI('idle', '마이크 권한을 확인하는 중...', false);
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    setRecordUI('idle', micErrorMessage(err), true);
    return;
  }
  if (state.modal !== 'record' || rec.cancelled) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  rec.stream = stream;
  rec.mimeType = pickMimeType();
  try {
    rec.recorder = rec.mimeType
      ? new MediaRecorder(stream, { mimeType: rec.mimeType })
      : new MediaRecorder(stream);
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    setRecordUI('idle', `녹음기를 만들지 못했습니다. (${err.name})`, true);
    return;
  }
  rec.chunks = [];
  rec.recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) rec.chunks.push(e.data); };
  rec.recorder.onstop = onRecordingStop;
  rec.recorder.onerror = (e) => {
    console.error('MediaRecorder error', e);
    setRecordUI('idle', '녹음 중 오류가 났습니다. 다시 시도하세요.', true);
  };
  rec.recorder.start();
  rec.recording = true;
  rec.startedAt = performance.now();
  rec.tickTimer = setInterval(updateRecordTime, 50);
  rec.stopTimer = setTimeout(stopRecording, MAX_RECORD_MS);
  setRecordUI('recording', '녹음 중... 정지를 누르거나 5초가 지나면 끝납니다.', false);
  updateRecordTime();
}

function updateRecordTime() {
  const sec = Math.min(MAX_RECORD_MS, performance.now() - rec.startedAt) / 1000;
  $('record-time').textContent = `${sec.toFixed(1)} / 5.0초`;
}

function clearRecordTimers() {
  clearInterval(rec.tickTimer);
  clearTimeout(rec.stopTimer);
  rec.tickTimer = null;
  rec.stopTimer = null;
}

function stopRecording() {
  if (rec.recorder && rec.recorder.state !== 'inactive') rec.recorder.stop();
}

function releaseStream() {
  if (rec.stream) rec.stream.getTracks().forEach((t) => t.stop());
  rec.stream = null;
}

function cancelRecording() {
  rec.cancelled = true;
  clearRecordTimers();
  if (rec.recording) stopRecording();
  else releaseStream();
  rec.recording = false;
  closeModal();
}

async function onRecordingStop() {
  clearRecordTimers();
  rec.recording = false;
  releaseStream();
  if (rec.cancelled) return;

  const type = rec.recorder.mimeType || rec.mimeType || 'audio/webm';
  const blob = new Blob(rec.chunks, { type });
  if (blob.size === 0) {
    setRecordUI('idle', '녹음된 내용이 없습니다. 다시 시도하세요.', true);
    return;
  }
  setRecordUI('processing', '녹음을 정리하는 중...', false);

  let buffer;
  try {
    buffer = await decodeBlob(blob);
  } catch (err) {
    console.error('decode 실패', err);
    setRecordUI('idle', '녹음 파일을 해석하지 못했습니다. 다시 시도하세요.', true);
    return;
  }
  if (state.modal !== 'record' || rec.cancelled) return;

  // 바로 패드에 넣지 않고, 자동 자르기 위치가 잡힌 편집 화면을 먼저 보여준다.
  // 저장을 눌러야 패드에 들어간다.
  const [start, end] = findTrim(buffer);
  closeModal();
  openTrim(rec.index, { blob, buffer, autoStart: start, autoEnd: end });
}

// ---------- 구간 편집 ----------

const trim = {
  index: -1,
  buffer: null,
  start: 0,
  end: 0,
  dragging: null,     // 'start' | 'end' | null
  previewSrc: null,
  pending: null,      // 방금 녹음한 것(아직 패드에 안 들어감): { blob, buffer, autoStart, autoEnd }
};

// pendingRec 이 있으면 "녹음 직후 확인" 화면, 없으면 이미 저장된 패드의 구간 편집
function openTrim(i, pendingRec) {
  trim.index = i;
  trim.pending = pendingRec || null;
  if (pendingRec) {
    trim.buffer = pendingRec.buffer;
    trim.start = pendingRec.autoStart;
    trim.end = pendingRec.autoEnd;
    $('trim-title').textContent = `패드 ${KEY_LABELS[i]} 녹음 확인`;
  } else {
    const pad = state.pads[i];
    if (!pad || !pad.buffer) return;
    trim.buffer = pad.buffer;
    trim.start = pad.start;
    trim.end = pad.end;
    $('trim-title').textContent = `패드 ${KEY_LABELS[i]} 구간 편집`;
  }
  $('trim-hint').textContent = pendingRec
    ? '앞뒤 무음을 자동으로 잘랐습니다. 막대를 끌어 구간을 조절하고, 재생으로 들어본 뒤 저장하세요.'
    : '막대를 끌어 구간을 조절하세요. 원본은 그대로 남습니다.';
  openModal('trim');
  requestAnimationFrame(() => {
    drawWave();
    layoutHandles();
  });
}

function closeTrim() {
  stopPreview();
  trim.pending = null;   // 녹음 직후 화면에서 취소하면 그 녹음은 버린다
  closeModal();
}

function stopPreview() {
  if (trim.previewSrc) {
    try { trim.previewSrc.stop(); } catch (e) { /* 이미 끝남 */ }
    trim.previewSrc = null;
  }
}

function drawWave() {
  const wrap = $('wave-wrap');
  const canvas = $('wave-canvas');
  const dpr = window.devicePixelRatio || 1;
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const buf = trim.buffer;
  const data = buf.getChannelData(0);
  const len = data.length;
  const mid = h / 2;
  ctx.strokeStyle = '#8fb3ff';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x < w; x++) {
    const s0 = Math.floor((x / w) * len);
    const s1 = Math.max(s0 + 1, Math.floor(((x + 1) / w) * len));
    let min = 1;
    let max = -1;
    for (let s = s0; s < s1 && s < len; s++) {
      const v = data[s];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (min > max) { min = 0; max = 0; }
    ctx.moveTo(x + 0.5, mid - max * mid * 0.95);
    ctx.lineTo(x + 0.5, mid - min * mid * 0.95 + 1);
  }
  ctx.stroke();
  ctx.strokeStyle = '#3a3e48';
  ctx.beginPath();
  ctx.moveTo(0, mid + 0.5);
  ctx.lineTo(w, mid + 0.5);
  ctx.stroke();
}

function layoutHandles() {
  const wrap = $('wave-wrap');
  const w = wrap.clientWidth;
  const dur = trim.buffer.duration;
  const x0 = (trim.start / dur) * w;
  const x1 = (trim.end / dur) * w;
  $('handle-start').style.left = `${x0}px`;
  $('handle-end').style.left = `${x1}px`;
  const region = $('wave-region');
  region.style.left = `${x0}px`;
  region.style.width = `${x1 - x0}px`;
  $('trim-info').textContent =
    `${trim.start.toFixed(2)}초 ~ ${trim.end.toFixed(2)}초 (길이 ${(trim.end - trim.start).toFixed(2)}초 / 전체 ${dur.toFixed(2)}초)`;
}

function setupTrimHandles() {
  const wrap = $('wave-wrap');
  const bind = (el, which) => {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      trim.dragging = which;
      el.classList.add('dragging');
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (trim.dragging !== which) return;
      const rect = wrap.getBoundingClientRect();
      const x = Math.min(rect.width, Math.max(0, e.clientX - rect.left));
      const t = (x / rect.width) * trim.buffer.duration;
      if (which === 'start') {
        trim.start = Math.min(t, trim.end - TRIM_MIN_GAP_SEC);   // 시작점은 끝점을 넘을 수 없다
        trim.start = Math.max(0, trim.start);
      } else {
        trim.end = Math.max(t, trim.start + TRIM_MIN_GAP_SEC);
        trim.end = Math.min(trim.buffer.duration, trim.end);
      }
      layoutHandles();
    });
    const end = (e) => {
      if (trim.dragging !== which) return;
      trim.dragging = null;
      el.classList.remove('dragging');
      try { el.releasePointerCapture(e.pointerId); } catch (err) { /* 무시 */ }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  };
  bind($('handle-start'), 'start');
  bind($('handle-end'), 'end');

  $('trim-play-btn').addEventListener('click', () => {
    stopPreview();
    trim.previewSrc = playBuffer(trim.buffer, trim.start, trim.end);
  });
  const saveTrim = async () => {
    const i = trim.index;
    const p = trim.pending;
    if (p) {
      // 녹음 직후: 이제 패드에 넣는다
      state.pads[i] = {
        blob: p.blob, buffer: p.buffer,
        start: trim.start, end: trim.end,
      };
      renderPad(i);
      closeTrim();
      await savePad(i);
      return;
    }
    const pad = state.pads[i];
    if (pad) {
      pad.start = trim.start;    // 원본은 그대로, 시작·끝점만 저장
      pad.end = trim.end;
      renderPad(i);
      closeTrim();
      await savePad(i);
    } else {
      closeTrim();
    }
  };
  $('trim-save-btn').addEventListener('click', saveTrim);
  $('trim-cancel-btn').addEventListener('click', closeTrim);
  window.addEventListener('resize', () => {
    if (state.modal === 'trim') {
      drawWave();
      layoutHandles();
    }
  });
}

// ---------- 저장 복원 ----------

async function loadPads() {
  let records = [];
  try {
    records = await dbGetAll();
  } catch (err) {
    console.error('IndexedDB 열기 실패', err);
    return;
  }
  for (const r of records) {
    if (r.index < 0 || r.index >= PAD_COUNT || !r.blob) continue;
    state.pads[r.index] = {
      blob: r.blob,
      start: r.start,
      end: r.end,
      buffer: null,
    };
  }
  renderAllPads();
  await decodeMissing();
}

async function decodeMissing() {
  for (let i = 0; i < PAD_COUNT; i++) {
    const pad = state.pads[i];
    if (!pad || pad.buffer) continue;
    try {
      pad.buffer = await decodeBlob(pad.blob);
    } catch (err) {
      console.error(`패드 ${KEY_LABELS[i]} 해석 실패`, err);
    }
  }
}

function requestPersist() {
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().then((ok) => {
      console.log('영구 저장', ok ? '허용' : '미허용');
    }).catch(() => {});
  }
}

// ---------- 시작 ----------

async function onStart() {
  resumeAudio();
  state.started = true;
  $('start-screen').hidden = true;
  requestPersist();
  await decodeMissing();   // 시작 전에 해석하지 못한 패드가 있으면 다시 시도
}

function init() {
  buildPads();
  setupTrimHandles();
  ensureAudioContext();    // 사용자 제스처 전엔 suspended 상태로 생성된다

  $('start-btn').addEventListener('click', onStart);
  $('edit-toggle-btn').addEventListener('click', () => setEditMode(!state.editMode));
  $('clear-all-btn').addEventListener('click', clearAll);
  $('move-cancel-btn').addEventListener('click', cancelMove);
  $('menu-close-btn').addEventListener('click', closeModal);
  $('record-btn').addEventListener('click', () => {
    if (rec.recording) stopRecording();
    else startRecording();
  });
  $('record-cancel-btn').addEventListener('click', cancelRecording);

  // 모달 바깥(어두운 부분) 누르면 닫기
  for (const name of ['menu', 'record', 'trim']) {
    $(`${name}-modal`).addEventListener('click', (e) => {
      if (e.target === e.currentTarget) cancelModal();
    });
  }

  document.addEventListener('keydown', onKeyDown);
  // 어디를 눌러도 오디오 컨텍스트를 깨운다 (사파리 대비)
  document.addEventListener('pointerdown', () => { if (state.started) resumeAudio(); }, true);

  loadPads();
}

document.addEventListener('DOMContentLoaded', init);
