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

// ---------- 상태 ----------

const state = {
  // 각 칸: null 또는 { blob, buffer, start, end }
  pads: new Array(PAD_COUNT).fill(null),
  audioCtx: null,
  started: false,
  modal: null,         // 'menu' | 'record' | 'trim' | null
};

const $ = (id) => document.getElementById(id);
const padEls = [];

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
  else closeModal();
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

  // 녹음 전체를 그대로 패드에 넣는다
  const i = rec.index;
  state.pads[i] = { blob, buffer, start: 0, end: buffer.duration };
  renderPad(i);
  closeModal();
}

// ---------- 시작 ----------

async function onStart() {
  resumeAudio();
  state.started = true;
  $('start-screen').hidden = true;
}

function init() {
  buildPads();
  ensureAudioContext();    // 사용자 제스처 전엔 suspended 상태로 생성된다

  $('start-btn').addEventListener('click', onStart);
  $('record-btn').addEventListener('click', () => {
    if (rec.recording) stopRecording();
    else startRecording();
  });
  $('record-cancel-btn').addEventListener('click', cancelRecording);

  // 모달 바깥(어두운 부분) 누르면 닫기
  for (const name of ['record']) {
    $(`${name}-modal`).addEventListener('click', (e) => {
      if (e.target === e.currentTarget) cancelModal();
    });
  }
  // 어디를 눌러도 오디오 컨텍스트를 깨운다 (사파리 대비)
  document.addEventListener('pointerdown', () => { if (state.started) resumeAudio(); }, true);
}

document.addEventListener('DOMContentLoaded', init);
