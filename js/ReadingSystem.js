/**
 * 阅读系统协调器：课本、单元、歌词、播放与偏好
 * @module ReadingSystem
 */

import { CONFIG, createInitialState } from './config.js';
import { qs, qsa, on, setText, toggleClass } from './utils/dom.js';
import { clamp, debounce } from './utils/helpers.js';
import {
  getStorage,
  setStorage,
  getPlayTime,
  savePlayTime,
  getCurrentUnitIndex,
  saveCurrentUnitIndex,
} from './utils/storage.js';
import { LRCParser } from './utils/LRCParser.js';
import { BookService } from './services/BookService.js';
import { PrefetchService } from './services/PrefetchService.js';
import { AudioController } from './player/AudioController.js';
import { LyricsView } from './ui/LyricsView.js';
import { UnitView } from './ui/UnitView.js';
import { DictationView } from './ui/DictationView.js';
import { OptionsPanel } from './ui/OptionsPanel.js';
import { Toast } from './ui/Toast.js';

const LOOP_MODE_LABELS = {
  off: '关闭循环',
  click: '单句点读',
  one: '单句循环',
  list: '本课循环',
  book: '本书循环',
};

const TRANSLATION_LABELS = {
  show: '显示双语',
  english: '仅显示英文',
  chinese: '仅显示中文',
  blur: '模糊翻译',
};

export class ReadingSystem {
  constructor() {
    this.config = CONFIG;
    this.state = createInitialState();
    this.bookService = new BookService();
    this.prefetch = new PrefetchService({
      maxLrc: CONFIG.PLAYER.MAX_LRC_CACHE,
      maxAudio: CONFIG.PLAYER.MAX_AUDIO_CACHE,
    });

    this.bookAbort = null;
    this.unitAbort = null;
    this.unitLoadId = 0;
    this.ready = false;
    this.persistProgress = debounce(() => this.#saveProgress(), 1500);

    this.player = new AudioController({
      audio: qs('#audioPlayer'),
      playBtn: qs('#playPauseBtn'),
      progressBar: qs('#progressBar'),
      currentTimeEl: qs('#currentTime'),
      durationEl: qs('#duration'),
      onTick: (currentTime, duration) => this.#onAudioTick(currentTime, duration),
      onPersist: () => this.#saveProgress(),
      onEnded: () => this.#onAudioEnded(),
      onLoaded: () => this.toast.show('音频已加载', { type: 'success' }),
    });

    this.lyricsView = new LyricsView({
      display: qs('#lyricsDisplay'),
      container: qs('.lyrics-container'),
      scrollThreshold: CONFIG.UI.LYRIC_SCROLL_THRESHOLD,
      onActivate: (index, time) => this.#onLyricActivate(index, time),
      onRetry: () => this.#bootstrap(),
    });

    this.unitView = new UnitView({
      unitList: qs('#unitListContainer'),
      unitSelect: qs('#unitSelect'),
      bookSelects: qsa('.book-select'),
      bookCover: qs('#bookCover'),
      bookTitle: qs('#bookTitle'),
      bookHint: qs('#bookHint'),
      prevBtn: qs('#prevUnitBtn'),
      nextBtn: qs('#nextUnitBtn'),
      onUnitChange: (value) => this.#onUnitNavigate(value),
      onBookChange: (bookKey) => this.#onBookSelect(bookKey),
    });

    this.speedBtn = qs('#speedBtn');
    this.speedText = qs('#speedText');
    this.loopToggleBtn = qs('#loopToggleBtn');
    this.toggleTranslationBtn = qs('#toggleTranslationBtn');
    this.dictationBtn = qs('#dictationBtn');
    this.lyricsDisplay = qs('#lyricsDisplay');

    this.toast = new Toast();

    this.dictationPrevLoop = 'off';
    this.dictationView = new DictationView({
      display: qs('#dictationDisplay'),
      audio: qs('#audioPlayer'),
      getContext: () => ({
        bookKey: this.state.bookKey,
        unitIndex: this.state.currentUnitIndex,
      }),
      onToast: (message, options) => this.toast.show(message, options),
    });

    this.translationPanel = new OptionsPanel({
      panel: qs('#translationPanel'),
      trigger: this.toggleTranslationBtn,
      closeOnSelect: true,
      onSelect: (value) => this.#setTranslationMode(value),
      onOpen: () => {
        this.#hideOtherPanels(this.translationPanel);
        this.translationPanel.sync(this.state.translationMode);
      },
    });

    this.settingsPanel = new OptionsPanel({
      panel: qs('#settingsPanel'),
      trigger: this.loopToggleBtn,
      closeOnSelect: true,
      onSelect: (value) => this.#setLoopMode(value),
      onOpen: () => {
        this.#hideOtherPanels(this.settingsPanel);
        this.settingsPanel.sync(this.state.loopMode, 'loop');
      },
    });

    this.speedPanel = new OptionsPanel({
      panel: qs('#speedPanel'),
      trigger: this.speedBtn,
      closeOnSelect: true,
      onSelect: (value) => this.#setSpeed(parseFloat(value)),
      onOpen: () => {
        this.#hideOtherPanels(this.speedPanel);
        this.speedPanel.sync(this.state.playbackRate, 'speed');
      },
    });

    this.abort = new AbortController();
    this.#bindChrome();
    this.init();
  }

  async init() {
    await this.#bootstrap();
  }

  /** 首次加载与「重新加载」共用同一套流程 */
  async #bootstrap() {
    try {
      this.#restorePreferences();
      this.state.books = await this.bookService.loadCatalog();
      await this.applyBookFromHash();
      await this.loadUnitFromStorage();
    } catch (error) {
      if (error?.name === 'AbortError') return;
      console.error('Failed to initialize ReadingSystem:', error);
      this.#showError(this.config.ERROR_MESSAGES.LOAD_BOOKS);
    }
  }

