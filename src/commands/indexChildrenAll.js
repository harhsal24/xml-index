// src/commands/indexChildrenAll.js
const vscode = require('vscode');
const indexer = require('../utils/indexer');
const decoration = require('../utils/decoration');
const stateManager = require('../utils/stateManager');
const { refreshCodeLenses } = require('../utils/codeLensProvider');

function register(context, xmlIndexedProvider) {
  const cmd = 'xi.indexChildrenAll';
  const disposable = vscode.commands.registerCommand(cmd, async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'xml') {
      vscode.window.showErrorMessage('Please open an XML file first');
      return;
    }
    try {
      indexer.scanDocumentForTags(editor.document);

      // Inline
      if (stateManager.isInlineMode()) {
        decoration.applyInlineDecorations(editor, true, stateManager.isNumberMode());
      } else {
        decoration.disposeDecoration();
      }
      // Sidebar
      if (stateManager.isSidebarMode()) {
        xmlIndexedProvider.refresh();
      }
      // Annotation
      if (stateManager.isAnnotationMode()) {
        refreshCodeLenses();
      }
      const count = indexer.getLastIndexedData().length;
      vscode.window.showInformationMessage(`Successfully indexed ${count} XML elements`);
    } catch (error) {
      console.error(error);
      vscode.window.showErrorMessage('Failed to index XML elements');
    }
  });
  context.subscriptions.push(disposable);
}

module.exports = { register };
