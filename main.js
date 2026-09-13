'use strict';

const { Plugin, Modal, Notice, TFile, setIcon } = require('obsidian');

const PANEL_CLASS = 'native-search-replace-panel';
const FILE_BUTTON_CLASS = 'native-search-replace-file-button';
const MATCH_BUTTON_CLASS = 'native-search-replace-match-button';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeWhitespace(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function parseRegexLiteral(value) {
  const q = value.trim();
  if (!q.startsWith('/')) return null;
  const match = q.match(/^\/(.*)\/([gimsuy]*)$/);
  if (!match) return null;
  try {
    // Validate now so malformed patterns do not become a replacement target.
    // Global/case flags are normalized later when the actual matcher is built.
    new RegExp(match[1], match[2]);
    return { source: match[1], flags: match[2] };
  } catch (_) {
    return null;
  }
}

function parseQuotedLiteral(value) {
  const q = value.trim();
  if (q.length < 2 || q[0] !== '"' || q[q.length - 1] !== '"') return null;
  const inner = q.slice(1, -1);
  let out = '';
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === '\\' && i + 1 < inner.length) {
      const next = inner[i + 1];
      if (next === '"' || next === '\\') {
        out += next;
        i += 1;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/**
 * Infer a single concrete text target only when the native query has one
 * unambiguous replaceable operand. Everything else falls back to an explicit
 * Find target row rather than pretending we understand Obsidian's query DSL.
 */
function inferTargetFromNativeQuery(query) {
  let q = (query || '').trim();
  if (!q) return null;

  let forcedCase = null;
  const casePrefix = q.match(/^(match-case|ignore-case):/i);
  if (casePrefix) {
    forcedCase = casePrefix[1].toLowerCase() === 'match-case';
    q = q.slice(casePrefix[0].length).trim();
  }

  // content: with exactly one operand is safe: native Search still chooses the
  // files, while replacement applies to the same concrete content target.
  const contentPrefix = q.match(/^content:/i);
  if (contentPrefix) q = q.slice(contentPrefix[0].length).trim();

  const quoted = parseQuotedLiteral(q);
  if (quoted != null) {
    return { target: quoted, regex: false, flags: '', forcedCase };
  }

  const regex = parseRegexLiteral(q);
  if (regex) {
    return { target: regex.source, regex: true, flags: regex.flags, forcedCase };
  }

  // A single bare token is safe. Colons/operators/whitespace make it DSL-like.
  if (/\s/.test(q) || /[()]/.test(q) || /\b(?:OR|AND)\b/i.test(q) || q.includes(':')) {
    return null;
  }
  if (/^["']/.test(q)) return null;

  return { target: q, regex: false, flags: '', forcedCase };
}

function createMatcher(target, options) {
  if (!target) throw new Error('Find target is empty.');
  if (options.regex) {
    const flags = new Set((options.flags || '').replace(/[gi]/g, '').split('').filter(Boolean));
    flags.add('g');
    if (!options.caseSensitive) flags.add('i');
    return new RegExp(target, Array.from(flags).join(''));
  }
  return new RegExp(escapeRegExp(target), options.caseSensitive ? 'g' : 'gi');
}

function countMatches(text, regex) {
  const re = new RegExp(regex.source, regex.flags);
  let count = 0;
  let match;
  while ((match = re.exec(text)) !== null) {
    count += 1;
    if (match[0].length === 0) re.lastIndex += 1;
  }
  return count;
}

function replaceAllText(text, regex, replacement, regexMode) {
  const re = new RegExp(regex.source, regex.flags);
  return regexMode ? text.replace(re, replacement) : text.replace(re, () => replacement);
}

function replaceFirstText(text, regex, replacement, regexMode) {
  const flags = regex.flags.replace(/g/g, '');
  const re = new RegExp(regex.source, flags);
  return regexMode ? text.replace(re, replacement) : text.replace(re, () => replacement);
}

class ReplacePreviewModal extends Modal {
  constructor(app, summary, plans, onConfirm) {
    super(app);
    this.summary = summary;
    this.plans = plans;
    this.onConfirm = onConfirm;
  }

  onOpen() {
    this.titleEl.setText('Replace preview');
    const content = this.contentEl;
    content.empty();

    content.createDiv({
      cls: 'native-search-replace-summary',
      text: `${this.summary.matches} occurrence${this.summary.matches === 1 ? '' : 's'} in ${this.summary.files} file${this.summary.files === 1 ? '' : 's'} will be replaced.`
    });

    for (const plan of this.plans.slice(0, 50)) {
      const fileEl = content.createDiv({ cls: 'native-search-replace-preview-file' });
      fileEl.createEl('h4', { text: `${plan.file.path}  ·  ${plan.count}` });
      const snippets = plan.snippets.slice(0, 4);
      for (const snippet of snippets) {
        const box = fileEl.createDiv({ cls: 'native-search-replace-preview-snippet' });
        box.createDiv({ cls: 'native-search-replace-preview-before', text: `− ${snippet.before}` });
        box.createDiv({ cls: 'native-search-replace-preview-after', text: `+ ${snippet.after}` });
      }
      if (plan.snippets.length > snippets.length) {
        fileEl.createDiv({ cls: 'native-search-replace-hint', text: `…and ${plan.snippets.length - snippets.length} more changed line(s)` });
      }
    }

    if (this.plans.length > 50) {
      content.createDiv({ cls: 'native-search-replace-hint', text: `Preview limited to the first 50 files. ${this.plans.length - 50} additional file(s) are included.` });
    }

    const actions = content.createDiv({ cls: 'modal-button-container' });
    const cancel = actions.createEl('button', { text: 'Cancel' });
    cancel.addEventListener('click', () => this.close());
    const confirm = actions.createEl('button', { cls: 'mod-cta', text: `Replace ${this.summary.matches}` });
    confirm.addEventListener('click', async () => {
      confirm.disabled = true;
      cancel.disabled = true;
      try {
        await this.onConfirm();
        this.close();
      } catch (error) {
        console.error('[Native Search Replace] replace failed', error);
        new Notice(`Replace failed: ${error.message || error}`);
        confirm.disabled = false;
        cancel.disabled = false;
      }
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

class SearchReplaceController {
  constructor(plugin, leaf) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.leaf = leaf;
    this.view = leaf.view;
    this.container = this.view && this.view.containerEl;
    this.searchInputEl = null;
    this.searchInputHandler = null;
    this.pointerOverHandler = null;
    this.focusInHandler = null;
    this.panel = null;
    this.targetRow = null;
    this.findInput = null;
    this.regexInput = null;
    this.replaceInput = null;
    this.inferredTarget = null;
    this.manualTargetDirty = false;
    this.destroyed = false;
  }

  getSearchView() {
    const view = this.leaf && this.leaf.view;
    if (!view) return null;
    const type = typeof view.getViewType === 'function' ? view.getViewType() : null;
    return type === 'search' ? view : null;
  }

  getNativeSearchInput() {
    const view = this.getSearchView();
    const input = view && view.searchComponent && view.searchComponent.inputEl;
    if (input && input.tagName === 'INPUT') return input;
    return this.container && this.container.querySelector('.search-input-container input, input.search-input');
  }

  /**
   * Native Search already owns the result model. Each child has the exact TFile
   * plus its result container. Use that model directly instead of reverse-
   * engineering a file path from truncated/duplicated DOM labels.
   */
  getResultItems() {
    const view = this.getSearchView();
    const children = view && view.dom && view.dom.vChildren && view.dom.vChildren._children;
    if (!Array.isArray(children)) return [];
    return children.filter(item => item && item.file instanceof TFile && item.containerEl && typeof item.containerEl.contains === 'function');
  }

  getResultFiles() {
    const out = [];
    const seen = new Set();
    for (const item of this.getResultItems()) {
      if (seen.has(item.file.path)) continue;
      seen.add(item.file.path);
      out.push(item.file);
    }
    return out;
  }

  getItemForElement(el) {
    if (!el || typeof el.closest !== 'function') return null;
    const resultRoot = el.closest('.search-result');
    const items = this.getResultItems();
    if (resultRoot) {
      const exact = items.find(item => item.containerEl === resultRoot);
      if (exact) return exact;
    }
    return items.find(item => item.containerEl && item.containerEl.contains(el)) || null;
  }

  mount() {
    if (!this.container || this.destroyed) return;
    this.ensurePanel();
    this.bindSearchInput();
    this.installLazyResultActions();
  }

  bindSearchInput() {
    const input = this.getNativeSearchInput();
    if (input === this.searchInputEl) return;

    if (this.searchInputEl && this.searchInputHandler) {
      this.searchInputEl.removeEventListener('input', this.searchInputHandler);
      this.searchInputEl.removeEventListener('change', this.searchInputHandler);
    }

    this.searchInputEl = input || null;
    if (!this.searchInputEl) return;
    this.searchInputHandler = () => this.syncTargetFromNativeQuery();
    this.searchInputEl.addEventListener('input', this.searchInputHandler);
    this.searchInputEl.addEventListener('change', this.searchInputHandler);
  }

  installLazyResultActions() {
    if (!this.container || this.pointerOverHandler) return;

    const decorate = target => {
      if (!target || typeof target.closest !== 'function' || !this.container.contains(target)) return;
      const item = this.getItemForElement(target);
      if (!item) return;

      const matchEl = target.closest('.search-result-file-match');
      if (matchEl && item.containerEl.contains(matchEl)) {
        this.ensureMatchButton(matchEl, item);
        return;
      }

      const header = target.closest('.tree-item-self, .search-result-file-title');
      if (header && item.containerEl.contains(header) && !header.closest('.search-result-file-match')) {
        this.ensureFileButton(header, item);
      }
    };

    this.pointerOverHandler = event => decorate(event.target);
    this.focusInHandler = event => decorate(event.target);
    this.container.addEventListener('pointerover', this.pointerOverHandler, { passive: true });
    this.container.addEventListener('focusin', this.focusInHandler);
  }

  destroy() {
    this.destroyed = true;
    if (this.searchInputEl && this.searchInputHandler) {
      this.searchInputEl.removeEventListener('input', this.searchInputHandler);
      this.searchInputEl.removeEventListener('change', this.searchInputHandler);
    }
    if (this.container && this.pointerOverHandler) this.container.removeEventListener('pointerover', this.pointerOverHandler);
    if (this.container && this.focusInHandler) this.container.removeEventListener('focusin', this.focusInHandler);
    if (this.panel) this.panel.remove();
    if (this.container) {
      this.container.querySelectorAll(`.${FILE_BUTTON_CLASS}, .${MATCH_BUTTON_CLASS}`).forEach(el => el.remove());
      this.container.querySelectorAll('.native-search-replace-has-file-button, .native-search-replace-has-match-button').forEach(el => {
        el.removeClass('native-search-replace-has-file-button');
        el.removeClass('native-search-replace-has-match-button');
      });
    }
  }

  ensurePanel() {
    if (!this.container || !this.container.isConnected) return;
    if (this.panel && this.panel.isConnected) return;

    const input = this.getNativeSearchInput();
    if (!input) return;
    const searchInputContainer = input.closest('.search-input-container') || input.parentElement;
    const searchRow = searchInputContainer && (searchInputContainer.closest('.search-row') || searchInputContainer.parentElement);
    if (!searchRow) return;

    const panel = document.createElement('div');
    panel.className = PANEL_CLASS;
    panel.dataset.nativeSearchReplace = 'true';

    // Advanced target row is hidden for a normal native query and appears only
    // when the query DSL does not describe one unambiguous content target.
    const targetRow = panel.createDiv({ cls: 'native-search-replace-target-row' });
    this.targetRow = targetRow;
    const targetIcon = targetRow.createDiv({ cls: 'native-search-replace-leading-icon' });
    setIcon(targetIcon, 'search');
    targetIcon.setAttribute('aria-hidden', 'true');

    this.findInput = targetRow.createEl('input', {
      type: 'text',
      placeholder: 'Find target within search results'
    });
    this.findInput.addClass('native-search-replace-input');
    this.findInput.setAttribute('aria-label', 'Find target within native Search results');

    const regexLabel = targetRow.createEl('label', { cls: 'native-search-replace-mini-toggle' });
    this.regexInput = regexLabel.createEl('input', { type: 'checkbox' });
    regexLabel.createSpan({ text: '.*' });
    regexLabel.setAttribute('title', 'Treat Find target as regular expression');
    regexLabel.setAttribute('aria-label', 'Regular expression');

    const replaceRow = panel.createDiv({ cls: 'native-search-replace-row' });
    const replaceIcon = replaceRow.createDiv({ cls: 'native-search-replace-leading-icon' });
    setIcon(replaceIcon, 'replace');
    replaceIcon.setAttribute('aria-hidden', 'true');

    this.replaceInput = replaceRow.createEl('input', { type: 'text', placeholder: 'Replace' });
    this.replaceInput.addClass('native-search-replace-input');
    this.replaceInput.setAttribute('aria-label', 'Replace with');

    const previewBtn = replaceRow.createEl('button', { cls: 'clickable-icon native-search-replace-icon-button' });
    setIcon(previewBtn, 'eye');
    previewBtn.setAttribute('aria-label', 'Preview replacements');
    previewBtn.setAttribute('title', 'Preview replacements in current native Search results');
    previewBtn.addEventListener('click', () => this.previewAll());

    const replaceBtn = replaceRow.createEl('button', { cls: 'clickable-icon native-search-replace-icon-button native-search-replace-all-button' });
    setIcon(replaceBtn, 'replace-all');
    replaceBtn.setAttribute('aria-label', 'Replace all native Search results');
    replaceBtn.setAttribute('title', 'Replace all in current native Search result files');
    replaceBtn.addEventListener('click', () => this.previewAll());

    this.findInput.addEventListener('input', () => {
      this.inferredTarget = null;
      this.manualTargetDirty = true;
    });

    searchRow.insertAdjacentElement('afterend', panel);
    this.panel = panel;
    this.syncTargetFromNativeQuery(true);
  }

  getQuery() {
    const input = this.getNativeSearchInput();
    return input ? input.value || '' : '';
  }

  syncTargetFromNativeQuery(force = false) {
    if (!this.findInput || !this.targetRow) return;
    const inferred = inferTargetFromNativeQuery(this.getQuery());
    this.inferredTarget = inferred;

    if (inferred) {
      this.targetRow.removeClass('is-visible');
      this.findInput.value = inferred.target;
      this.regexInput.checked = inferred.regex;
      this.manualTargetDirty = false;
      return;
    }

    this.targetRow.addClass('is-visible');
    if (!this.manualTargetDirty) this.regexInput.checked = false;
    // Never erase an explicitly typed target while the user is refining a DSL
    // query. Only clear stale auto-filled data when switching modes.
    if ((force || document.activeElement !== this.findInput) && !this.manualTargetDirty) {
      this.findInput.value = '';
    }
  }

  getCaseSensitive() {
    if (this.inferredTarget && typeof this.inferredTarget.forcedCase === 'boolean') {
      return this.inferredTarget.forcedCase;
    }
    const view = this.getSearchView();
    return !!(view && view.matchingCase);
  }

  getOptions() {
    const inferred = this.inferredTarget;
    return {
      regex: inferred ? inferred.regex : !!this.regexInput.checked,
      caseSensitive: this.getCaseSensitive(),
      flags: inferred ? inferred.flags : ''
    };
  }

  getMatcher() {
    const target = this.inferredTarget ? this.inferredTarget.target : this.findInput.value;
    return createMatcher(target, this.getOptions());
  }

  ensureFileButton(header, item) {
    if (!header || header.querySelector(`.${FILE_BUTTON_CLASS}`)) return;
    if (!(item && item.file instanceof TFile)) return;

    header.addClass('native-search-replace-has-file-button');
    const button = document.createElement('button');
    button.className = `clickable-icon ${FILE_BUTTON_CLASS}`;
    button.setAttribute('aria-label', `Replace all in ${item.file.path}`);
    button.setAttribute('title', 'Replace all in this file');
    setIcon(button, 'replace-all');
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      this.previewFiles([item.file]);
    });
    header.appendChild(button);
  }

  ensureMatchButton(matchEl, item) {
    if (!matchEl || matchEl.querySelector(`.${MATCH_BUTTON_CLASS}`)) return;
    if (!(item && item.file instanceof TFile)) return;

    matchEl.addClass('native-search-replace-has-match-button');
    const button = document.createElement('button');
    button.className = `clickable-icon ${MATCH_BUTTON_CLASS}`;
    button.setAttribute('aria-label', `Replace this match in ${item.file.path}`);
    button.setAttribute('title', 'Replace this match');
    setIcon(button, 'replace');
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      this.replaceSingleVisibleMatch(item, matchEl);
    });
    matchEl.appendChild(button);
  }

  async buildPlans(files) {
    const matcher = this.getMatcher();
    const replacement = this.replaceInput.value;
    const regexMode = this.getOptions().regex;
    const plans = [];

    for (const file of files) {
      const before = await this.app.vault.cachedRead(file);
      const count = countMatches(before, matcher);
      if (!count) continue;
      const after = replaceAllText(before, matcher, replacement, regexMode);
      const beforeLines = before.split(/\r?\n/);
      const afterLines = after.split(/\r?\n/);
      const snippets = [];
      const max = Math.max(beforeLines.length, afterLines.length);
      for (let i = 0; i < max && snippets.length < 12; i += 1) {
        const a = beforeLines[i] ?? '';
        const b = afterLines[i] ?? '';
        if (a !== b) snippets.push({ before: a, after: b });
      }
      plans.push({ file, count, snippets });
    }
    return plans;
  }

  async previewAll() {
    const files = this.getResultFiles();
    if (!files.length) {
      new Notice('Native Search has no result files yet. Wait for the current search to finish.');
      return;
    }
    return this.previewFiles(files);
  }

  async previewFiles(files) {
    let plans;
    try {
      plans = await this.buildPlans(files);
    } catch (error) {
      new Notice(error.message || String(error));
      return;
    }

    const matches = plans.reduce((sum, plan) => sum + plan.count, 0);
    if (!matches) {
      new Notice('Find target does not occur in the selected native Search result files.');
      return;
    }

    const modal = new ReplacePreviewModal(
      this.app,
      { matches, files: plans.length },
      plans,
      () => this.executePlans(plans)
    );
    modal.open();
  }

  async executePlans(plans) {
    const matcher = this.getMatcher();
    const replacement = this.replaceInput.value;
    const regexMode = this.getOptions().regex;
    let changedFiles = 0;
    let replaced = 0;

    for (const plan of plans) {
      let localCount = 0;
      await this.app.vault.process(plan.file, current => {
        localCount = countMatches(current, matcher);
        if (!localCount) return current;
        return replaceAllText(current, matcher, replacement, regexMode);
      });
      if (localCount) {
        changedFiles += 1;
        replaced += localCount;
      }
    }

    new Notice(`Replaced ${replaced} occurrence${replaced === 1 ? '' : 's'} in ${changedFiles} file${changedFiles === 1 ? '' : 's'}.`);
  }

  extractLineHint(matchEl) {
    for (const el of [matchEl, matchEl.parentElement, matchEl.closest('[data-line]'), matchEl.closest('[data-line-number]')].filter(Boolean)) {
      for (const attr of ['data-line', 'data-line-number']) {
        const raw = el.getAttribute && el.getAttribute(attr);
        if (raw != null && /^\d+$/.test(raw)) return Number(raw);
      }
    }
    return null;
  }

  visibleMatchText(matchEl) {
    const clone = matchEl.cloneNode(true);
    clone.querySelectorAll(`.${MATCH_BUTTON_CLASS}`).forEach(el => el.remove());
    return normalizeWhitespace(clone.textContent);
  }

  highlightedText(matchEl) {
    return normalizeWhitespace(
      Array.from(matchEl.querySelectorAll('.search-result-file-matched-text'))
        .map(el => el.textContent || '')
        .join(' ')
    );
  }

  findSourceLine(item, lines, matchEl, matcher) {
    const testIndex = index => index >= 0 && index < lines.length && countMatches(lines[index], matcher) > 0;

    const lineHint = this.extractLineHint(matchEl);
    if (lineHint != null) {
      const possibilities = [lineHint, lineHint - 1].filter((v, i, a) => a.indexOf(v) === i && testIndex(v));
      if (possibilities.length === 1) return possibilities[0];
    }

    const visible = this.visibleMatchText(matchEl);
    const highlighted = this.highlightedText(matchEl);
    const scored = [];
    const candidateLines = [];

    for (let i = 0; i < lines.length; i += 1) {
      if (!testIndex(i)) continue;
      candidateLines.push(i);
      const normalized = normalizeWhitespace(lines[i]);
      let score = 1;
      if (visible && normalized.includes(visible)) score += 100;
      if (highlighted && normalized.includes(highlighted)) score += 20;
      if (visible) {
        const fragments = visible.split(' ').filter(v => v.length >= 3);
        score += fragments.filter(fragment => normalized.includes(fragment)).length;
      }
      scored.push({ index: i, score });
    }

    scored.sort((a, b) => b.score - a.score);
    if (scored.length === 1) return scored[0].index;
    if (scored.length > 1 && scored[0].score > scored[1].score) return scored[0].index;

    // Identical repeated lines are common in generated notes. Native Search
    // renders matching lines in source order, so if row count and candidate-line
    // count agree, map the clicked native row by its order instead of refusing.
    const rows = Array.from(item.containerEl.querySelectorAll('.search-result-file-match'));
    const rowIndex = rows.indexOf(matchEl);
    if (rowIndex >= 0 && rows.length === candidateLines.length && rowIndex < candidateLines.length) {
      return candidateLines[rowIndex];
    }

    return null;
  }

  async replaceSingleVisibleMatch(item, matchEl) {
    let matcher;
    try {
      matcher = this.getMatcher();
    } catch (error) {
      new Notice(error.message || String(error));
      return;
    }

    const file = item.file;
    const replacement = this.replaceInput.value;
    const regexMode = this.getOptions().regex;
    let replaced = false;
    let ambiguous = false;

    await this.app.vault.process(file, current => {
      const newline = current.includes('\r\n') ? '\r\n' : '\n';
      const lines = current.split(/\r?\n/);
      const index = this.findSourceLine(item, lines, matchEl, matcher);
      if (index == null) {
        ambiguous = true;
        return current;
      }
      const updated = replaceFirstText(lines[index], matcher, replacement, regexMode);
      if (updated === lines[index]) return current;
      lines[index] = updated;
      replaced = true;
      return lines.join(newline);
    });

    if (ambiguous) {
      new Notice('Could not map this native result row to exactly one source line. Nothing was changed; use file Replace or Preview instead.');
    } else if (replaced) {
      new Notice(`Replaced one occurrence in ${file.path}.`);
    } else {
      new Notice('The target no longer exists at this result. Native Search may already have refreshed.');
    }
  }
}

module.exports = class NativeSearchReplacePlugin extends Plugin {
  async onload() {
    this.controllers = new Map();

    const refresh = () => this.refreshControllers();
    this.registerEvent(this.app.workspace.on('layout-change', refresh));
    this.registerEvent(this.app.workspace.on('active-leaf-change', refresh));

    this.addCommand({
      id: 'focus-replace-field',
      name: 'Focus replace field in native Search',
      callback: () => {
        this.refreshControllers();
        const active = this.app.workspace.activeLeaf;
        const controller = active && this.controllers.get(active);
        if (controller && controller.replaceInput) {
          controller.replaceInput.focus();
          controller.replaceInput.select();
        } else {
          new Notice('Open the built-in Search tab first.');
        }
      }
    });

    this.addCommand({
      id: 'preview-replace-all',
      name: 'Preview replace all in native Search results',
      callback: () => {
        this.refreshControllers();
        const active = this.app.workspace.activeLeaf;
        const controller = active && this.controllers.get(active);
        if (controller) controller.previewAll();
        else new Notice('Open the built-in Search tab first.');
      }
    });

    this.app.workspace.onLayoutReady(() => this.refreshControllers());
  }

  onunload() {
    for (const controller of this.controllers.values()) controller.destroy();
    this.controllers.clear();
  }

  refreshControllers() {
    const leaves = this.app.workspace.getLeavesOfType('search');
    const live = new Set(leaves);

    for (const [leaf, controller] of this.controllers.entries()) {
      if (!live.has(leaf) || !leaf.view || controller.view !== leaf.view) {
        controller.destroy();
        this.controllers.delete(leaf);
      }
    }

    for (const leaf of leaves) {
      if (this.controllers.has(leaf)) {
        const controller = this.controllers.get(leaf);
        controller.ensurePanel();
        controller.bindSearchInput();
        controller.syncTargetFromNativeQuery();
        continue;
      }
      const controller = new SearchReplaceController(this, leaf);
      this.controllers.set(leaf, controller);
      controller.mount();
    }
  }
};
