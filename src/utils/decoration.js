// src/utils/decoration.js
const vscode = require('vscode');
const indexer = require('./indexer');

let decorationType = null;

/**
 * Apply inline decorations showing either sequence or [tag #index].
 * @param {vscode.TextEditor} editor 
 * @param {boolean} inlineModeEnabled 
 * @param {boolean} numberModeEnabled 
 */
function applyInlineDecorations(editor, inlineModeEnabled, numberModeEnabled) {
  if (!editor) {
    console.log('[decoration] No active editor; skipping inline decorations.');
    return;
  }
  if (!inlineModeEnabled) {
    console.log('[decoration] Inline mode disabled; disposing decorations.');
    disposeDecoration();
    return;
  }

  const doc = editor.document;
  // Dispose previous decorationType if any
  if (decorationType) {
    decorationType.dispose();
    decorationType = null;
  }
  // Create new decoration type
  decorationType = vscode.window.createTextEditorDecorationType({
    after: {
      margin: '0 0 0 1em',
      fontStyle: 'italic',
      color: new vscode.ThemeColor('editorCodeLens.foreground')
    }
  });

  const decorations = [];
  const text = doc.getText();
  const entries = indexer.getLastIndexedData();

  console.log(`[decoration] Applying inline decorations: inlineMode=${inlineModeEnabled}, numberMode=${numberModeEnabled}, entries count=${entries.length}`);

  for (const entry of entries) {
    if (!entry.uri || entry.uri.toString() !== doc.uri.toString()) {
      continue;
    }
    // Determine position just after the opening tag
    const offset = entry.offset;
    if (typeof offset !== 'number') {
      console.warn('[decoration] entry.offset is not a number:', entry);
      continue;
    }
    const slice = text.slice(offset);
    const m = slice.match(/^<[^>]*>/);
    let pos;
    if (m) {
      try {
        pos = doc.positionAt(offset + m[0].length);
      } catch (e) {
        console.warn('[decoration] positionAt failed:', e, 'entry:', entry);
        pos = new vscode.Position(entry.line, 0);
      }
    } else {
      // fallback to beginning of line
      pos = new vscode.Position(entry.line, 0);
    }

    // Compose content text
    const contentText = numberModeEnabled
      ? `← #${entry.sequence}`
      : `← [${entry.tag} #${entry.index}]`;

    // Log first few for debugging
    // if you want, uncomment: console.log(`[decoration] Decorating tag <${entry.tag}> at line ${entry.line}, seq=${entry.sequence}`);

    decorations.push({
      range: new vscode.Range(pos, pos),
      renderOptions: {
        after: {
          contentText,
          fontStyle: 'italic',
          color: new vscode.ThemeColor('editorCodeLens.foreground')
        }
      }
    });
  }

  try {
    editor.setDecorations(decorationType, decorations);
    console.log(`[decoration] Applied ${decorations.length} inline decorations.`);
  } catch (e) {
    console.error('[decoration] Failed to set decorations:', e);
  }
}

/**
 * Dispose any existing inline decoration type.
 */
function disposeDecoration() {
  if (decorationType) {
    try {
      decorationType.dispose();
    } catch (e) {
      console.warn('[decoration] Error disposing decorationType:', e);
    }
    decorationType = null;
  }
}

module.exports = { applyInlineDecorations, disposeDecoration };
