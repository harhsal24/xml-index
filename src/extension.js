// src/extension.js
const vscode = require("vscode");
const sax = require("sax");

// Global providers and state
let xmlIndexedProvider = null;
let outputChannel = null;
let globalState = null;
let codeLensEmitter = null;
let decorationType = null;
let lastIndexedData = [];

// Performance optimization variables
const documentCache = new Map(); // Cache parsed results
const debouncedTimeouts = new Map(); // Debounce timeouts
const LARGE_FILE_THRESHOLD = 50000; // 50KB threshold for large files

// State management
function isInlineMode() {
  return globalState?.get("xiInlineMode", false);
}
function setInlineMode(val) {
  return globalState.update("xiInlineMode", val);
}
function isSidebarMode() {
  return globalState?.get("xiSidebarMode", false);
}
function setSidebarMode(val) {
  return globalState.update("xiSidebarMode", val);
}
function isAnnotationMode() {
  return globalState?.get("xiAnnotationMode", false);
}
function setAnnotationMode(val) {
  return globalState.update("xiAnnotationMode", val);
}
function isNumberMode() {
  return globalState?.get("xiNumberMode", false);
}
function setNumberMode(val) {
  return globalState.update("xiNumberMode", val);
}

// Helper: detect XML documents
function isXmlDocument(document) {
  if (!document) return false;
  if (document.languageId === "xml") return true;
  const path = document.fileName || document.uri.fsPath || "";
  if (/\.xml$/i.test(path)) return true;
  const text = document.getText().slice(0, 200);
  return /^\s*<\?xml\s+version/i.test(text) || /^\s*<[^>]+>/.test(text);
}

// Enhanced caching with version tracking
const lastIndexedVersionMap = new Map();

function shouldReindex(document) {
  const docKey = document.uri.toString();
  const currentVersion = document.version;
  const lastVersion = lastIndexedVersionMap.get(docKey);

  if (!lastVersion || lastVersion !== currentVersion) {
    lastIndexedVersionMap.set(docKey, currentVersion);
    return true;
  }
  return false;
}

// Helper function to debounce operations
function debounceOperation(key, operation, delay) {
  // Clear existing timeout
  if (debouncedTimeouts.has(key)) {
    clearTimeout(debouncedTimeouts.get(key));
  }

  // Set new timeout
  const timeoutId = setTimeout(() => {
    debouncedTimeouts.delete(key);
    operation();
  }, delay);

  debouncedTimeouts.set(key, timeoutId);
}

// Helper function for regular-sized documents
function scanRegularDocument(document, text) {
  const parser = sax.parser(true, { position: true });
  const data = [];
  let globalId = 0;
  const stack = [];

  parser.onopentag = (node) => {
    globalId++;
    const parent = stack.length ? stack[stack.length - 1] : null;

    data.push({
      tag: node.name,
      offset: parser.startTagPosition - 1,
      line: parser.line - 1,
      parent: parent?.id || null,
      id: globalId,
    });

    stack.push({ tag: node.name, id: globalId });
  };

  parser.onclosetag = (tagName) => {
    if (stack.length && stack[stack.length - 1].tag === tagName) {
      stack.pop();
    }
  };

  parser.onerror = (error) => {
    outputChannel?.appendLine(`❌ SAX parse error: ${error.message}`);
    parser.resume();
  };

  parser.write(text).close();

  // Process and cache results
  const indexedData = processAndCacheResults(document, data);
  return indexedData;
}

// Helper function to process chunk with regex
function processChunkRegex(chunk, startOffset, startId) {
  const entries = [];
  let id = startId;
  const regex = /<\/?([A-Za-z0-9_:-]+)(?:\s[^>]*?)?(?:\/>|>)/g;
  let match;

  while ((match = regex.exec(chunk))) {
    const full = match[0];
    const tag = match[1];
    const offset = startOffset + match.index;
    const isClose = full.startsWith("</");
    const isSelf = full.endsWith("/>") && !isClose;

    if (!isClose) {
      id++;
      entries.push({
        tag: tag,
        offset: offset,
        line: Math.max(
          0,
          chunk.substring(0, match.index).split("\n").length - 1
        ),
        parent: null, // Simplified for chunked processing
        id: id,
      });
    }
  }

  return { entries, nextId: id };
}

