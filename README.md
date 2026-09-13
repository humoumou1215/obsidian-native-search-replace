# Native Search Replace

Replacement controls integrated into Obsidian's built-in Search tab.

## v0.2.0 — native result-model integration

This version replaces the fragile DOM-to-file inference used in v0.1.x.

- Gets result files directly from Obsidian SearchView's native result items (`view.dom.vChildren._children[*].file`).
- Per-file and per-match actions keep the exact native result item instead of guessing from a displayed filename.
- Exact quoted searches such as `"foo bar"` are treated as one simple literal target, so the duplicate **Find target** row stays hidden.
- Simple regex and single-token searches also infer their replacement target automatically.
- Case sensitivity follows the native Search **Aa** state; the plugin no longer owns a second case-sensitive setting.
- Complex Search DSL still gets an explicit **Find target** row because the target cannot be inferred safely.
- No result-tree MutationObserver and no full result scan on Search open. Result action buttons are added lazily on hover/focus.
- Writes still use `Vault.process()` and recompute against current file contents immediately before saving.

## Why internal SearchView data is used

Obsidian does not expose a public extension API for attaching replace operations to the core Search result model. Reading the SearchView result items is more reliable than parsing truncated DOM labels and is the same class of integration used by established Search-enhancement plugins.

## Manual install

Copy into `<vault>/.obsidian/plugins/native-search-replace/`:

- `manifest.json`
- `main.js`
- `styles.css`

Then reload Obsidian and enable **Native Search Replace**.

## Privacy and license

Native Search Replace makes no network requests, uses no telemetry, and reads and writes only vault files through Obsidian's vault API. It is released under the [MIT License](LICENSE).
