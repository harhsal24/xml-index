// src/utils/events.js
const vscode = require('vscode');
const indexer = require('./indexer');
const decoration = require('./decoration');
const stateManager = require('./stateManager');
const { refreshCodeLenses } = require('./codeLensProvider');

/**
 * Perform indexing display: scan document, then inline decorations,
 * sidebar refresh, and CodeLens refresh as needed.
 * @param {XmlIndexedChildrenProvider} xmlIndexedProvider
 */
function doIndexDisplay(xmlIndexedProvider) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    console.log('[events] No active editor; skipping indexing.');
    return;
  }
  if (editor.document.languageId !== 'xml') {
    console.log(`[events] Language is '${editor.document.languageId}', not 'xml'; skipping indexing.`);
    // Also dispose any existing inline decorations if you want to clear when switching away:
    decoration.disposeDecoration();
    return;
  }

  try {
    console.log('[events] doIndexDisplay: scanning document for tags...');
    indexer.scanDocumentForTags(editor.document);
    const entries = indexer.getLastIndexedData();
    console.log(`[events] scanDocumentForTags found ${entries.length} entries.`);

    // Inline decorations
    if (stateManager.isInlineMode()) {
      console.log('[events] Inline mode is ON; applying inline decorations.');
      decoration.applyInlineDecorations(editor, true, stateManager.isNumberMode());
    } else {
      console.log('[events] Inline mode is OFF; disposing decorations.');
      decoration.disposeDecoration();
    }

    // Sidebar
    if (stateManager.isSidebarMode()) {
      console.log('[events] Sidebar mode is ON; refreshing sidebar provider.');
      if (xmlIndexedProvider && typeof xmlIndexedProvider.refresh === 'function') {
        xmlIndexedProvider.refresh();
      }
    }

    // Annotations / CodeLens
    if (stateManager.isAnnotationMode()) {
      console.log('[events] Annotation mode is ON; refreshing CodeLenses.');
      refreshCodeLenses();
    } else {
      console.log('[events] Annotation mode is OFF; no CodeLens refresh.');
      // Optional: you could still fire refreshCodeLenses() to clear existing lenses when turning off.
      refreshCodeLenses();
    }
  } catch (error) {
    console.error('[events] Error during index display:', error);
    vscode.window.showErrorMessage('Failed to index XML elements');
  }
}

/**
 * Register event listeners: active editor change, save, change.
 */
function register(context, xmlIndexedProvider) {
  let updateTimeout = null;

  // On active editor change
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      console.log('[events] onDidChangeActiveTextEditor triggered.');
      doIndexDisplay(xmlIndexedProvider);
    })
  );

  // On save
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(doc => {
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document === doc) {
        console.log('[events] onDidSaveTextDocument triggered for active editor.');
        doIndexDisplay(xmlIndexedProvider);
      }
    })
  );

  // On text change with debounce
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(event => {
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document === event.document && editor.document.languageId === 'xml') {
        if (updateTimeout) {
          clearTimeout();
        }
        updateTimeout = setTimeout(() => {
          console.log('[events] Debounced onDidChangeTextDocument trigger.');
          doIndexDisplay(xmlIndexedProvider);
        }, 500);
      }
    })
  );

  // Optionally clear timeout on deactivate; but as this is closure-scoped, it will be GC'd.
}

/**
 * Clear any pending timeout (on deactivate) - optional since scoped locally.
 */
function clearTimeout() {
  // No-op or track externally if desired
}

module.exports = { doIndexDisplay, register, clearTimeout };
