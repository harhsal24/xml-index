// src/commands/toggleInlineMode.js
const vscode = require('vscode');
const decoration = require('../utils/decoration');
const indexer = require('../utils/indexer');
const stateManager = require('../utils/stateManager');
const statusBar = require('../utils/statusBar');
const { refreshCodeLenses } = require('../utils/codeLensProvider');

function register(context) {
  const cmd = 'xi.toggleInlineMode';
  const disposable = vscode.commands.registerCommand(cmd, async () => {
    const newVal = !stateManager.isInlineMode();
    await stateManager.setInlineMode(newVal);

    // Update status bar
    statusBar.loadState(context.globalState);

    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === 'xml') {
      if (newVal) {
        indexer.scanDocumentForTags(editor.document);
        decoration.applyInlineDecorations(editor, true, stateManager.isNumberMode());
      } else {
        decoration.disposeDecoration();
      }
    }

    vscode.window.showInformationMessage(`XML Inline indexing ${newVal ? 'enabled' : 'disabled'}`);

    // If annotation mode is on, refresh CodeLenses so positions align
    if (stateManager.isAnnotationMode()) {
      refreshCodeLenses();
    }
  });
  context.subscriptions.push(disposable);
}

module.exports = { register };
