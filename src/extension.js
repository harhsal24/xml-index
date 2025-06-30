// src/utils/bookmarkDecoration.js
const vscode = require("vscode");
let decorationType = null;
let contextGlobal = null;

const { registerAll } = require("./commands/index");
const XmlIndexedChildrenProvider = require("./providers/xmlIndexedChildrenProvider");

/**
 * Initialize the bookmark decoration type.
 * Call once in activate(context).
 * @param {vscode.ExtensionContext} context
 */
function init(context) {
  contextGlobal = context;

  const iconPath = context.asAbsolutePath("resources/bookmark.svg");

  decorationType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    gutterIconPath: iconPath,
    gutterIconSize: "contain",
    backgroundColor: new vscode.ThemeColor(
      "editor.wordHighlightStrongBackground"
    ),
    overviewRulerColor: "rgba(255,165,0,0.7)",
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });

  updateDecorationsForAllEditors();
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  // Register sidebar/tree views

  // ✅ Register all commands (including xi.clearAllBookmarks)
  registerAll(context);
}

function deactivate() {}

/**
 * Dispose the decoration type.
 */
function dispose() {
  if (decorationType) {
    decorationType.dispose();
    decorationType = null;
  }
}

/**
 * Update decorations for a specific editor.
 * @param {vscode.TextEditor} editor
 * @param {Array} [bookmarks] Optional array of bookmarks
 */
function updateDecorationsForEditor(editor, bookmarks) {
  if (!decorationType || !editor || !editor.document || !contextGlobal) return;

  const storeKey = "xiBookmarks";
  const allBookmarks =
    bookmarks || contextGlobal.workspaceState.get(storeKey, []);
  const uriString = editor.document.uri.toString();
  const ranges = [];

  for (const b of allBookmarks) {
    if (b.file === uriString && Number.isInteger(b.line)) {
      if (b.line >= 0 && b.line < editor.document.lineCount) {
        ranges.push(editor.document.lineAt(b.line).range);
      }
    }
  }

  editor.setDecorations(decorationType, ranges);
}

/**
 * Update decorations for all visible editors.
 */
function updateDecorationsForAllEditors() {
  for (const editor of vscode.window.visibleTextEditors) {
    updateDecorationsForEditor(editor);
  }
}

module.exports = {
  init,
  dispose,
  updateDecorationsForEditor,
  updateDecorationsForAllEditors,
  activate,
  deactivate,
};
