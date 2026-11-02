// 보이스 드럼패드
'use strict';

// ---------- 상수 ----------

const PAD_COUNT = 16;

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
    grid.appendChild(el);
    padEls.push(el);
  }
}

// ---------- 시작 ----------

function init() {
  buildPads();
}

document.addEventListener('DOMContentLoaded', init);
