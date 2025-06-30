// src/utils/statusBar.js
const vscode = require('vscode');
const stateManager = require('./stateManager');

let items = {};

/**
 * Initialize status bar items; call in activate(context).
 */
function init(context) {
  items.inline = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 104);
  items.sidebar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 103);
  items.annotation = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 102);
  items.number = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
  context.subscriptions.push(items.inline, items.sidebar, items.annotation, items.number);

  // Hook click commands via package.json contributes.commands
  // The item.command is set in updateAll below.
}

/**
 * Read mode flags from globalState and update each status bar item.
 */
function loadState(globalState) {
  // stateManager reads the same globalState internally
  const inlineEnabled = stateManager.isInlineMode();
  const sidebarEnabled = stateManager.isSidebarMode();
  const annotationEnabled = stateManager.isAnnotationMode();
  const numberEnabled = stateManager.isNumberMode();
  update(items.inline, '$(tag)', inlineEnabled, 'Inline: On', 'Inline: Off', 'xi.toggleInlineMode');
  update(items.sidebar, '$(list-tree)', sidebarEnabled, 'Sidebar: On', 'Sidebar: Off', 'xi.toggleSidebarMode');
  update(items.annotation, '$(note)', annotationEnabled, 'Annotate: On', 'Annotate: Off', 'xi.toggleAnnotationMode');
  update(items.number, '$(symbol-number)', numberEnabled, 'Numbers: On', 'Numbers: Off', 'xi.toggleNumberMode');
}

/**
 * Update a single item.
 */
function update(item, icon, enabled, textOn, textOff, command) {
  item.text = `${icon} ${enabled ? textOn : textOff}`;
  item.tooltip = `Toggle ${textOn.split(':')[0]} mode`;
  item.command = command;
  item.backgroundColor = enabled ? new vscode.ThemeColor('statusBarItem.prominentBackground') : undefined;
  item.show();
}

/**
 * Dispose all status bar items (called in deactivate).
 */
function disposeAll() {
  Object.values(items).forEach(i => {
    try { i.dispose(); } catch {}
  });
}

module.exports = { init, loadState, disposeAll };