// Helper function for large documents
async function scanLargeDocument(document, text) {
  const chunkSize = 10000;
  const data = [];
  let globalId = 0;

  // Process in chunks with progress indication
  for (let start = 0; start < text.length; start += chunkSize) {
    const chunk = text.slice(start, Math.min(start + chunkSize, text.length));
    const chunkData = processChunkRegex(chunk, start, globalId);
    data.push(...chunkData.entries);
    globalId = chunkData.nextId;

    // Yield control periodically
    if (start % (chunkSize * 2) === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  const indexedData = processAndCacheResults(document, data);
  return indexedData;
}

// Enhanced data processing to track siblings and only index duplicates
function processAndCacheResults(document, data) {
    // First, build parent-child relationships and count siblings
    const parentChildMap = new Map();
    const siblingCounts = new Map();
    
    // Group elements by their parent and tag name
    data.forEach((entry, index) => {
        const parentKey = entry.parent || 'ROOT';
        const siblingKey = `${parentKey}:${entry.tag}`;
        
        if (!parentChildMap.has(parentKey)) {
            parentChildMap.set(parentKey, []);
        }
        parentChildMap.get(parentKey).push({...entry, globalSequence: index + 1});
        
        // Count siblings with same tag under same parent
        siblingCounts.set(siblingKey, (siblingCounts.get(siblingKey) || 0) + 1);
    });
    
    // Process data and add indexing info only for duplicates
    const processedData = [];
    const tagOrderTrackers = new Map(); // Track order within same parent-tag combination
    
    data.forEach((entry, index) => {
        const parentKey = entry.parent || 'ROOT';
        const siblingKey = `${parentKey}:${entry.tag}`;
        const siblingCount = siblingCounts.get(siblingKey);
        
        // Track order within same tag under same parent
        if (!tagOrderTrackers.has(siblingKey)) {
            tagOrderTrackers.set(siblingKey, 0);
        }
        tagOrderTrackers.set(siblingKey, tagOrderTrackers.get(siblingKey) + 1);
        
        const processedEntry = {
            ...entry,
            globalSequence: index + 1,
            orderInTag: tagOrderTrackers.get(siblingKey),
            siblingCount: siblingCount,
            needsIndexing: siblingCount > 1, // Only index if there are multiple siblings
            parentKey: parentKey
        };
        
        processedData.push(processedEntry);
    });

    // Cache the results
    const docKey = document.uri.toString();
    documentCache.set(docKey, processedData);
    
    // Store in global data
    if (globalThis.xmlIndexerData) {
        globalThis.xmlIndexerData.set(docKey, processedData);
    }
    
    lastIndexedData = processedData;
    return processedData;
}
// Main indexer function
async function scanDocumentForTags(document) {
  // Check if we need to reindex
  if (!shouldReindex(document)) {
    const cached = documentCache.get(document.uri.toString());
    if (cached) {
      outputChannel?.appendLine(
        `📋 Using cached data for ${document.fileName}`
      );
      if (globalThis.xmlIndexerData) {
        globalThis.xmlIndexerData.set(document.uri.toString(), cached);
      }
      lastIndexedData = cached;
      return cached;
    }
  }

  const text = document.getText();
  const isLargeFile = text.length > LARGE_FILE_THRESHOLD;

  if (isLargeFile) {
    outputChannel?.appendLine(
      `⚠️ Large file detected (${text.length} chars), using optimized processing`
    );
    return await scanLargeDocument(document, text);
  }

  // Regular processing for smaller files
  return scanRegularDocument(document, text);
}

// Modified decoration function to only show decorations for elements that need indexing
function applyInlineDecorations(editor, inlineModeEnabled, numberModeEnabled) {
    if (!editor) {
        outputChannel?.appendLine('[decoration] No active editor; skipping inline decorations.');
        return;
    }
    if (!inlineModeEnabled) {
        outputChannel?.appendLine('[decoration] Inline mode disabled; disposing decorations.');
        disposeDecoration();
        return;
    }

    const doc = editor.document;
    if (!isXmlDocument(doc)) {
        outputChannel?.appendLine('[decoration] Document is not XML; disposing decorations.');
        disposeDecoration();
        return;
    }

    if (decorationType) {
        decorationType.dispose();
        decorationType = null;
    }

    decorationType = vscode.window.createTextEditorDecorationType({
        after: {
            margin: '0 0 0 1.5em',
            fontStyle: 'italic',
            color: new vscode.ThemeColor('editorCodeLens.foreground')
        }
    });

    const decorations = [];
    const text = doc.getText();
    const entries = getIndexedDataForDocument(doc);
    
    // Only process entries that need indexing (have siblings with same tag)
    const indexableEntries = entries.filter(entry => entry.needsIndexing);
    
    outputChannel?.appendLine(`[decoration] Found ${indexableEntries.length} elements needing indexing out of ${entries.length} total elements`);

    for (const entry of indexableEntries) {
        const offset = entry.offset;
        if (typeof offset !== 'number') {
            continue;
        }

        const slice = text.slice(offset);
        const m = slice.match(/^<[^>]*>/);
        let pos;

        if (m) {
            try {
                pos = doc.positionAt(offset + m[0].length);
            } catch (e) {
                pos = new vscode.Position(entry.line, 0);
            }
        } else {
            pos = new vscode.Position(entry.line, 0);
        }

        // Show index only for elements with siblings
        let contentText;
        if (numberModeEnabled) {
            contentText = ` ← ${entry.orderInTag}/${entry.siblingCount} `;
        } else {
            contentText = ` ← [${entry.tag} ${entry.orderInTag}/${entry.siblingCount}] `;
        }

        decorations.push({
            range: new vscode.Range(pos, pos),
            renderOptions: {
                after: {
                    contentText,
                    fontStyle: 'italic',
                    color: new vscode.ThemeColor('editorCodeLens.foreground')
                }
            }
        });
    }

    try {
        editor.setDecorations(decorationType, decorations);
        outputChannel?.appendLine(`[decoration] Applied ${decorations.length} conditional decorations.`);
    } catch (e) {
        outputChannel?.appendLine(`[decoration] Failed to set decorations: ${e.message}`);
    }
}

// Modified CodeLens provider to only show lenses for elements that need indexing
function registerXmlCodeLensProvider(context) {
    codeLensEmitter = new vscode.EventEmitter();

    const provider = {
        provideCodeLenses(document, token) {
            outputChannel?.appendLine(`[CodeLens] provideCodeLenses called for: ${document.uri.toString()}`);
            
            if (!isAnnotationMode()) {
                outputChannel?.appendLine('[CodeLens] Annotation mode disabled, returning empty array');
                return [];
            }

            if (!isXmlDocument(document)) {
                outputChannel?.appendLine('[CodeLens] Document is not XML, returning empty array');
                return [];
            }

            const entries = getIndexedDataForDocument(document);
            // Only show CodeLens for elements that need indexing
            const indexableEntries = entries.filter(entry => entry.needsIndexing);
            
            outputChannel?.appendLine(`[CodeLens] Found ${indexableEntries.length} indexable entries out of ${entries.length} total entries`);

            const lenses = [];
            const processedLines = new Set();

            for (const entry of indexableEntries) {
                try {
                    if (processedLines.has(entry.line)) {
                        continue;
                    }
                    processedLines.add(entry.line);

                    const pos = document.positionAt(entry.offset);
                    const range = new vscode.Range(pos, pos);
                    
                    let title;
                    if (isNumberMode()) {
                        title = ` ${entry.orderInTag}/${entry.siblingCount}`;
                    } else {
                        title = ` [${entry.tag} ${entry.orderInTag}/${entry.siblingCount}]`;
                    }

                    lenses.push(new vscode.CodeLens(range, {
                        command: 'xi.revealIndexedLine',
                        title,
                        arguments: [document.uri, entry.line]
                    }));
                } catch (error) {
                    outputChannel?.appendLine(`[CodeLens] Error creating lens for entry: ${error.message}`);
                }
            }
            
            outputChannel?.appendLine(`[CodeLens] Returning ${lenses.length} conditional code lenses`);
            return lenses;
        },

        onDidChangeCodeLenses: codeLensEmitter.event
    };

    const disposable = vscode.languages.registerCodeLensProvider(
        [
            { language: 'xml' },
            { pattern: '**/*.xml' }
        ],
        provider
    );
    
    context.subscriptions.push(disposable);
    outputChannel?.appendLine(`[CodeLens] Registered conditional CodeLens provider`);

    return provider;
}


function getIndexedDataForDocument(document) {
  if (!globalThis.xmlIndexerData) {
    return [];
  }
  const docKey = document.uri.toString();
  return globalThis.xmlIndexerData.get(docKey) || [];
}

function disposeDecoration() {
  if (decorationType) {
    try {
      decorationType.dispose();
    } catch (e) {
      outputChannel?.appendLine(
        `[decoration] Error disposing decorationType: ${e.message}`
      );
    }
    decorationType = null;
  }
}

// CodeLens functions
function refreshCodeLenses() {
  if (codeLensEmitter) {
    codeLensEmitter.fire();
  }
}

// Modified Tree Provider to show grouping more intelligently
class XmlIndexedChildrenProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        outputChannel?.appendLine('[TreeProvider] XmlIndexedChildrenProvider constructed');
    }

    refresh() {
        outputChannel?.appendLine('[TreeProvider] Refresh called');
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element) {
        outputChannel?.appendLine(`[TreeProvider] getTreeItem called for: ${element.label}`);
        
        if (element.isGroup) {
            // Show different icons for groups that need indexing vs single elements
            const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
            if (element.needsIndexing) {
                item.iconPath = new vscode.ThemeIcon('symbol-namespace');
                item.tooltip = `${element.count} ${element.tagName} elements (indexed)`;
            } else {
                item.iconPath = new vscode.ThemeIcon('symbol-structure');
                item.tooltip = `${element.count} ${element.tagName} element (single)`;
            }
            return item;
        }

        // Individual element items
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.command = {
            command: 'xi.revealIndexedLine',
            title: 'Go to XML Element',
            arguments: [element.uri, element.line]
        };

        // Use different icons for indexed vs non-indexed elements
        if (element.needsIndexing) {
            item.iconPath = new vscode.ThemeIcon('symbol-xml');
        } else {
            item.iconPath = new vscode.ThemeIcon('symbol-constant');
        }
        
        const indexInfo = element.needsIndexing ? ` [${element.orderInTag}/${element.siblingCount}]` : ' [single]';
        item.tooltip = `${element.tag} element at line ${element.line + 1}${indexInfo}`;
        return item;
    }

    getChildren(element) {
        outputChannel?.appendLine(`[TreeProvider] getChildren called. Element: ${element ? element.label : 'root'}`);
        
        if (!isSidebarMode()) {
            outputChannel?.appendLine('[TreeProvider] Sidebar mode is disabled, returning empty array');
            return [];
        }

        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            outputChannel?.appendLine('[TreeProvider] No active editor');
            return [];
        }
        
        if (!isXmlDocument(editor.document)) {
            outputChannel?.appendLine(`[TreeProvider] Document is not XML: ${editor.document.languageId}`);
            return [];
        }

        const entries = getIndexedDataForDocument(editor.document);
        outputChannel?.appendLine(`[TreeProvider] Found ${entries.length} entries for current document`);

        if (!element) {
            // Root level - create grouped structure showing indexing status
            const tagGroups = {};
            
            entries.forEach(entry => {
                if (!tagGroups[entry.tag]) {
                    tagGroups[entry.tag] = {
                        entries: [],
                        needsIndexing: false
                    };
                }
                tagGroups[entry.tag].entries.push(entry);
                if (entry.needsIndexing) {
                    tagGroups[entry.tag].needsIndexing = true;
                }
            });

            const children = Object.keys(tagGroups).map(tagName => {
                const group = tagGroups[tagName];
                const indexingLabel = group.needsIndexing ? ' (indexed)' : ' (single)';
                
                return {
                    label: `${tagName} (${group.entries.length})${indexingLabel}`,
                    isGroup: true,
                    tagName: tagName,
                    count: group.entries.length,
                    entries: group.entries,
                    needsIndexing: group.needsIndexing
                };
            });
            
            outputChannel?.appendLine(`[TreeProvider] Returning ${children.length} tag groups`);
            return children;
        } else if (element.isGroup) {
            // Expanded group - show individual elements
            const children = element.entries.map((entry, index) => {
                let label;
                if (entry.needsIndexing) {
                    if (isNumberMode()) {
                        label = `#${entry.orderInTag}/${entry.siblingCount} (line ${entry.line + 1})`;
                    } else {
                        label = `${entry.tag} [${entry.orderInTag}/${entry.siblingCount}] (line ${entry.line + 1})`;
                    }
                } else {
                    label = `${entry.tag} (line ${entry.line + 1})`;
                }
                
                return {
                    label: label,
                    uri: editor.document.uri,
                    line: entry.line,
                    tag: entry.tag,
                    isGroup: false,
                    needsIndexing: entry.needsIndexing,
                    orderInTag: entry.orderInTag,
                    siblingCount: entry.siblingCount
                };
            });
            
            outputChannel?.appendLine(`[TreeProvider] Returning ${children.length} entries for group ${element.tagName}`);
            return children;
        }
        
        return [];
    }
}

