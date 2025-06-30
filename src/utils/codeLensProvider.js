// src/utils/codeLensProvider.js

const vscode = require('vscode');
const indexer = require('./indexer');
const stateManager = require('./stateManager');

// Module-scoped EventEmitter for CodeLens refresh
let codeLensEmitter = null;

/**
 * Register the CodeLensProvider for XML.
 * Call this in activate(context).
 */
function registerXmlCodeLensProvider(context) {
  codeLensEmitter = new vscode.EventEmitter();

  const provider = {
    /**
     * Provide CodeLenses above each tag offset position.
     */
    provideCodeLenses(document, token) {
      // Only if annotation mode is on
      if (!stateManager.isAnnotationMode()) {
        return [];
      }

      const lenses = [];
      const entries = indexer.getLastIndexedData();
      for (const entry of entries) {
        if (entry.uri.toString() !== document.uri.toString()) {
          continue;
        }
        // Position at offset
        const pos = document.positionAt(entry.offset);
        const range = new vscode.Range(pos, pos);
        // Title: number-only or tag-index
        const title = stateManager.isNumberMode()
          ? `#${entry.sequence}`
          : `[${entry.tag} #${entry.index}]`;

        lenses.push(new vscode.CodeLens(range, {
          command: 'xi.revealIndexedLine',
          title,
          arguments: [document.uri, entry.line]
        }));
      }
      return lenses;
    },
    /**
     * Event to signal VS Code to refresh CodeLenses.
     */
    onDidChangeCodeLenses: () => {
      if (!codeLensEmitter) {
        codeLensEmitter = new vscode.EventEmitter();
      }
      return codeLensEmitter.event;
    }
  };

  // Register for xml language
  const selector = { language: 'xml', scheme: '*' };
  const disposable = vscode.languages.registerCodeLensProvider(selector, provider);
  context.subscriptions.push(disposable);
  return disposable;
}

/**
 * Fire the emitter so VS Code re-requests CodeLenses.
 */
function refreshCodeLenses() {
  if (codeLensEmitter) {
    codeLensEmitter.fire();
  }
}

module.exports = { registerXmlCodeLensProvider, refreshCodeLenses };
