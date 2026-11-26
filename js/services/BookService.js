/**
 * 课本目录与课件配置加载
 * 网络抖动时自动重试，仍失败则回退到上次成功缓存的副本
 * @module services/BookService
 */

import { getStorage, setStorage } from '../utils/storage.js';

const RETRY_DELAYS = [400, 900];

export class BookService {
  /**
   * @param {string} [catalogUrl='data.json']
   */
  constructor(catalogUrl = 'data.json') {
    this.catalogUrl = catalogUrl;
    this.books = [];
  }

  /**
   * @param {AbortSignal} [signal]
   * @returns {Promise<Array>}
   */
  async loadCatalog(signal) {
    const cacheKey = `nce:catalog:${this.catalogUrl}`;
    const cached = this.#readCache(cacheKey);

    let data;
    try {
      data = await this.#fetchJson(this.catalogUrl, signal);
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      const cachedBooks = Array.isArray(cached?.books) ? cached.books : [];
      if (cachedBooks.length) {
        console.warn('课本清单加载失败，使用本地缓存副本', error);
        this.books = cachedBooks;
        return this.books;
      }
      throw error;
    }

    const books = Array.isArray(data?.books) ? data.books : [];
    this.books = books;
    if (books.length) this.#writeCache(cacheKey, { books });
    return this.books;
  }

  /**
   * @param {string} bookKey
   * @param {string} defaultKey
   * @returns {Object|null}
   */
  resolve(bookKey, defaultKey) {
    if (!this.books.length) return null;

    const getPath = (book) => book?.path || '';

    const exact = this.books.find((book) => book?.key === bookKey && getPath(book));
    if (exact) return exact;

    const fallback = this.books.find((book) => book?.key === defaultKey && getPath(book));
    if (fallback) return fallback;

    return this.books.find((book) => getPath(book)) || null;
  }

  /**
   * @param {{key?: string, path?: string, bookPath?: string}} book
   * @param {AbortSignal} [signal]
   * @returns {Promise<{units: Array, coverUrl: string, bookName: string, bookLevel: string}>}
   */
  async loadBook(book, signal) {
    const rawPath = book.path || '';
    const bookPath = rawPath.trim().replace(/\/$/, '');
    const url = `${bookPath}/book.json`;
    const cacheKey = `nce:book:${url}`;
    const cached = this.#readCache(cacheKey);

    let data;
    try {
      data = await this.#fetchJson(url, signal);
      if (Array.isArray(data?.units)) this.#writeCache(cacheKey, data);
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      if (Array.isArray(cached?.units)) {
        console.warn('课件配置加载失败，使用本地缓存副本', error);
        data = cached;
      } else {
        throw error;
      }
    }

    const units = (Array.isArray(data?.units) ? data.units : [])
      .filter((unit) => unit?.filename)
      .map((unit, index) => ({
        ...unit,
        id: index + 1,
        title: unit.title || `Unit ${index + 1}`,
        audio: `${bookPath}/${unit.filename}.mp3`,
        lrc: `${bookPath}/${unit.filename}.lrc`,
      }));

    return {
      units,
      coverUrl: data?.cover ? `${bookPath}/${data.cover}` : '',
      bookName: data?.name || book.title || '',
      bookLevel: data?.level || book.key || '',
    };
  }

  /**
   * 带退避重试的 JSON 请求
   * @param {string} url
   * @param {AbortSignal} [signal]
   */
  async #fetchJson(url, signal) {
    let lastError;

    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt += 1) {
      try {
        const response = await fetch(url, { signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        lastError = error;
        if (attempt < RETRY_DELAYS.length) {
          await this.#delay(RETRY_DELAYS[attempt], signal);
        }
      }
    }

    throw lastError;
  }

  #delay(ms, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });
  }

  #readCache(key) {
    try {
      const raw = getStorage(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  #writeCache(key, value) {
    try {
      setStorage(key, JSON.stringify(value));
    } catch {
      // 缓存失败不影响主流程
    }
  }
}