// Event handling and display functions
async function doIndexDisplay() {
  const startTime = Date.now();
  const editor = vscode.window.activeTextEditor;

  if (!editor) {
    outputChannel?.appendLine("[events] No active editor; skipping indexing.");
    return;
  }

  if (!isXmlDocument(editor.document)) {
    outputChannel?.appendLine(
      `[events] Document is not XML (${editor.document.languageId}); disposing decorations.`
    );
    disposeDecoration();
    return;
  }

  try {
    const text = editor.document.getText();
    const isLargeFile = text.length > LARGE_FILE_THRESHOLD;

    if (isLargeFile) {
      // Show status for large files
      vscode.window.setStatusBarMessage("🔄 Indexing large XML file...", 3000);
    }

    outputChannel?.appendLine(
      "[events] doIndexDisplay: scanning document for tags..."
    );
    await scanDocumentForTags(editor.document);

    const entries = getIndexedDataForDocument(editor.document);
    outputChannel?.appendLine(
      `[events] scanDocumentForTags found ${entries.length} entries.`
    );

    // Apply features based on modes
    if (isInlineMode()) {
      outputChannel?.appendLine(
        "[events] Inline mode is ON; applying inline decorations."
      );
      applyInlineDecorations(editor, true, isNumberMode());
    } else {
      outputChannel?.appendLine(
        "[events] Inline mode is OFF; disposing decorations."
      );
      disposeDecoration();
    }

    if (isSidebarMode()) {
      outputChannel?.appendLine(
        "[events] Sidebar mode is ON; refreshing sidebar provider."
      );
      if (
        xmlIndexedProvider &&
        typeof xmlIndexedProvider.refresh === "function"
      ) {
        xmlIndexedProvider.refresh();
        outputChannel?.appendLine(
          "[events] Sidebar provider refreshed successfully."
        );
      }
    }

    if (isAnnotationMode()) {
      outputChannel?.appendLine("[events] Refreshing CodeLenses...");
      refreshCodeLenses();
    }

    // Clean up memory periodically
    cleanupMemory();
  } catch (error) {
    outputChannel?.appendLine(
      `[events] Error during index display: ${error.message}`
    );
    vscode.window.showErrorMessage("Failed to index XML elements");
  } finally {
    const duration = Date.now() - startTime;
    if (duration > 100) {
      outputChannel?.appendLine(`⏱️ doIndexDisplay took ${duration}ms`);
    }
  }
}

