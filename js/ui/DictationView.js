/**
 * 默写模式：逐句听写、单句音频、对照原文校对
 * @module ui/DictationView
 */

import { delegate, setHTML } from '../utils/dom.js';
import { escapeHtml } from '../utils/escape.js';
import { getStorage, setStorage } from '../utils/storage.js';

const SAVE_DELAY = 400;

const PLAY_ICON = '<svg viewBox="0 0 20 20" width="15" height="15" fill="currentColor" aria-hidden="true">'
  + '<path d="M7 4.5v11l9-5.5-9-5.5Z"/></svg>';

const CHECK_ICON = '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">'
  + '<path d="M4.5 10.5l3.6 3.6 7.4-8" stroke="currentColor" stroke-width="2" '
  + 'stroke-linecap="round" stroke-linejoin="round"/></svg>';

const RESET_ICON = '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" aria-hidden="true">'
  + '<path d="M6.5 7.5H11a4.5 4.5 0 0 1 0 9H8.5" stroke="currentColor" stroke-width="1.8" '
  + 'stroke-linecap="round" stroke-linejoin="round"/>'
  + '<path d="M9 4.5L6 7.5l3 3" stroke="currentColor" stroke-width="1.8" '
  + 'stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * 按单词切分用于比对：标点一律不参与判定，只比单词序列。
 * 引号直接删除（避免 don't → don t 被拆开），其余标点当作分隔符。
 * @param {string} text
 * @returns {Array<{raw: string, key: string}>}
 */
function tokenize(text) {
  return String(text || '')
    .replace(/['’‘`´"“”]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((raw) => ({ raw, key: raw.toLowerCase() }));
}

/**
 * 词级差异：以原文为基准，多出的词记为 extra
 * @param {Array<{raw: string, key: string}>} expected
 * @param {Array<{raw: string, key: string}>} actual
 * @returns {Array<{type: 'equal'|'missing'|'extra', raw: string}>}
 */
function diffTokens(expected, actual) {
  const n = expected.length;
  const m = actual.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = expected[i].key === actual[j].key
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;

  while (i < n && j < m) {
    if (expected[i].key === actual[j].key) {
      ops.push({ type: 'equal', raw: expected[i].raw });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'missing', raw: expected[i].raw });
      i += 1;
    } else {
      ops.push({ type: 'extra', raw: actual[j].raw });
      j += 1;
    }
  }

  while (i < n) {
    ops.push({ type: 'missing', raw: expected[i].raw });
    i += 1;
  }
  while (j < m) {
    ops.push({ type: 'extra', raw: actual[j].raw });
    j += 1;
  }

  return ops;
}

export class DictationView {
  /**
   * @param {Object} options
   * @param {HTMLElement} options.display
   * @param {HTMLAudioElement} [options.audio] 主播放器，用于切句播放
   * @param {() => {bookKey: string, unitIndex: number}} [options.getContext]
   * @param {(message: string, options?: Object) => void} [options.onToast]
   */
  constructor(options) {
    this.display = options.display;
    this.audio = options.audio;
    this.getContext = options.getContext || (() => ({ bookKey: '', unitIndex: -1 }));
    this.onToast = options.onToast;

    this.lyrics = [];
    this.rows = [];
    this.countEl = null;
    this.visible = false;

    this.clipEnd = null;
    this.clipIndex = -1;
    this.clipToken = 0;
    this.raf = 0;
    this.saveTimer = 0;
    this.abort = new AbortController();

    this.#bind();
  }

  /**
   * @param {boolean} show
   */
  setVisible(show) {
    this.visible = Boolean(show);
    if (!this.display) return;
    this.display.hidden = !this.visible;
    if (!this.visible) this.stopClip();
  }

  /**
   * @param {Array<{time: number, english: string}>} lyrics
   */
  setLyrics(lyrics) {
    this.lyrics = Array.isArray(lyrics) ? lyrics : [];
    this.stopClip();
    this.#render();
    this.#loadDraft();
  }

