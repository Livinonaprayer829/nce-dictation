/**
 * 选项面板：点按钮弹出列表，选中项高亮，选中即生效
 * @module ui/OptionsPanel
 */

import { on, qsa, toggleClass } from '../utils/dom.js';

export class OptionsPanel {
  /**
   * @param {Object} options
   * @param {HTMLElement} options.panel 面板容器
   * @param {HTMLElement} options.trigger 触发按钮
   * @param {(value: string, group?: string) => void} options.onSelect
   * @param {boolean} [options.closeOnSelect=true] 选中后是否关闭
   * @param {() => void} [options.onOpen] 打开时刷新高亮
   */
  constructor(options) {
    this.panel = options.panel;
    this.trigger = options.trigger;
    this.onSelect = options.onSelect;
    this.closeOnSelect = options.closeOnSelect !== false;
    this.onOpen = options.onOpen;
    this.abort = new AbortController();

    this.#bind();
  }

  get visible() {
    return Boolean(this.panel) && !this.panel.hidden;
  }

  show() {
    if (!this.panel || !this.trigger) return;

    this.onOpen?.();
    this.panel.hidden = false;
    this.#position();
    toggleClass(this.panel, 'is-open', true);
    this.trigger.setAttribute('aria-expanded', 'true');
  }

  hide() {
    if (!this.panel) return;
    this.panel.hidden = true;
    toggleClass(this.panel, 'is-open', false);
    this.trigger?.setAttribute('aria-expanded', 'false');
  }

  toggle() {
    if (this.visible) {
      this.hide();
    } else {
      this.show();
    }
  }

  /**
   * 更新高亮
   * @param {string|number} value
   * @param {string} [group] 只更新某个分组
   */
  sync(value, group) {
    if (!this.panel) return;

    const scope = group ? this.panel.querySelector(`[data-group="${group}"]`) : this.panel;
    if (!scope) return;

    qsa('[data-value]', scope).forEach((item) => {
      const active = item.dataset.value === String(value);
      toggleClass(item, 'active', active);
      item.setAttribute('aria-checked', active ? 'true' : 'false');
    });
  }

  destroy() {
    this.abort.abort();
    this.hide();
  }

  #bind() {
    if (!this.panel || !this.trigger) return;
    const { signal } = this.abort;

    this.trigger.setAttribute('aria-haspopup', 'true');
    this.trigger.setAttribute('aria-expanded', 'false');

    // 阻止冒泡，避免同一次点击立刻触发 document 的关闭逻辑
    on(this.trigger, 'click', (event) => {
      event.stopPropagation();
      this.toggle();
    }, { signal });

    on(this.panel, 'click', (event) => {
      const item = event.target.closest('[data-value]');
      if (!item) return;

      event.stopPropagation();
      const group = item.closest('[data-group]')?.dataset.group;
      this.onSelect?.(item.dataset.value, group);
      if (this.closeOnSelect) this.hide();
    }, { signal });

    on(document, 'click', (event) => {
      if (!this.visible) return;
      if (this.panel.contains(event.target) || this.trigger.contains(event.target)) return;
      this.hide();
    }, { signal });

    on(document, 'keydown', (event) => {
      if (event.key === 'Escape' && this.visible) this.hide();
    }, { signal });

    // 位置是 fixed 计算的，页面一滚动就会错位，直接关掉
    on(window, 'scroll', () => {
      if (this.visible) this.hide();
    }, { signal, capture: true, passive: true });

    on(window, 'resize', () => {
      if (this.visible) this.#position();
    }, { signal });
  }

  #position() {
    const { panel, trigger } = this;
    if (!panel || !trigger) return;

    const rect = trigger.getBoundingClientRect();
    const margin = 8;

    // 先量尺寸再定坐标，避免闪烁
    panel.style.visibility = 'hidden';
    panel.style.left = '0px';
    panel.style.top = '0px';

    const width = panel.offsetWidth;
    const height = panel.offsetHeight;

    let left = rect.left;
    if (left + width > window.innerWidth - margin) left = window.innerWidth - width - margin;
    if (left < margin) left = margin;

    let top = rect.bottom + margin;
    if (top + height > window.innerHeight - margin) {
      const above = rect.top - height - margin;
      top = above >= margin ? above : Math.max(margin, window.innerHeight - height - margin);
    }

    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
    panel.style.visibility = '';
  }
}
