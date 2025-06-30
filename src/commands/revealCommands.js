// src/commands/revealCommands.js
const vscode = require('vscode');

/**
 * Reveal a given bookmarked line in the editor, highlight the whole line briefly.
 * @param {vscode.Uri} uri
 * @param {number} line
 */
async function revealBookmarkLine(uri, line) {
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const ed = await vscode.window.showTextDocument(doc, { preview: false });
    if (line < 0 || line >= doc.lineCount) {
      vscode.window.showWarningMessage('Bookmark line out of range');
      return;
    }
    const pos = new vscode.Position(line, 0);
    ed.selection = new vscode.Selection(pos, pos);
    ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);

    // Highlight the line briefly
    const decorationType = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
      isWholeLine: true
    });
    const range = doc.lineAt(line).range;
    ed.setDecorations(decorationType, [range]);
    setTimeout(() => decorationType.dispose(), 2000);
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to reveal bookmark: ${err.message}`);
    console.error(err);
  }
}

/**
 * Register reveal commands for bookmarks.
 */
function register(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('xi.revealBookmarkLine', revealBookmarkLine)
  );
}

module.exports = { register };
