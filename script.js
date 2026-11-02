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
  cancelled: false,
};

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

// 2-1 단계: 마이크 권한만 확인한다. 실제 녹음은 2-2 에서.
async function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setRecordUI('idle', '이 브라우저에서는 마이크를 쓸 수 없습니다. HTTPS 주소(또는 localhost)로 열어야 합니다.', true);
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
  rec.stream = stream;
  setRecordUI('idle', '마이크가 열렸습니다. (녹음은 다음 단계에서 붙입니다)', false);
  releaseStream();
}

function releaseStream() {
  if (rec.stream) rec.stream.getTracks().forEach((t) => t.stop());
  rec.stream = null;
}

function cancelRecording() {
  rec.cancelled = true;
  releaseStream();
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
  $('record-btn').addEventListener('click', startRecording);
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
