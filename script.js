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
};

const $ = (id) => document.getElementById(id);
const padEls = [];

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

// ---------- 시작 ----------

function init() {
  buildPads();
}

document.addEventListener('DOMContentLoaded', init);
