// src/commands/revealIndexedLine.js
const vscode = require('vscode');

async function revealIndexedLine(uri, line) {
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const ed = await vscode.window.showTextDocument(doc, { preview: false });
    const pos = new vscode.Position(line, 0);
    ed.selection = new vscode.Selection(pos, pos);
    ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    const decoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
      isWholeLine: true
    });
    ed.setDecorations(decoration, [new vscode.Range(pos, pos)]);
    setTimeout(() => decoration.dispose(), 2000);
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to reveal line: ${err.message}`);
    console.error(err);
  }
}

function register(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('xi.revealIndexedLine', (uri, line) => revealIndexedLine(uri, line))
  );
}

module.exports = { register, revealIndexedLine };