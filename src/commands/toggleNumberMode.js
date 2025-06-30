// src/commands/toggleNumberMode.js
const vscode = require('vscode');
const indexer = require('../utils/indexer');
const decoration = require('../utils/decoration');
const stateManager = require('../utils/stateManager');
const statusBar = require('../utils/statusBar');
const { refreshCodeLenses } = require('../utils/codeLensProvider');

function register(context) {
  const cmd = 'xi.toggleNumberMode';
  const disposable = vscode.commands.registerCommand(cmd, async () => {
    const newVal = !stateManager.isNumberMode();
    await stateManager.setNumberMode(newVal);

    // Update status bar
    statusBar.loadState(context.globalState);

    vscode.window.showInformationMessage(`XML Number-only mode ${newVal ? 'enabled' : 'disabled'}`);

    // Re-apply inline if inline is on
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === 'xml' && stateManager.isInlineMode()) {
      indexer.scanDocumentForTags(editor.document);
      decoration.applyInlineDecorations(editor, true, newVal);
    }
    // Refresh CodeLenses if annotation is on
    if (stateManager.isAnnotationMode()) {
      // rescan if needed
      if (editor && editor.document.languageId === 'xml') {
        indexer.scanDocumentForTags(editor.document);
      }
      refreshCodeLenses();
    }
  });
  context.subscriptions.push(disposable);
}

module.exports = { register };
