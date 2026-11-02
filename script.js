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
  // 어디를 눌러도 오디오 컨텍스트를 깨운다 (사파리 대비)
  document.addEventListener('pointerdown', () => { if (state.started) resumeAudio(); }, true);
}

document.addEventListener('DOMContentLoaded', init);
