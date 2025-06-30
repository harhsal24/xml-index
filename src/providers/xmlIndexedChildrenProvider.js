// src/providers/xmlIndexedChildrenProvider.js
const vscode = require('vscode');
const indexer = require('../utils/indexer');
const stateManager = require('../utils/stateManager');

class XmlIndexedChildrenProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }
  refresh() {
    this._onDidChangeTreeData.fire();
  }
  getTreeItem(element) {
    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.command = {
      command: 'xi.revealIndexedLine',
      title: 'Go to XML Element',
      arguments: [element.uri, element.line]
    };
    const tagName = element.tag?.toLowerCase() || '';
    if (tagName.includes('div') || tagName.includes('section')) {
      item.iconPath = new vscode.ThemeIcon('symbol-structure');
    } else if (tagName.includes('text') || tagName.includes('p') || tagName.includes('span')) {
      item.iconPath = new vscode.ThemeIcon('symbol-string');
    } else if (tagName.includes('img') || tagName.includes('image')) {
      item.iconPath = new vscode.ThemeIcon('file-media');
    } else if (tagName.includes('link') || tagName.includes('a')) {
      item.iconPath = new vscode.ThemeIcon('link');
    } else {
      item.iconPath = new vscode.ThemeIcon('symbol-xml');
    }
    item.tooltip = `${element.tag} element at line ${element.line + 1}`;
    return item;
  }
  getChildren() {
    if (!stateManager.isSidebarMode()) {
      return [];
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'xml') {
      return [];
    }
    const docUri = editor.document.uri.toString();
    const entries = indexer.getLastIndexedData().filter(e => e.uri.toString() === docUri);
    return entries.map(entry => ({
      label: `${entry.tag} [#${entry.index}] (line ${entry.line + 1})`,
      uri: editor.document.uri,
      line: entry.line,
      tag: entry.tag
    }));
  }
}

module.exports = { XmlIndexedChildrenProvider };
