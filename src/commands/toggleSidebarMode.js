// src/commands/toggleSidebarMode.js
const vscode = require('vscode');
const stateManager = require('../utils/stateManager');
const statusBar = require('../utils/statusBar');

function register(context, xmlIndexedProvider) {
  const cmd = 'xi.toggleSidebarMode';
  const disposable = vscode.commands.registerCommand(cmd, async () => {
    const newVal = !stateManager.isSidebarMode();
    await stateManager.setSidebarMode(newVal);

    // Update status bar
    statusBar.loadState(context.globalState);

    vscode.window.showInformationMessage(`XML Sidebar indexing ${newVal ? 'enabled' : 'disabled'}`);

    // Refresh the tree view
    if (xmlIndexedProvider && typeof xmlIndexedProvider.refresh === 'function') {
      xmlIndexedProvider.refresh();
    }
  });
  context.subscriptions.push(disposable);
}

module.exports = { register };