  /**
   * @param {string} message
   */
  setEmpty(message) {
    this.lyrics = [];
    this.rows = [];
    this.countEl = null;
    this.stopClip();
    if (!this.display) return;
    setHTML(this.display, `<p class="placeholder">${escapeHtml(message)}</p>`);
  }

  /** 逐行比对原文并标出对错（检查全部） */
  check() {
    if (!this.lyrics.length || !this.rows.length) return;

    let correct = 0;
    this.rows.forEach((_, index) => {
      if (this.#checkRow(index)) correct += 1;
    });

    this.#refreshCount();
    this.#scheduleSave();

    if (this.onToast) {
      const total = this.lyrics.length;
      this.onToast(`答对 ${correct} / ${total} 句`, {
        type: correct === total ? 'success' : 'info',
      });
    }
  }

  /**
   * 只检查某一句，适合写完一句就核对
   * @param {number} index
   */
  checkOne(index) {
    if (!this.rows[index]) return;
    const isCorrect = this.#checkRow(index);
    this.#refreshCount();
    this.#scheduleSave();
    return isCorrect;
  }

  /** 清空本次默写（全部） */
  reset() {
    this.stopClip();
    this.rows.forEach((row) => {
      row.input.value = '';
      row.answer.hidden = true;
      row.answer.innerHTML = '';
      row.el.classList.remove('correct', 'wrong');
      row.resetBtn.hidden = true;
    });
    this.#refreshCount();
    this.#scheduleSave(true);
    this.rows[0]?.input.focus({ preventScroll: true });
  }

  /**
   * 只清空某一句，其他行原样保留
   * @param {number} index
   */
  resetRow(index) {
    const row = this.rows[index];
    if (!row) return;

    if (this.clipIndex === index) this.stopClip();

    row.input.value = '';
    row.answer.hidden = true;
    row.answer.innerHTML = '';
    row.el.classList.remove('correct', 'wrong');
    row.resetBtn.hidden = true;

    this.#refreshCount();
    this.#scheduleSave();
    row.input.focus({ preventScroll: true });
  }

  /** 停止当前正在播放的单句音频 */
  stopClip() {
    this.clipToken += 1;
    const wasPlaying = this.clipEnd !== null;
    this.clipEnd = null;
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    if (this.clipIndex >= 0) this.#markPlaying(-1);
    this.clipIndex = -1;
    if (wasPlaying && this.audio) this.audio.pause();
  }

  destroy() {
    this.abort.abort();
    clearTimeout(this.saveTimer);
    if (this.raf) cancelAnimationFrame(this.raf);
  }

  #bind() {
    if (!this.display) return;
    const { signal } = this.abort;

    delegate(this.display, 'click', '.dictation-play', (event) => {
      const btn = event.target.closest('.dictation-play');
      if (!btn) return;
      const index = parseInt(btn.dataset.play, 10);
      if (Number.isFinite(index)) this.#playClip(index);
    }, { signal });

    delegate(this.display, 'click', '.dictation-action', (event) => {
      const btn = event.target.closest('.dictation-action');
      if (!btn) return;
      if (btn.dataset.action === 'check') this.check();
      if (btn.dataset.action === 'reset') this.reset();
    }, { signal });

    delegate(this.display, 'click', '.dictation-check', (event) => {
      const btn = event.target.closest('.dictation-check');
      if (!btn) return;
      const index = parseInt(btn.dataset.check, 10);
      if (Number.isFinite(index)) this.checkOne(index);
    }, { signal });

    delegate(this.display, 'click', '.dictation-row-reset', (event) => {
      const btn = event.target.closest('.dictation-row-reset');
      if (!btn) return;
      const index = parseInt(btn.dataset.resetRow, 10);
      if (Number.isFinite(index)) this.resetRow(index);
    }, { signal });

    delegate(this.display, 'input', '.dictation-input', (event) => {
      // 只撤销这一行的判定，其他行已核对的结果保持不动
      const index = parseInt(event.target.dataset.input, 10);
      const row = this.rows[index];
      if (row && (row.el.classList.contains('correct') || row.el.classList.contains('wrong'))) {
        this.#clearRow(index);
      }
      this.#scheduleSave();
    }, { signal });

    delegate(this.display, 'keydown', '.dictation-input', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();

      const index = parseInt(event.target.dataset.input, 10);

      if (event.ctrlKey || event.metaKey) {
        this.checkOne(index);
        return;
      }

      const next = this.rows[index + 1];
      if (next) next.input.focus();
    }, { signal });
  }

  #render() {
    if (!this.display) return;

    this.rows = [];
    this.countEl = null;

    if (!this.lyrics.length) {
      setHTML(this.display, '<p class="placeholder">还没有可默写的句子</p>');
      return;
    }

    const fragment = document.createDocumentFragment();

    const toolbar = document.createElement('div');
    toolbar.className = 'dictation-toolbar';

    const checkBtn = document.createElement('button');
    checkBtn.type = 'button';
    checkBtn.className = 'dictation-action primary';
    checkBtn.dataset.action = 'check';
    checkBtn.textContent = '全部检查';
    checkBtn.title = '一次核对整课所有句子';

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'dictation-action';
    resetBtn.dataset.action = 'reset';
    resetBtn.textContent = '全部重写';
    resetBtn.title = '清空所有句子';

    const count = document.createElement('span');
    count.className = 'dictation-count';
    count.textContent = `共 ${this.lyrics.length} 句`;

    toolbar.append(checkBtn, resetBtn, count);
    fragment.appendChild(toolbar);

    this.lyrics.forEach((lyric, index) => {
      fragment.appendChild(this.#createRow(lyric, index));
    });

    this.display.replaceChildren(fragment);
    this.countEl = count;
  }

  #createRow(lyric, index) {
    const row = document.createElement('div');
    row.className = 'dictation-line';
    row.dataset.index = String(index);

    const no = document.createElement('span');
    no.className = 'dictation-idx';
    no.textContent = String(index + 1);

    const playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'dictation-play';
    playBtn.dataset.play = String(index);
    playBtn.title = '播放这一句';
    playBtn.setAttribute('aria-label', `播放第 ${index + 1} 句音频`);
    playBtn.innerHTML = PLAY_ICON;

    const body = document.createElement('div');
    body.className = 'dictation-body';

    const inputRow = document.createElement('div');
    inputRow.className = 'dictation-input-row';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'dictation-input';
    input.dataset.input = String(index);
    input.placeholder = '听写这一句…';
    input.autocomplete = 'off';
    input.autocapitalize = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', `第 ${index + 1} 句听写输入`);

    const checkBtn = document.createElement('button');
    checkBtn.type = 'button';
    checkBtn.className = 'dictation-check';
    checkBtn.dataset.check = String(index);
    checkBtn.title = '只检查这一句（Ctrl+Enter）';
    checkBtn.setAttribute('aria-label', `检查第 ${index + 1} 句`);
    checkBtn.innerHTML = CHECK_ICON;

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'dictation-row-reset';
    resetBtn.dataset.resetRow = String(index);
    resetBtn.title = '清空这一句重新写';
    resetBtn.setAttribute('aria-label', `重写第 ${index + 1} 句`);
    resetBtn.innerHTML = RESET_ICON;
    resetBtn.hidden = true;

    const answer = document.createElement('div');
    answer.className = 'dictation-answer';
    answer.hidden = true;

    inputRow.append(input, checkBtn, resetBtn);
    body.append(inputRow, answer);
    row.append(no, playBtn, body);
    this.rows.push({ el: row, input, answer, playBtn, checkBtn, resetBtn });
    return row;
  }

  /**
   * 判定单行并渲染结果
   * @param {number} index
   * @returns {boolean} 是否完全正确
   */
  #checkRow(index) {
    const row = this.rows[index];
    const lyric = this.lyrics[index];
    if (!row || !lyric) return false;

    const expected = lyric.english || '';
    const typed = row.input.value;
    const ops = diffTokens(tokenize(expected), tokenize(typed));
    const isCorrect = ops.every((op) => op.type === 'equal');

    row.el.classList.toggle('correct', isCorrect);
    row.el.classList.toggle('wrong', !isCorrect);
    row.answer.hidden = false;
    row.resetBtn.hidden = false;
    // 正确或整句没写：原样展示原文（保留标点）；写过但出错：逐词标注差异
    row.answer.innerHTML = isCorrect || !typed.trim()
      ? escapeHtml(expected)
      : ops
        .map((op) => {
          if (op.type === 'equal') return escapeHtml(op.raw);
          const cls = op.type === 'missing' ? 'miss' : 'extra';
          return `<span class="${cls}">${escapeHtml(op.raw)}</span>`;
        })
        .join(' ');

    return isCorrect;
  }

  /**
   * 撤销单行的判定（改动输入后调用），不影响其他行
   * @param {number} index
   */
  #clearRow(index) {
    const row = this.rows[index];
    if (!row) return;
    row.el.classList.remove('correct', 'wrong');
    row.answer.hidden = true;
    row.answer.innerHTML = '';
    row.resetBtn.hidden = true;
    this.#refreshCount();
  }

  /** 依据已检查的行数刷新统计 */
  #refreshCount() {
    if (!this.countEl) return;

    const total = this.rows.length;
    const checked = this.rows.filter(
      (row) => row.el.classList.contains('correct') || row.el.classList.contains('wrong')
    );
    const correct = this.rows.filter((row) => row.el.classList.contains('correct')).length;

    if (!checked.length) {
      this.countEl.textContent = `共 ${total} 句`;
      return;
    }

    this.countEl.textContent = checked.length === total
      ? `正确 ${correct} / ${total}`
      : `正确 ${correct} / 已查 ${checked.length}`;
  }

  /**
   * 该句结束时间：下一句起点前留一点余量；末句用音频总时长兜底
   * @param {number} index
   */
  #endOf(index) {
    const next = this.lyrics[index + 1];
    if (next && Number.isFinite(next.time)) return next.time - 0.12;

    const duration = this.audio?.duration;
    if (Number.isFinite(duration) && duration > 0) return duration;

    return this.lyrics[index].time + 6;
  }

  #playClip(index) {
    const { audio } = this;
    const lyric = this.lyrics[index];
    if (!audio || !lyric) return;

    this.stopClip();

    const start = Math.max(0, lyric.time);
    const end = this.#endOf(index);
    const token = ++this.clipToken;

    audio.pause();
    try {
      audio.currentTime = start;
    } catch {
      return;
    }

    audio.play().then(() => {
      if (token !== this.clipToken) return;

      this.clipEnd = end;
      this.clipIndex = index;
      this.#markPlaying(index);

      const tick = () => {
        if (token !== this.clipToken || this.clipEnd === null) return;
        const time = audio.currentTime;
        if (audio.paused || time >= this.clipEnd || time < start - 0.4) {
          this.stopClip();
          return;
        }
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    }).catch(() => {
      if (token === this.clipToken) this.stopClip();
    });
  }

  #markPlaying(index) {
    this.rows.forEach((row, i) => {
      row.playBtn.classList.toggle('playing', i === index);
      row.el.classList.toggle('speaking', i === index);
    });
  }

  #storageKey() {
    const { bookKey, unitIndex } = this.getContext();
    if (!bookKey || !Number.isFinite(unitIndex) || unitIndex < 0) return '';
    return `dictation/${bookKey}/${unitIndex}`;
  }

  /**
   * 立即快照当前答案，避免切换单元后写到新单元名下
   * @param {boolean} [immediate]
   */
  #scheduleSave(immediate = false) {
    const key = this.#storageKey();
    if (!key) return;

    const answers = this.rows.map((row) => row.input.value);
    clearTimeout(this.saveTimer);

    const write = () => setStorage(key, JSON.stringify(answers));
    if (immediate) {
      write();
    } else {
      this.saveTimer = setTimeout(write, SAVE_DELAY);
    }
  }

  #loadDraft() {
    const key = this.#storageKey();
    if (!key) return;

    let answers = [];
    try {
      const raw = getStorage(key);
      answers = raw ? JSON.parse(raw) : [];
    } catch {
      answers = [];
    }
    if (!Array.isArray(answers)) return;

    this.rows.forEach((row, index) => {
      if (typeof answers[index] === 'string') row.input.value = answers[index];
    });
  }
}