  /**
   * 统一的错误展示：歌词区给出「重新加载」按钮
   * @param {string} message
   */
  #showError(message) {
    this.lyricsView.setEmpty(message, { retry: true });
    this.dictationView.setEmpty(message);
  }

  async applyBookFromHash() {
    const keyFromHash = location.hash.slice(1).trim();
    const storedBookKey = getStorage(this.config.STORAGE_KEYS.BOOK_SELECTION);
    const initialBookKey = keyFromHash || storedBookKey || this.config.DEFAULT_BOOK_KEY;
    await this.applyBookChange(initialBookKey);
  }

  async applyBookChange(bookKey) {
    this.bookAbort?.abort();
    this.unitAbort?.abort();
    this.unitLoadId += 1;
    this.bookAbort = new AbortController();
    const { signal } = this.bookAbort;

    if (!this.state.books.length) {
      this.state.books = await this.bookService.loadCatalog(signal);
    }

    const resolved = this.bookService.resolve(bookKey, this.config.DEFAULT_BOOK_KEY);
    const resolvedPath = resolved?.path || resolved?.bookPath;
    if (!resolvedPath) {
      this.state.bookPath = '';
      this.state.bookKey = '';
      this.state.units = [];
      this.unitView.clearUnits();
      this.unitView.setBookMeta(null);
      this.#showError(this.config.ERROR_MESSAGES.NO_DATA);
      return;
    }

    this.state.bookKey = resolved.key || bookKey;
    this.state.bookPath = resolvedPath.trim().replace(/\/$/, '');
    setStorage(this.config.STORAGE_KEYS.BOOK_SELECTION, this.state.bookKey);
    this.unitView.renderBooks(this.state.books, this.state.bookKey);
    this.unitView.setBookMeta(resolved);

    this.persistProgress.cancel();
    this.#saveProgress();
    this.ready = false;
    this.player.reset();
    this.state.currentUnitIndex = -1;
    this.state.currentLyrics = [];
    this.lyricsView.setEmpty('加载中...');
    this.dictationView.setLyrics([]);
    this.prefetch.clear();

    try {
      const { units, coverUrl, bookName, bookLevel } = await this.bookService.loadBook(resolved, signal);
      this.state.units = units;
      this.unitView.setCover(coverUrl);
      this.unitView.setBookMeta({
        ...resolved,
        bookName,
        bookLevel,
      });
      this.unitView.renderUnits(units);
      this.unitView.resetListScroll();
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      console.error(this.config.ERROR_MESSAGES.LOAD_CONFIG, error);
      this.state.units = [];
      this.unitView.clearUnits();
      this.#showError(this.config.ERROR_MESSAGES.LOAD_CONFIG);
    }
  }

  async loadUnitFromStorage() {
    if (!this.state.units.length) return;
    const unitIndex = getCurrentUnitIndex(this.state.bookKey);
    const safeIndex = clamp(unitIndex, 0, this.state.units.length - 1);
    await this.loadUnitByIndex(safeIndex, { scroll: true });
  }

  async loadUnitByIndex(unitIndex, options = {}) {
    const unit = this.state.units[unitIndex];
    if (!unit) return;
    if (unitIndex === this.state.currentUnitIndex && this.ready) return;

    this.unitAbort?.abort();
    this.unitAbort = new AbortController();
    const { signal } = this.unitAbort;
    const loadId = ++this.unitLoadId;

    this.persistProgress.cancel();
    this.#saveProgress();
    this.ready = false;
    this.state.currentUnitIndex = unitIndex;
    this.state.currentLyricIndex = -1;
    this.state.sentenceLoopIndex = -1;
    this.state.currentLyrics = [];
    saveCurrentUnitIndex(this.state.bookKey, unitIndex);

    this.player.reset();
    this.unitView.setActive(unitIndex, { scroll: options.scroll });
    this.unitView.updateNav(unitIndex, this.state.units.length);

    try {
      const lrcText = await this.prefetch.loadLrc(unit.lrc, signal);
      if (loadId !== this.unitLoadId) return;
      this.state.currentLyrics = LRCParser.parse(lrcText, this.config.PLAYER.TIME_OFFSET);
      this.lyricsView.render(this.state.currentLyrics);
      this.dictationView.setLyrics(this.state.currentLyrics);
    } catch (error) {
      if (error?.name === 'AbortError' || loadId !== this.unitLoadId) return;
      console.error(this.config.ERROR_MESSAGES.LOAD_LYRIC, error);
      this.#showError(this.config.ERROR_MESSAGES.LOAD_FAILED);
    }

    if (loadId !== this.unitLoadId) return;

    this.player.setSrc(unit.audio, {
      loop: this.state.loopMode === 'list',
      playbackRate: this.state.playbackRate,
      startTime: getPlayTime(this.state.bookKey, unitIndex),
    });
    this.ready = true;

    this.prefetch.prefetch(this.state.units[unitIndex + 1]);
  }

  destroy() {
    this.#saveProgress();
    this.bookAbort?.abort();
    this.unitAbort?.abort();
    this.abort.abort();
    this.player.destroy();
    this.lyricsView.destroy();
    this.dictationView.destroy();
    this.translationPanel?.destroy();
    this.settingsPanel?.destroy();
    this.speedPanel?.destroy();
    this.unitView.destroy();
    this.prefetch.clear();
    this.toast.destroy();
  }

  #bindChrome() {
    const { signal } = this.abort;

    on(this.dictationBtn, 'click', () => this.#toggleDictation(), { signal });

    on(window, 'hashchange', () => {
      const newKey = location.hash.slice(1).trim() || this.config.DEFAULT_BOOK_KEY;
      if (newKey === this.state.bookKey) return;
      this.applyBookChange(newKey)
        .then(() => this.loadUnitFromStorage())
        .catch((error) => {
          if (error?.name !== 'AbortError') {
            console.error('Failed to switch book:', error);
          }
        });
    }, { signal });

    on(document, 'visibilitychange', () => {
      if (document.hidden) this.#saveProgress();
    }, { signal });

    on(window, 'pagehide', () => this.#saveProgress(), { signal });
  }

  #restorePreferences() {
    const storedLoop = getStorage(this.config.STORAGE_KEYS.LOOP_MODE);
    if (this.config.LOOP_MODES.includes(storedLoop)) {
      this.state.loopMode = storedLoop;
    } else if (getStorage('loopPlaybackEnabled') === 'true') {
      this.state.loopMode = 'list';
    }

    const storedSpeed = parseFloat(getStorage(this.config.STORAGE_KEYS.PLAYBACK_RATE));
    if (this.config.AVAILABLE_SPEEDS.includes(storedSpeed)) {
      this.state.playbackRate = storedSpeed;
    }

    const storedTranslation = getStorage(this.config.STORAGE_KEYS.TRANSLATION_MODE);
    if (this.config.TRANSLATION_MODES.includes(storedTranslation)) {
      this.state.translationMode = storedTranslation;
    }

    this.player.setLoop(this.state.loopMode === 'list');
    this.player.setRate(this.state.playbackRate);
    this.#updateSpeedUI();
    this.#updateLoopUI();
    this.lyricsView.applyTranslationMode(this.state.translationMode, this.toggleTranslationBtn);
    this.translationPanel?.sync(this.state.translationMode);
    this.speedPanel?.sync(this.state.playbackRate, 'speed');
  }

  /**
   * 三个面板互斥：打开一个就关掉其余
   * @param {OptionsPanel} except
   */
  #hideOtherPanels(except) {
    [this.translationPanel, this.settingsPanel, this.speedPanel].forEach((panel) => {
      if (panel && panel !== except) panel.hide();
    });
  }

  #onBookSelect(bookKey) {
    if (!bookKey || location.hash.slice(1) === bookKey) return;
    location.hash = bookKey;
  }

  #onUnitNavigate(value) {
    if (value === 'prev') {
      if (this.state.currentUnitIndex > 0) {
        this.loadUnitByIndex(this.state.currentUnitIndex - 1);
      }
      return;
    }
    if (value === 'next') {
      if (this.state.currentUnitIndex < this.state.units.length - 1) {
        this.loadUnitByIndex(this.state.currentUnitIndex + 1);
      }
      return;
    }
    if (Number.isFinite(value) && value >= 0) {
      this.loadUnitByIndex(value);
    }
  }

  #onLyricActivate(index, time) {
    if (this.state.loopMode === 'one' || this.state.loopMode === 'click') {
      this.state.sentenceLoopIndex = index;
    }
    this.#setHighlight(index);
    this.player.seek(time);
    this.player.play();
    this.#saveProgress(time);
  }

  #onAudioTick(currentTime, duration) {
    if (!this.ready) return;
    this.#handleSentence(currentTime, duration);
    this.#syncHighlight();
    this.persistProgress();
  }

  #lockedSentenceIndex() {
    if (this.state.loopMode !== 'click' && this.state.loopMode !== 'one') return -1;
    return this.state.sentenceLoopIndex;
  }

  #setHighlight(index) {
    if (index === this.state.currentLyricIndex) return;
    this.lyricsView.highlight(index);
    this.state.currentLyricIndex = index;
  }

  #syncHighlight() {
    const locked = this.#lockedSentenceIndex();
    const index = locked >= 0
      ? locked
      : LRCParser.findLyricIndexByTime(this.state.currentLyrics, this.player.currentTime);
    this.#setHighlight(index);
  }

  #handleSentence(currentTime, duration) {
    const locked = this.#lockedSentenceIndex();
    if (locked < 0 || !Number.isFinite(currentTime)) return;

    const boundaries = LRCParser.getSentenceBoundaries(
      this.state.currentLyrics,
      locked,
      duration
    );
    if (!boundaries || !Number.isFinite(boundaries.startTime)) return;

    const endTime = boundaries.endTime;
    if (currentTime < endTime) return;

    this.player.seek(boundaries.startTime);
    if (this.state.loopMode === 'click') {
      this.player.pause();
    }
    this.#setHighlight(locked);
  }

  #setSpeed(rate) {
    if (!this.config.AVAILABLE_SPEEDS.includes(rate)) return;

    this.state.playbackRate = rate;
    this.player.setRate(rate);
    setStorage(this.config.STORAGE_KEYS.PLAYBACK_RATE, rate);
    this.#updateSpeedUI();
    this.speedPanel?.sync(rate, 'speed');
    this.toast.show(`播放速度 ${rate}x`);
  }

  #updateSpeedUI() {
    setText(this.speedText, `${this.state.playbackRate}x`);
    toggleClass(this.speedBtn, 'active', this.state.playbackRate !== 1.0);
  }

  #onAudioEnded() {
    this.#saveProgress();
    if (!this.state.units.length) return;

    if (this.state.loopMode === 'book') {
      const nextIndex = (this.state.currentUnitIndex + 1) % this.state.units.length;
      this.loadUnitByIndex(nextIndex).then(() => {
        this.player.play();
      });
    }
  }

  #setLoopMode(nextMode) {
    if (!this.config.LOOP_MODES.includes(nextMode)) return;

    this.state.loopMode = nextMode;

    if ((nextMode === 'one' || nextMode === 'click') && this.state.currentLyricIndex >= 0) {
      this.state.sentenceLoopIndex = this.state.currentLyricIndex;
    }
    if (nextMode === 'list' || nextMode === 'off' || nextMode === 'book') {
      this.state.sentenceLoopIndex = -1;
    }

    setStorage(this.config.STORAGE_KEYS.LOOP_MODE, nextMode);
    this.player.setLoop(nextMode === 'list');
    this.#updateLoopUI();
    this.#syncHighlight();
    this.toast.show(LOOP_MODE_LABELS[nextMode]);
  }

  #updateLoopUI() {
    if (!this.loopToggleBtn) return;

    const mode = this.state.loopMode;
    const isClick = mode === 'click';
    const isOne = mode === 'one';
    const isList = mode === 'list';
    const isBook = mode === 'book';

    this.loopToggleBtn.setAttribute('aria-pressed', mode !== 'off' ? 'true' : 'false');
    toggleClass(this.loopToggleBtn, 'list', isList);
    toggleClass(this.loopToggleBtn, 'click', isClick);
    toggleClass(this.loopToggleBtn, 'one', isOne);
    toggleClass(this.loopToggleBtn, 'book', isBook);

    const label = LOOP_MODE_LABELS[mode] || '循环播放';
    this.loopToggleBtn.title = label;
    this.loopToggleBtn.setAttribute('aria-label', label);

    this.settingsPanel?.sync(mode, 'loop');
  }

  #setTranslationMode(mode) {
    if (!this.config.TRANSLATION_MODES.includes(mode)) return;

    this.state.translationMode = mode;
    setStorage(this.config.STORAGE_KEYS.TRANSLATION_MODE, mode);
    this.lyricsView.applyTranslationMode(mode, this.toggleTranslationBtn);
    this.translationPanel.sync(mode);
    this.toast.show(TRANSLATION_LABELS[mode]);
  }

  #toggleDictation() {
    const show = !this.dictationView.visible;

    this.dictationView.setVisible(show);
    toggleClass(this.dictationBtn, 'active', show);
    this.dictationBtn?.setAttribute('aria-pressed', show ? 'true' : 'false');
    if (this.lyricsDisplay) this.lyricsDisplay.hidden = show;

    if (show) {
      // 单句播放由默写视图控制，先关掉循环避免与整课播放互相拉扯
      this.player.pause();
      this.dictationPrevLoop = this.state.loopMode;
      this.state.loopMode = 'off';
      this.player.setLoop(false);
      this.#updateLoopUI();
      this.toast.show('默写模式：点每行左侧圆钮听这一句');
      return;
    }

    this.dictationView.stopClip();
    const prev = this.dictationPrevLoop || 'off';
    this.state.loopMode = prev;
    this.player.setLoop(prev === 'list');
    this.#updateLoopUI();
  }

  #saveProgress(time = this.player.currentTime) {
    if (!this.ready) return;
    if (!this.state.bookKey || this.state.currentUnitIndex < 0) return;
    if (!Number.isFinite(time) || time < 0) return;
    savePlayTime(this.state.bookKey, this.state.currentUnitIndex, time);
  }
}
