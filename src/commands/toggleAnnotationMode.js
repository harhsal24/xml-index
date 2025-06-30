// src/commands/toggleAnnotationMode.js
const vscode = require('vscode');
const indexer = require('../utils/indexer');
const stateManager = require('../utils/stateManager');
const statusBar = require('../utils/statusBar');
const { refreshCodeLenses } = require('../utils/codeLensProvider');

function register(context) {
  const cmd = 'xi.toggleAnnotationMode';
  const disposable = vscode.commands.registerCommand(cmd, async () => {
    const newVal = !stateManager.isAnnotationMode();
    await stateManager.setAnnotationMode(newVal);

    // Update status bar
    statusBar.loadState(context.globalState);

    vscode.window.showInformationMessage(`XML Annotation indexing ${newVal ? 'enabled' : 'disabled'}`);

    // If enabling, scan current doc so indexer has data
    const editor = vscode.window.activeTextEditor;
    if (newVal && editor && editor.document.languageId === 'xml') {
      indexer.scanDocumentForTags(editor.document);
    }
    // Refresh CodeLenses (will clear if turning off, or populate if on)
    refreshCodeLenses();
  });
  context.subscriptions.push(disposable);
}

module.exports = { register };
