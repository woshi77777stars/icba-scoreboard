/* ==========================================================================
   ICBA 记分板
   - 队标：固定位置，可上传多张图并在原位轮换
   - 计时：比赛 10 分钟 / 休息 5 分钟，独立启停，按真实时间计算（刷新不跑偏）
   - 计分：双方自由加减，支持直接输入、撤销、归零
   - 数据：全部保存在本机 localStorage
   ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------- 常量 ------------------------------- */
  const KEY_STATE = 'icba.board.v1';
  const KEY_LOGOS = 'icba.logos.v1';
  const MAX_UPLOAD_EDGE = 480;
  const MAX_SCORE = 9999;
  const WARN_MS = 60 * 1000;
  const CRITICAL_MS = 10 * 1000;

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const pad2 = (n) => String(n).padStart(2, '0');
  const uid = () => 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  /* ------------------------------- 内置队标 ------------------------------- */
  function crest(label, color) {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="' + color + '" stop-opacity=".95"/>' +
      '<stop offset="1" stop-color="' + color + '" stop-opacity=".35"/>' +
      '</linearGradient></defs>' +
      '<circle cx="120" cy="120" r="105" fill="#0b121b" stroke="url(#g)" stroke-width="7"/>' +
      '<g fill="none" stroke="' + color + '" stroke-opacity=".55" stroke-width="3">' +
      '<path d="M120 30v180"/><path d="M30 120h180"/>' +
      '<path d="M58 46a108 108 0 0 0 0 148"/><path d="M182 46a108 108 0 0 1 0 148"/>' +
      '</g>' +
      '<circle cx="120" cy="120" r="60" fill="#0b121b"/>' +
      '<circle cx="120" cy="120" r="60" fill="none" stroke="' + color + '" stroke-opacity=".3" stroke-width="2"/>' +
      '<text x="120" y="124" text-anchor="middle" dominant-baseline="central" ' +
      'font-family="system-ui,-apple-system,PingFang SC,sans-serif" font-size="86" font-weight="800" fill="#ffffff">' +
      label + '</text></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  const BUILTIN_LOGOS = [
    { id: 'builtin-1', name: '队标 1', data: crest('1', '#ff5a72'), builtin: true },
    { id: 'builtin-2', name: '队标 2', data: crest('2', '#4d8dff'), builtin: true },
    { id: 'builtin-3', name: '队标 3', data: crest('3', '#ffc247'), builtin: true },
    { id: 'builtin-4', name: '队标 4', data: crest('4', '#57d9a3'), builtin: true }
  ];

  /* ------------------------------- 状态 ------------------------------- */
  function defaultState() {
    return {
      teams: [
        { name: '队伍 1', color: '#ff5a72', score: 0, logoId: 'builtin-1' },
        { name: '队伍 2', color: '#4d8dff', score: 0, logoId: 'builtin-2' }
      ],
      period: 1,
      clocks: {
        game: { duration: 10 * 60000, remaining: 10 * 60000, running: false, endAt: 0 },
        'break': { duration: 5 * 60000, remaining: 5 * 60000, running: false, endAt: 0 }
      },
      sound: true,
      locked: false
    };
  }

  function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function loadState() {
    const base = defaultState();
    let parsed = null;
    try { parsed = JSON.parse(localStorage.getItem(KEY_STATE) || 'null'); } catch (e) { parsed = null; }
    if (!parsed || typeof parsed !== 'object') return base;

    const s = Object.assign({}, base, parsed);
    s.sound = parsed.sound !== false;
    s.locked = parsed.locked === true;
    s.period = clamp(Math.round(num(parsed.period, 1)), 0, 99);

    s.teams = base.teams.map((t, i) => {
      const src = (parsed.teams && parsed.teams[i]) || {};
      return {
        name: typeof src.name === 'string' ? src.name.slice(0, 20) : t.name,
        color: /^#[0-9a-f]{6}$/i.test(src.color || '') ? src.color : t.color,
        score: clamp(Math.round(num(src.score, 0)), 0, MAX_SCORE),
        logoId: typeof src.logoId === 'string' ? src.logoId : t.logoId
      };
    });

    ['game', 'break'].forEach((key) => {
      const d = base.clocks[key];
      const src = (parsed.clocks && parsed.clocks[key]) || {};
      const duration = clamp(Math.round(num(src.duration, d.duration)), 1000, 180 * 60000);
      const c = {
        duration: duration,
        remaining: clamp(Math.round(num(src.remaining, duration)), 0, duration),
        running: src.running === true,
        endAt: num(src.endAt, 0)
      };
      if (c.running) {
        const rem = c.endAt - Date.now();
        if (rem > 0) c.remaining = Math.min(rem, duration);
        else { c.remaining = 0; c.running = false; c.endAt = 0; }
      }
      s.clocks[key] = c;
    });

    return s;
  }

  function loadUploads() {
    try {
      const arr = JSON.parse(localStorage.getItem(KEY_LOGOS) || '[]');
      if (!Array.isArray(arr)) return [];
      return arr.filter((x) => x && typeof x.id === 'string' && typeof x.data === 'string');
    } catch (e) { return []; }
  }

  const state = loadState();
  let uploads = loadUploads();
  const history = [[], []]; // 每个记分板的比分层撤销栈

  function allLogos() { return BUILTIN_LOGOS.concat(uploads); }
  function findLogo(id) { return allLogos().find((l) => l.id === id) || null; }

  let saveTimer = 0;
  function saveState() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    try { localStorage.setItem(KEY_STATE, JSON.stringify(state)); }
    catch (e) { toast('浏览器存储空间不足，改动可能无法保存'); }
  }
  function saveStateSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(saveState, 250);
  }
  function saveUploads() {
    try { localStorage.setItem(KEY_LOGOS, JSON.stringify(uploads)); }
    catch (e) { toast('图片太多，本地空间不足，请先删掉一些'); }
  }

  /* ------------------------------- 提示 ------------------------------- */
  let toastTimer = 0;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-on'), 2200);
  }

  /* ------------------------------- 声音 ------------------------------- */
  let audioCtx = null;
  function ensureAudio() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { audioCtx = new AC(); } catch (e) { return null; }
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  }
  function tone(opts) {
    if (!state.sound) return;
    const ctx = ensureAudio();
    if (!ctx) return;
    const t0 = ctx.currentTime + (opts.delay || 0);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = opts.type || 'sine';
    osc.frequency.setValueAtTime(opts.freq, t0);
    const peak = opts.gain == null ? 0.14 : opts.gain;
    const dur = opts.dur || 0.08;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }
  function horn() {
    if (!state.sound) return;
    ensureAudio();
    for (let i = 0; i < 3; i++) {
      tone({ freq: 988, dur: 0.13, gain: 0.13, type: 'square', delay: i * 0.2 });
    }
    tone({ freq: 494, dur: 0.95, gain: 0.16, type: 'sawtooth', delay: 0.62 });
    tone({ freq: 659, dur: 0.95, gain: 0.1, type: 'sine', delay: 0.62 });
  }
  function tickSound() { tone({ freq: 1320, dur: 0.05, gain: 0.05, type: 'triangle' }); }

  function flashScreen(times) {
    const el = $('#flash');
    let n = 0;
    const total = times || 3;
    (function step() {
      el.classList.add('is-on');
      setTimeout(() => {
        el.classList.remove('is-on');
        n += 1;
        if (n < total) setTimeout(step, 170);
      }, 230);
    })();
  }

  /* ------------------------------- 渲染 ------------------------------- */
  const el = {
    period: $('#periodValue'),
    flash: $('#flash'),
    toast: $('#toast'),
    gameTime: $('#gameTime'),
    breakTime: $('#breakTime'),
    gameToggle: $('#gameToggle'),
    breakToggle: $('#breakToggle'),
    clockGame: $('#clockGame'),
    clockBreak: $('#clockBreak'),
    gameSub: $('#gameSub'),
    btnSound: $('#btnSound')
  };

  function render() {
    el.period.textContent = String(state.period);

    state.teams.forEach((team, i) => {
      const panel = $('#panel' + i);
      const score = $('#score' + i);
      const nameInput = $('#nameInput' + i);
      panel.style.setProperty('--team', team.color);
      document.documentElement.style.setProperty(i === 0 ? '--t1' : '--t2', team.color);

      if (document.activeElement !== nameInput) nameInput.value = team.name;
      score.textContent = String(team.score);
      score.setAttribute('data-digits', String(String(team.score).length));
      score.setAttribute('aria-valuenow', String(team.score));

      renderLogoSlot(i);
    });

    el.gameSub.textContent = Math.round(state.clocks.game.duration / 60000) + ' 分钟';
    renderClocks();
    renderButtons();
    renderSoundBtn();
    document.body.classList.toggle('is-locked', state.locked);
  }

  function renderButtons() {
    const map = [['game', el.gameToggle], ['break', el.breakToggle]];
    map.forEach(([key, btn]) => {
      const c = state.clocks[key];
      btn.textContent = c.running ? '暂停' : (c.remaining < c.duration && c.remaining > 0 ? '继续' : '开始');
      btn.classList.toggle('is-running', c.running);
    });
  }

  function renderSoundBtn() {
    el.btnSound.setAttribute('aria-pressed', state.sound ? 'true' : 'false');
    el.btnSound.setAttribute('title', state.sound ? '提示音已开（S）' : '提示音已关（S）');
  }

  function fmtClock(ms, tenths) {
    const t = Math.max(0, ms);
    const m = Math.floor(t / 60000);
    const s = Math.floor((t % 60000) / 1000);
    let out = m + ':' + pad2(s);
    if (tenths && t < 60000) out += '.' + Math.floor((t % 1000) / 100);
    return out;
  }

  const lastText = { game: '', 'break': '' };
  const lastBeep = { game: -1, 'break': -1 };

  function renderClocks() {
    const now = Date.now();
    ['game', 'break'].forEach((key) => {
      const c = state.clocks[key];
      let rem = c.remaining;
      if (c.running) rem = Math.max(0, c.endAt - now);

      const tenths = key === 'game';
      const text = fmtClock(rem, tenths);
      const node = key === 'game' ? el.gameTime : el.breakTime;
      if (lastText[key] !== text) {
        node.textContent = text;
        lastText[key] = text;
      }

      const box = key === 'game' ? el.clockGame : el.clockBreak;
      // 短时长的计时（比如 1 分钟）不应一开始就是警告色，阈值取「60 秒」与「总时长一半」的较小值
      const warnAt = Math.min(WARN_MS, c.duration * 0.5);
      const critAt = Math.min(CRITICAL_MS, c.duration * 0.5);
      box.classList.toggle('is-running', c.running);
      box.classList.toggle('is-warn', rem <= warnAt && rem > critAt);
      box.classList.toggle('is-critical', rem <= critAt && rem > 0);
      box.classList.toggle('is-ended', rem <= 0 && c.duration > 0);
      if (key === 'break') box.classList.toggle('is-soft', c.running);

      if (c.running && rem > 0 && rem <= 5000) {
        const sec = Math.ceil(rem / 1000);
        if (sec !== lastBeep[key]) { lastBeep[key] = sec; tone({ freq: 1046, dur: 0.07, gain: 0.08, type: 'triangle' }); }
      } else if (!c.running) {
        lastBeep[key] = -1;
      }
    });
  }

  /* ------------------------------- 计时器 ------------------------------- */
  let rafId = 0;

  function ensureLoop() {
    if (rafId) return;
    rafId = requestAnimationFrame(tickLoop);
  }

  function tickLoop() {
    const now = Date.now();
    let dirty = false;
    ['game', 'break'].forEach((key) => {
      const c = state.clocks[key];
      if (!c.running) return;
      const rem = c.endAt - now;
      if (rem <= 0) {
        c.remaining = 0;
        c.running = false;
        c.endAt = 0;
        dirty = true;
        onClockEnd(key);
      } else {
        c.remaining = rem;
      }
    });
    renderClocks();
    if (dirty) { renderButtons(); saveState(); }
    if (state.clocks.game.running || state.clocks.break.running) {
      rafId = requestAnimationFrame(tickLoop);
    } else {
      rafId = 0;
    }
  }

  function onClockEnd(key) {
    horn();
    flashScreen(3);
    toast(key === 'game' ? '比赛时间到' : '休息时间到');
  }

  function startClock(key) {
    const c = state.clocks[key];
    if (c.remaining <= 0) c.remaining = c.duration;
    c.endAt = Date.now() + c.remaining;
    c.running = true;
    lastBeep[key] = -1;
    ensureAudio();
    renderButtons();
    saveState();
    ensureLoop();
  }

  function pauseClock(key) {
    const c = state.clocks[key];
    if (!c.running) return;
    c.remaining = Math.max(0, c.endAt - Date.now());
    c.running = false;
    c.endAt = 0;
    renderButtons();
    saveState();
  }

  function toggleClock(key) {
    if (state.clocks[key].running) pauseClock(key);
    else startClock(key);
  }

  function resetClock(key) {
    const c = state.clocks[key];
    c.running = false;
    c.endAt = 0;
    c.remaining = c.duration;
    lastBeep[key] = -1;
    renderButtons();
    renderClocks();
    saveState();
    toast(key === 'game' ? '比赛计时已重置' : '休息计时已重置');
  }

  function nudgeClock(key, minutes) {
    const c = state.clocks[key];
    const delta = Math.round(minutes * 60000);
    const total = clamp(c.duration + delta, 60000, 180 * 60000);
    c.duration = total;
    if (!c.running) {
      c.remaining = clamp(c.remaining + delta, 0, total);
    } else {
      c.endAt = clamp(c.endAt + delta, Date.now(), Date.now() + total);
    }
    render();
    saveState();
    toast((key === 'game' ? '比赛时间 ' : '休息时间 ') + Math.round(total / 60000) + ' 分钟');
  }

  /* ------------------------------- 计分 ------------------------------- */
  function changeScore(index, delta) {
    const team = state.teams[index];
    const next = clamp(team.score + delta, 0, MAX_SCORE);
    if (next === team.score) return;
    history[index].push(team.score);
    if (history[index].length > 60) history[index].shift();
    team.score = next;
    const node = $('#score' + index);
    node.textContent = String(next);
    node.setAttribute('data-digits', String(String(next).length));
    node.setAttribute('aria-valuenow', String(next));
    node.classList.remove('is-pop');
    void node.offsetWidth;
    node.classList.add('is-pop');
    if (delta > 0) tickSound();
    saveState();
  }

  function setScore(index, value) {
    const team = state.teams[index];
    const next = clamp(Math.round(num(value, team.score)), 0, MAX_SCORE);
    if (next === team.score) return;
    history[index].push(team.score);
    team.score = next;
    render();
    saveState();
  }

  function undoScore(index) {
    if (!history[index].length) { toast('没有可撤销的操作'); return; }
    state.teams[index].score = history[index].pop();
    render();
    saveState();
    toast('已撤销');
  }

  /* ------------------------------- 队标 ------------------------------- */
  function renderLogoSlot(index) {
    const team = state.teams[index];
    const slot = $('#logoSlot' + index);
    const img = $('#logoImg' + index);
    const ph = $('#logoPh' + index);
    const bar = $('#logoBar' + index);
    const count = $('#logoCount' + index);
    const logo = findLogo(team.logoId);
    const list = allLogos();

    if (logo) {
      if (img.getAttribute('src') !== logo.data) {
        img.src = logo.data;
        img.classList.remove('is-fresh');
        void img.offsetWidth;
        img.classList.add('is-fresh');
      }
      img.hidden = false;
      img.alt = team.name + ' 队标';
      ph.hidden = true;
      slot.classList.add('has-logo');
    } else {
      img.hidden = true;
      img.removeAttribute('src');
      ph.hidden = false;
      slot.classList.remove('has-logo');
    }

    if (list.length > 1) {
      bar.hidden = false;
      const idx = list.findIndex((l) => l.id === team.logoId);
      count.textContent = (idx >= 0 ? idx + 1 : '–') + '/' + list.length;
    } else {
      bar.hidden = true;
    }
  }

  function assignLogo(index, logoId) {
    state.teams[index].logoId = logoId;
    render();
    saveState();
    closeModals();
  }

  function cycleLogo(index, step) {
    const list = allLogos();
    if (!list.length) return;
    const cur = list.findIndex((l) => l.id === state.teams[index].logoId);
    const next = cur < 0 ? (step > 0 ? 0 : list.length - 1) : (cur + step + list.length) % list.length;
    state.teams[index].logoId = list[next].id;
    render();
    saveState();
    tone({ freq: 660, dur: 0.05, gain: 0.04, type: 'triangle' });
  }

  /* 图片上传 */
  function readImage(file) {
    return new Promise((resolve, reject) => {
      if (!file || !/^image\//.test(file.type)) { reject(new Error('不是图片文件')); return; }
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try { resolve(img); } finally { setTimeout(() => URL.revokeObjectURL(url), 0); }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('图片无法读取'));
      };
      img.src = url;
    });
  }

  async function toDataUrl(file) {
    const img = await readImage(file);
    const w0 = img.naturalWidth || img.width;
    const h0 = img.naturalHeight || img.height;
    if (!w0 || !h0) throw new Error('图片尺寸异常');
    const scale = Math.min(1, MAX_UPLOAD_EDGE / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * scale));
    const h = Math.max(1, Math.round(h0 * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    let out = canvas.toDataURL('image/webp', 0.92);
    if (out.indexOf('data:image/webp') !== 0) out = canvas.toDataURL('image/png');
    return out;
  }

  async function handleFiles(fileList, slotIndex) {
    const files = Array.from(fileList || []).filter((f) => /^image\//.test(f.type));
    if (!files.length) { toast('请选择图片文件'); return; }
    let lastId = null;
    for (const file of files) {
      try {
        const data = await toDataUrl(file);
        const item = {
          id: uid(),
          name: (file.name || '队标').replace(/\.[^.]+$/, '').slice(0, 18),
          data: data,
          builtin: false
        };
        uploads.push(item);
        lastId = item.id;
      } catch (err) {
        toast('“' + (file.name || '图片') + '”读取失败');
      }
    }
    if (lastId) {
      saveUploads();
      assignLogo(slotIndex, lastId);
      toast('已添加 ' + files.length + ' 张队标');
    }
  }

  /* ------------------------------- 弹窗 ------------------------------- */
  function openModal(id) {
    const m = $('#' + id);
    if (!m) return;
    m.hidden = false;
    document.body.classList.add('has-modal');
    const focusable = m.querySelector('input, button:not(.modal__close)');
    if (focusable) setTimeout(() => focusable.focus(), 30);
  }

  function closeModals() {
    $$('.modal').forEach((m) => { m.hidden = true; });
    document.body.classList.remove('has-modal');
    closeMenus();
  }

  function closeMenus() {
    $$('.panel__menu').forEach((m) => { m.hidden = true; });
  }

  /* 图库 */
  let librarySlot = 0;

  function openLibrary(index) {
    librarySlot = index;
    $('#libraryTitle').textContent = '队标图片 · ' + (state.teams[index].name || '队伍 ' + (index + 1));
    renderLibrary();
    openModal('modalLibrary');
  }

  function renderLibrary() {
    const grid = $('#libraryGrid');
    const current = state.teams[librarySlot].logoId;
    grid.innerHTML = '';
    allLogos().forEach((logo) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'library__item' + (logo.id === current ? ' is-current' : '');
      item.title = logo.name;

      const img = document.createElement('img');
      img.src = logo.data;
      img.alt = logo.name;
      img.loading = 'lazy';
      item.appendChild(img);

      if (logo.builtin) {
        const badge = document.createElement('span');
        badge.className = 'library__badge';
        badge.textContent = '内置';
        item.appendChild(badge);
      } else {
        const del = document.createElement('span');
        del.className = 'library__del';
        del.textContent = '✕';
        del.setAttribute('role', 'button');
        del.setAttribute('aria-label', '删除这张图片');
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          removeUpload(logo.id);
        });
        item.appendChild(del);
      }

      item.addEventListener('click', () => assignLogo(librarySlot, logo.id));
      grid.appendChild(item);
    });
  }

  function removeUpload(id) {
    uploads = uploads.filter((l) => l.id !== id);
    saveUploads();
    state.teams.forEach((t) => { if (t.logoId === id) t.logoId = null; });
    render();
    renderLibrary();
    saveState();
    toast('已删除');
  }

  /* 设置 */
  function openSettings() {
    $('#setName0').value = state.teams[0].name;
    $('#setName1').value = state.teams[1].name;
    $('#setColor0').value = state.teams[0].color;
    $('#setColor1').value = state.teams[1].color;
    $('#setGameMin').value = Math.round(state.clocks.game.duration / 60000);
    $('#setBreakMin').value = Math.round(state.clocks['break'].duration / 60000);
    $('#setSound').checked = !!state.sound;
    openModal('modalSettings');
  }

  function applySettings() {
    state.teams[0].name = $('#setName0').value.trim().slice(0, 20) || '队伍 1';
    state.teams[1].name = $('#setName1').value.trim().slice(0, 20) || '队伍 2';
    state.teams[0].color = $('#setColor0').value;
    state.teams[1].color = $('#setColor1').value;
    state.sound = $('#setSound').checked;

    const gMin = clamp(Math.round(num($('#setGameMin').value, 10)), 1, 180);
    const bMin = clamp(Math.round(num($('#setBreakMin').value, 5)), 1, 180);
    ['game', 'break'].forEach((key) => {
      const minutes = key === 'game' ? gMin : bMin;
      const c = state.clocks[key];
      const total = minutes * 60000;
      if (c.duration !== total) {
        c.duration = total;
        c.running = false;
        c.endAt = 0;
        c.remaining = total;
      }
    });

    render();
    saveState();
    closeModals();
    toast('设置已保存');
  }

  function resetAll() {
    const base = defaultState();
    state.teams = base.teams;
    state.period = base.period;
    state.clocks = base.clocks;
    state.sound = true;
    state.locked = false;
    history[0] = [];
    history[1] = [];
    uploads = [];
    try { localStorage.removeItem(KEY_LOGOS); } catch (e) { /* ignore */ }
    render();
    saveState();
    closeModals();
    toast('已恢复到初始状态');
  }

  /* 比分输入 */
  let scoreSlot = 0;

  function openScoreEditor(index) {
    scoreSlot = index;
    $('#scoreTitle').textContent = '输入比分 · ' + (state.teams[index].name || '队伍 ' + (index + 1));
    const input = $('#scoreInput');
    input.value = String(state.teams[index].score);
    openModal('modalScore');
    setTimeout(() => input.select(), 40);
  }

  /* ------------------------------- 锁定 / 全屏 ------------------------------- */
  function setLocked(value) {
    state.locked = value;
    document.body.classList.toggle('is-locked', value);
    if (!value) document.body.classList.remove('idle');
    $('#btnLock').classList.toggle('is-active', value);
    saveState();
    closeMenus();
    if (value) toast('面板已锁定 · 按 L 或点左下角解锁');
  }

  function toggleFullscreen() {
    const doc = document;
    if (!doc.fullscreenElement) {
      const target = doc.documentElement;
      const req = target.requestFullscreen || target.webkitRequestFullscreen;
      if (req) req.call(target).catch(() => toast('当前浏览器不支持全屏'));
    } else {
      const exit = doc.exitFullscreen || doc.webkitExitFullscreen;
      if (exit) exit.call(doc);
    }
  }

  let wakeLock = null;
  async function requestWakeLock() {
    try {
      if (!('wakeLock' in navigator)) return;
      if (wakeLock) return;
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) { /* 用户可能拒绝，忽略 */ }
  }

  /* 空闲隐藏鼠标（锁定模式下） */
  let idleTimer = 0;
  function bumpIdle() {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    if (!state.locked) return;
    idleTimer = setTimeout(() => document.body.classList.add('idle'), 2800);
  }

  /* ------------------------------- 事件 ------------------------------- */
  function handleAction(act, node, event) {
    switch (act) {
      case 'period-up': state.period = clamp(state.period + 1, 0, 99); render(); saveState(); break;
      case 'period-down': state.period = clamp(state.period - 1, 0, 99); render(); saveState(); break;

      case 'score': {
        const i = Number(node.dataset.team);
        changeScore(i, Number(node.dataset.delta));
        break;
      }
      case 'edit-score': {
        if (event && event.detail < 2) return;
        openScoreEditor(Number(node.dataset.team));
        break;
      }
      case 'apply-score': {
        setScore(scoreSlot, $('#scoreInput').value);
        closeModals();
        break;
      }
      case 'undo': undoScore(Number(node.dataset.team)); closeMenus(); break;
      case 'reset-score': {
        const i = Number(node.dataset.team);
        history[i].push(state.teams[i].score);
        state.teams[i].score = 0;
        render();
        saveState();
        closeMenus();
        toast('比分已归零');
        break;
      }
      case 'pick-logo': openLibrary(Number(node.dataset.team)); closeMenus(); break;

      case 'menu': {
        const i = Number(node.dataset.team);
        const menu = $('#menu' + i);
        const willOpen = menu.hidden;
        closeMenus();
        menu.hidden = !willOpen;
        break;
      }

      case 'game-toggle': toggleClock('game'); ensureLoop(); break;
      case 'break-toggle': toggleClock('break'); ensureLoop(); break;
      case 'game-reset': resetClock('game'); break;
      case 'break-reset': resetClock('break'); break;
      case 'game-plus': nudgeClock('game', 1); break;
      case 'game-minus': nudgeClock('game', -1); break;
      case 'break-plus': nudgeClock('break', 1); break;
      case 'break-minus': nudgeClock('break', -1); break;

      case 'logo-prev': cycleLogo(Number(node.dataset.slot), -1); break;
      case 'logo-next': cycleLogo(Number(node.dataset.slot), 1); break;

      case 'sound':
        state.sound = !state.sound;
        renderSoundBtn();
        saveState();
        if (state.sound) { ensureAudio(); tone({ freq: 880, dur: 0.08, gain: 0.1 }); }
        toast(state.sound ? '提示音已开启' : '提示音已关闭');
        break;
      case 'lock': setLocked(!state.locked); break;
      case 'fullscreen': toggleFullscreen(); break;
      case 'settings': openSettings(); break;
      case 'help': openModal('modalHelp'); break;
      case 'close-modal': closeModals(); break;
      case 'save-settings': applySettings(); break;
      case 'reset-all': {
        if (node.dataset.armed === '1') { resetAll(); break; }
        node.dataset.armed = '1';
        node.textContent = '再点一次确认';
        setTimeout(() => { if (node.dataset.armed === '1') { node.dataset.armed = '0'; node.textContent = '恢复初始状态'; } }, 3000);
        break;
      }
      default: break;
    }
  }

  document.addEventListener('click', (e) => {
    const node = e.target.closest('[data-act]');
    if (!node) { closeMenus(); return; }
    handleAction(node.dataset.act, node, e);
  });

  /* 记分板分数：双击直接输入 */
  $$('.panel__score').forEach((node) => {
    node.addEventListener('dblclick', () => openScoreEditor(Number(node.dataset.team)));
  });

  /* 队标位：点击打开图库 */
  $$('.logo-slot').forEach((slot) => {
    const index = Number(slot.dataset.slot);
    slot.addEventListener('click', (e) => {
      if (state.locked) return;
      if (e.target.closest('[data-act]')) return;
      openLibrary(index);
    });
    slot.addEventListener('keydown', (e) => {
      if (state.locked) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLibrary(index); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); cycleLogo(index, -1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); cycleLogo(index, 1); }
    });
    slot.addEventListener('dragover', (e) => { e.preventDefault(); slot.classList.add('is-drag'); });
    slot.addEventListener('dragleave', () => slot.classList.remove('is-drag'));
    slot.addEventListener('drop', (e) => {
      e.preventDefault();
      slot.classList.remove('is-drag');
      if (state.locked) return;
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files, index);
    });
  });

  /* 队伍名 */
  state.teams.forEach((team, i) => {
    $('#nameInput' + i).addEventListener('input', (e) => {
      state.teams[i].name = e.target.value.slice(0, 20);
      saveStateSoon();
    });
    $('#nameInput' + i).addEventListener('change', (e) => {
      if (!e.target.value.trim()) {
        state.teams[i].name = '队伍 ' + (i + 1);
        e.target.value = state.teams[i].name;
      }
      saveState();
    });
  });

  /* 图库上传 */
  const dropzone = $('#dropzone');
  const fileInput = $('#fileInput');
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('is-drag'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-drag'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('is-drag');
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      handleFiles(e.dataTransfer.files, librarySlot);
    }
  });
  fileInput.addEventListener('change', (e) => {
    handleFiles(e.target.files, librarySlot);
    fileInput.value = '';
  });

  /* 键盘 */
  document.addEventListener('keydown', (e) => {
    const openModalEl = $('.modal:not([hidden])');
    if (e.key === 'Escape') {
      if (openModalEl) { closeModals(); return; }
      if (state.locked) { setLocked(false); return; }
      closeMenus();
      return;
    }
    if (openModalEl) {
      if (e.key === 'Enter' && openModalEl.id === 'modalScore') {
        e.preventDefault();
        setScore(scoreSlot, $('#scoreInput').value);
        closeModals();
      }
      return;
    }

    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;

    const shift = e.shiftKey;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        toggleClock('game');
        ensureLoop();
        break;
      case 'Enter':
        e.preventDefault();
        toggleClock('break');
        ensureLoop();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        changeScore(0, shift ? -1 : 1);
        break;
      case 'ArrowRight':
        e.preventDefault();
        changeScore(1, shift ? -1 : 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        state.period = clamp(state.period + 1, 0, 99);
        render();
        saveState();
        break;
      case 'ArrowDown':
        e.preventDefault();
        state.period = clamp(state.period - 1, 0, 99);
        render();
        saveState();
        break;
      case '[':
        e.preventDefault();
        cycleLogo(0, -1);
        break;
      case ']':
        e.preventDefault();
        cycleLogo(1, 1);
        break;
      default: {
        const k = e.key.toLowerCase();
        if (k === 'r') {
          resetClock(shift ? 'break' : 'game');
        } else if (k === 'l') {
          setLocked(!state.locked);
        } else if (k === 'f') {
          toggleFullscreen();
        } else if (k === 's') {
          handleAction('sound', el.btnSound, e);
        } else if (k === 'p') {
          openSettings();
        } else if (k === '?') {
          openModal('modalHelp');
        }
      }
    }
  });

  /* 全屏 / 唤醒锁 / 空闲 */
  document.addEventListener('fullscreenchange', () => {
    const on = !!document.fullscreenElement;
    $('[data-act="fullscreen"]').classList.toggle('is-active', on);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { requestWakeLock(); renderClocks(); }
  });
  ['pointerdown', 'keydown'].forEach((type) => {
    document.addEventListener(type, function once() {
      ensureAudio();
      requestWakeLock();
      document.removeEventListener(type, once);
    }, { once: true });
  });
  document.addEventListener('mousemove', bumpIdle, { passive: true });
  document.addEventListener('pointerdown', bumpIdle, { passive: true });
  window.addEventListener('beforeunload', saveState);

  /* ------------------------------- 启动 ------------------------------- */
  render();
  renderButtons();
  $('#btnLock').classList.toggle('is-active', state.locked);
  if (state.locked) bumpIdle();
  if (state.clocks.game.running || state.clocks['break'].running) ensureLoop();

  if (!localStorage.getItem(KEY_STATE)) {
    setTimeout(() => toast('按 F 全屏 · L 锁定大屏 · ? 查看快捷键'), 700);
  }
})();
