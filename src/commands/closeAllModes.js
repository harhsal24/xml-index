// src/commands/closeAllModes.js
const vscode = require('vscode');
const decoration = require('../utils/decoration');
const statusBar = require('../utils/statusBar');
const stateManager = require('../utils/stateManager');
const { refreshCodeLenses } = require('../utils/codeLensProvider');

function register(context, xmlIndexedProvider) {
  const cmd = 'xi.closeAllModes';
  const disposable = vscode.commands.registerCommand(cmd, async () => {
    // Disable all flags
    await stateManager.setInlineMode(false);
    await stateManager.setSidebarMode(false);
    await stateManager.setAnnotationMode(false);
    await stateManager.setNumberMode(false);

    // Update status bar
    statusBar.loadState(context.globalState);

    // Clear inline decorations
    decoration.disposeDecoration();

    // Refresh sidebar
    if (xmlIndexedProvider && typeof xmlIndexedProvider.refresh === 'function') {
      xmlIndexedProvider.refresh();
    }

    // Refresh CodeLens
    refreshCodeLenses();

    vscode.window.showInformationMessage('All XML indexing modes have been disabled');
  });
  context.subscriptions.push(disposable);
}

module.exports = { register };
