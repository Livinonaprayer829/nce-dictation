/**
 * 全局常量
 * @module config
 */

export const CONFIG = {
  DEFAULT_BOOK_KEY: 'YL5A',

  STORAGE_KEYS: {
    BOOK_SELECTION: 'selectedBookKey',
    LOOP_MODE: 'loopMode',
    PLAYBACK_RATE: 'playbackRate',
    TRANSLATION_MODE: 'translationMode',
    THEME: 'theme',
  },

  AVAILABLE_SPEEDS: [0.5, 0.75, 1.0, 1.25, 1.5, 2.0],
  TRANSLATION_MODES: ['show', 'english', 'chinese', 'blur'],
  LOOP_MODES: ['off', 'click', 'one', 'list', 'book'],

  PLAYER: {
    MAX_AUDIO_CACHE: 3,
    MAX_LRC_CACHE: 3,
    TIME_OFFSET: 0.3,
  },

  UI: {
    LYRIC_SCROLL_THRESHOLD: 0.1,
    THEME_ANIMATION_DURATION: 300,
    MODAL_ANIMATION_DURATION: 200,
  },

  ERROR_MESSAGES: {
    LOAD_BOOKS: '课本列表加载失败，请检查网络后点下方重试',
    LOAD_CONFIG: '课件加载失败。若反复失败，请先在浏览器打开 nce.mleo.site 通过验证，再点下方重试',
    LOAD_LYRIC: '加载歌词失败',
    NO_DATA: '未找到可用课本数据',
    LOAD_FAILED: '加载失败',
  },
};

export function createInitialState() {
  return {
    books: [],
    units: [],
    bookPath: '',
    bookKey: '',
    currentLyrics: [],
    currentLyricIndex: -1,
    currentUnitIndex: -1,
    loopMode: 'off',
    playbackRate: 1.0,
    translationMode: 'show',
    sentenceLoopIndex: -1,
  };
}