function cleanupMemory() {
  const MAX_CACHE_SIZE = 5; // Limit to 5 cached documents

  if (documentCache.size > MAX_CACHE_SIZE) {
    const entries = Array.from(documentCache.entries());
    const toDelete = entries.slice(0, entries.length - MAX_CACHE_SIZE);

    toDelete.forEach(([key]) => {
      documentCache.delete(key);
      lastIndexedVersionMap.delete(key);
    });

    outputChannel?.appendLine(
      `🧹 Cleaned up cache: removed ${toDelete.length} entries`
    );
  }
}

// Reveal functions
async function revealIndexedLine(uri, line) {
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const ed = await vscode.window.showTextDocument(doc, { preview: false });
    const pos = new vscode.Position(line, 0);
    ed.selection = new vscode.Selection(pos, pos);
    ed.revealRange(
      new vscode.Range(pos, pos),
      vscode.TextEditorRevealType.InCenter
    );
    const decoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor(
        "editor.findMatchHighlightBackground"
      ),
      isWholeLine: true,
    });
    ed.setDecorations(decoration, [new vscode.Range(pos, pos)]);
    setTimeout(() => decoration.dispose(), 2000);
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to reveal line: ${err.message}`);
    outputChannel?.appendLine(`Error revealing line: ${err.message}`);
  }
}

// Command registration functions
function registerCommands(context) {
  // Toggle Inline Mode
  context.subscriptions.push(
    vscode.commands.registerCommand("xi.toggleInlineMode", async () => {
      const newVal = !isInlineMode();
      await setInlineMode(newVal);

      const editor = vscode.window.activeTextEditor;
      if (editor && isXmlDocument(editor.document)) {
        if (newVal) {
          await scanDocumentForTags(editor.document);
          applyInlineDecorations(editor, true, isNumberMode());
        } else {
          disposeDecoration();
        }
      }

      vscode.window.showInformationMessage(
        `XML Inline indexing ${newVal ? "enabled" : "disabled"}`
      );
    })
  );

  // Toggle Sidebar Mode
  context.subscriptions.push(
    vscode.commands.registerCommand("xi.toggleSidebarMode", async () => {
      const newVal = !isSidebarMode();
      await setSidebarMode(newVal);

      outputChannel?.appendLine(`[Command] Sidebar mode toggled to: ${newVal}`);
      vscode.window.showInformationMessage(
        `XML Sidebar indexing ${newVal ? "enabled" : "disabled"}`
      );

      if (newVal) {
        const editor = vscode.window.activeTextEditor;
        if (editor && isXmlDocument(editor.document)) {
          outputChannel?.appendLine(
            "[Command] Scanning document for sidebar mode..."
          );
          await scanDocumentForTags(editor.document);
        }
      }

      if (
        xmlIndexedProvider &&
        typeof xmlIndexedProvider.refresh === "function"
      ) {
        outputChannel?.appendLine("[Command] Refreshing tree provider...");
        xmlIndexedProvider.refresh();
      } else {
        outputChannel?.appendLine(
          "[Command] ERROR: Tree provider not available!"
        );
      }
    })
  );

  // Toggle Annotation Mode
  context.subscriptions.push(
    vscode.commands.registerCommand("xi.toggleAnnotationMode", async () => {
      const newVal = !isAnnotationMode();
      await setAnnotationMode(newVal);

      outputChannel?.appendLine(
        `[Command] Annotation mode toggled to: ${newVal}`
      );
      vscode.window.showInformationMessage(
        `XML Annotation indexing ${newVal ? "enabled" : "disabled"}`
      );

      const editor = vscode.window.activeTextEditor;
      if (editor && isXmlDocument(editor.document)) {
        if (newVal) {
          outputChannel?.appendLine(
            "[Command] Scanning document for annotation mode..."
          );
          await scanDocumentForTags(editor.document);
        }
        refreshCodeLenses();
      }
    })
  );

  // Toggle Number Mode
  context.subscriptions.push(
    vscode.commands.registerCommand("xi.toggleNumberMode", async () => {
      const newVal = !isNumberMode();
      await setNumberMode(newVal);

      vscode.window.showInformationMessage(
        `XML Number-only mode ${newVal ? "enabled" : "disabled"}`
      );

      const editor = vscode.window.activeTextEditor;
      if (editor && isXmlDocument(editor.document)) {
        if (isInlineMode()) {
          await scanDocumentForTags(editor.document);
          applyInlineDecorations(editor, true, newVal);
        }
        if (isAnnotationMode()) {
          await scanDocumentForTags(editor.document);
          refreshCodeLenses();
        }
        if (isSidebarMode() && xmlIndexedProvider) {
          xmlIndexedProvider.refresh();
        }
      }
    })
  );

  // Index All Children
  context.subscriptions.push(
    vscode.commands.registerCommand("xi.indexChildrenAll", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !isXmlDocument(editor.document)) {
        vscode.window.showErrorMessage("Please open an XML file first");
        return;
      }
      try {
        await scanDocumentForTags(editor.document);

        if (isInlineMode()) {
          applyInlineDecorations(editor, true, isNumberMode());
        } else {
          disposeDecoration();
        }

        if (isSidebarMode()) {
          xmlIndexedProvider.refresh();
        }

        if (isAnnotationMode()) {
          refreshCodeLenses();
        }

        const count = getIndexedDataForDocument(editor.document).length;
        vscode.window.showInformationMessage(
          `Successfully indexed ${count} XML elements`
        );
      } catch (error) {
        outputChannel?.appendLine(`Error: ${error.message}`);
        vscode.window.showErrorMessage("Failed to index XML elements");
      }
    })
  );

  // Close All Modes
  context.subscriptions.push(
    vscode.commands.registerCommand("xi.closeAllModes", async () => {
      await setInlineMode(false);
      await setSidebarMode(false);
      await setAnnotationMode(false);
      await setNumberMode(false);

      disposeDecoration();

      if (
        xmlIndexedProvider &&
        typeof xmlIndexedProvider.refresh === "function"
      ) {
        xmlIndexedProvider.refresh();
      }

      refreshCodeLenses();

      vscode.window.showInformationMessage(
        "All XML indexing modes have been disabled"
      );
    })
  );

  // Reveal Indexed Line
  context.subscriptions.push(
    vscode.commands.registerCommand("xi.revealIndexedLine", (uri, line) =>
      revealIndexedLine(uri, line)
    )
  );
}

// Event handlers
function registerEventHandlers(context) {
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      outputChannel?.appendLine(
        "[events] onDidChangeActiveTextEditor triggered."
      );
      if (editor) {
        outputChannel?.appendLine(
          `[events] New editor: ${editor.document.uri.toString()}`
        );
        outputChannel?.appendLine(
          `[events] Language: ${editor.document.languageId}`
        );

        const docKey = editor.document.uri.toString();
        // Debounce rapid file switches
        debounceOperation(
          `editor-${docKey}`,
          () => {
            doIndexDisplay();
          },
          200
        );
      }
    })
  );

  // On save
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document === doc) {
        outputChannel?.appendLine(
          "[events] onDidSaveTextDocument triggered for active editor."
        );
        doIndexDisplay();
      }
    })
  );

  // On text change with debounce
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      const editor = vscode.window.activeTextEditor;
      if (
        editor &&
        editor.document === event.document &&
        isXmlDocument(editor.document)
      ) {
        const docKey = event.document.uri.toString();
        const changeSize = event.contentChanges.reduce(
          (sum, change) => sum + change.text.length,
          0
        );

        // Use longer debounce for larger changes
        const delay = changeSize > 1000 ? 800 : 400;

        debounceOperation(
          `change-${docKey}`,
          () => {
            outputChannel?.appendLine(
              "[events] Debounced onDidChangeTextDocument trigger."
            );
            doIndexDisplay();
          },
          delay
        );
      }
    })
  );

  // Handle document closing to clean up cache
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((doc) => {
      const docKey = doc.uri.toString();
      documentCache.delete(docKey);
      lastIndexedVersionMap.delete(docKey);

      // Clear any pending debounced operations
      if (debouncedTimeouts.has(`editor-${docKey}`)) {
        clearTimeout(debouncedTimeouts.get(`editor-${docKey}`));
        debouncedTimeouts.delete(`editor-${docKey}`);
      }
      if (debouncedTimeouts.has(`change-${docKey}`)) {
        clearTimeout(debouncedTimeouts.get(`change-${docKey}`));
        debouncedTimeouts.delete(`change-${docKey}`);
      }

      outputChannel?.appendLine(
        `🗑️ Cleaned up data for closed document: ${doc.fileName}`
      );
    })
  );
}

/**
 * This method is called when the extension is activated
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  try {
    // Initialize global data storage
    globalThis.xmlIndexerData = new Map();

    // Create output channel for debugging
    outputChannel = vscode.window.createOutputChannel("XML Indexer");
    outputChannel.appendLine("🚀 XML Indexer extension is activating...");

    // Initialize global state
    globalState = context.globalState;
    outputChannel.appendLine("✅ State manager initialized");

    // Create and register XML indexed children provider for sidebar
    xmlIndexedProvider = new XmlIndexedChildrenProvider();
    const treeView = vscode.window.createTreeView("xmlIndexedChildren", {
      treeDataProvider: xmlIndexedProvider,
      showCollapseAll: true,
      canSelectMany: false,
    });
    context.subscriptions.push(treeView);
    outputChannel.appendLine("✅ XML tree view registered");

    // Register CodeLens provider for annotations
    registerXmlCodeLensProvider(context);
    outputChannel.appendLine("✅ CodeLens provider registered");

    // Register all commands
    registerCommands(context);
    outputChannel.appendLine("✅ Commands registered");

    // Register event handlers
    registerEventHandlers(context);
    outputChannel.appendLine("✅ Event handlers registered");

    // Show welcome message on first activation
    const isFirstActivation = !context.globalState.get(
      "xmlIndexer.hasShownWelcome",
      false
    );
    if (isFirstActivation) {
      showWelcomeMessage(context);
    }

    // Trigger initial indexing if XML file is already open
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && isXmlDocument(activeEditor.document)) {
      doIndexDisplay();
      outputChannel.appendLine("✅ Initial XML document indexed");
    }

    // Register language detection and provide helpful feedback
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          if (isXmlDocument(editor.document)) {
            outputChannel.appendLine(
              `📄 XML file opened: ${editor.document.fileName}`
            );
            // Auto-index if any mode is enabled
            if (isInlineMode() || isSidebarMode() || isAnnotationMode()) {
              doIndexDisplay();
            }
          } else {
            outputChannel.appendLine(
              `📄 Non-XML file opened: ${editor.document.languageId}`
            );
          }
        }
      })
    );

    outputChannel.appendLine(
      "🎉 XML Indexer extension activated successfully!"
    );
    outputChannel.appendLine(
      '💡 Use Ctrl+Shift+P and search for "XML Indexer" to see available commands'
    );

    // Show current modes status
    logCurrentModes();
  } catch (error) {
    const errorMessage = `❌ Failed to activate XML Indexer extension: ${error.message}`;
    outputChannel?.appendLine(errorMessage);
    console.error(errorMessage, error);
    vscode.window.showErrorMessage(errorMessage);
  }
}

/**
 * Log current active modes for debugging
 */
function logCurrentModes() {
  const modes = [];
  if (isInlineMode()) modes.push("Inline");
  if (isSidebarMode()) modes.push("Sidebar");
  if (isAnnotationMode()) modes.push("Annotation");
  if (isNumberMode()) modes.push("Number");

  if (modes.length > 0) {
    outputChannel?.appendLine(`🔧 Active modes: ${modes.join(", ")}`);
  } else {
    outputChannel?.appendLine("🔧 No modes currently active");
  }
}

/**
 * Show welcome message on first activation
 * @param {vscode.ExtensionContext} context
 */
async function showWelcomeMessage(context) {
  const message =
    "Welcome to XML Indexer! This extension helps you navigate XML documents with multiple viewing modes.";
  const actions = [
    "Show Commands",
    "Enable Inline Mode",
    "Enable Sidebar Mode",
    "Don't Show Again",
  ];

  const choice = await vscode.window.showInformationMessage(
    message,
    ...actions
  );

  switch (choice) {
    case "Show Commands":
      vscode.commands.executeCommand("workbench.action.showCommands");
      setTimeout(() => {
        vscode.commands.executeCommand(
          "workbench.action.quickOpen",
          ">XML Indexer"
        );
      }, 100);
      break;
    case "Enable Inline Mode":
      vscode.commands.executeCommand("xi.toggleInlineMode");
      break;
    case "Enable Sidebar Mode":
      vscode.commands.executeCommand("xi.toggleSidebarMode");
      break;
    case "Don't Show Again":
      context.globalState.update("xmlIndexer.hasShownWelcome", true);
      break;
  }
}

/**
 * This method is called when the extension is deactivated
 */
function deactivate() {
    try {
        outputChannel?.appendLine('🔄 XML Indexer extension is deactivating...');

        // Clear all caches and timeouts
        documentCache.clear();
        debouncedTimeouts.forEach(timeout => clearTimeout(timeout));
        debouncedTimeouts.clear();
        
        // Clear the version map
        lastIndexedVersionMap.clear();

        outputChannel?.appendLine(
            `📊 Final cache stats - Documents: ${documentCache.size}, Timeouts: ${debouncedTimeouts.size}`
        );

        // Dispose decorations
        disposeDecoration();

        // Clear global data
        if (globalThis.xmlIndexerData) {
            globalThis.xmlIndexerData.clear();
        }

        // Log final statistics
        const modes = [];
        if (isInlineMode()) modes.push('Inline');
        if (isSidebarMode()) modes.push('Sidebar');
        if (isAnnotationMode()) modes.push('Annotation');
        if (isNumberMode()) modes.push('Number');

        outputChannel?.appendLine(
            `📊 Extension deactivated. Final active modes: ${modes.join(', ') || 'None'}`
        );

        // Dispose output channel
        if (outputChannel) {
            outputChannel.dispose();
            outputChannel = null;
        }

        console.log('XML Indexer extension deactivated successfully');

    } catch (error) {
        console.error('Error during XML Indexer deactivation:', error);
    }
}

// Export the activate and deactivate functions
module.exports = {
  activate,
  deactivate,
};
