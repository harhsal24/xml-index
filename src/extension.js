// src/extension.js
const vscode = require('vscode');

// Global providers and state
let xmlIndexedProvider = null;
let outputChannel = null;
let globalState = null;
let codeLensEmitter = null;
let decorationType = null;
let lastIndexedData = [];

// State management functions
function isInlineMode() { return globalState?.get('xiInlineMode', false); }
function setInlineMode(val) { return globalState.update('xiInlineMode', val); }
function isSidebarMode() { return globalState?.get('xiSidebarMode', false); }
function setSidebarMode(val) { return globalState.update('xiSidebarMode', val); }
function isAnnotationMode() { return globalState?.get('xiAnnotationMode', false); }
function setAnnotationMode(val) { return globalState.update('xiAnnotationMode', val); }
function isNumberMode() { return globalState?.get('xiNumberMode', false); }
function setNumberMode(val) { return globalState.update('xiNumberMode', val); }

// Helper: check if document is XML
function isXmlDocument(document) {
    if (!document) return false;
    if (document.languageId === 'xml') return true;
    const fileName = document.fileName || document.uri?.fsPath || '';
    if (/\.xml$/i.test(fileName)) return true;
    const text = document.getText().slice(0, 200);
    if (/^\s*<\?xml\s+version/i.test(text)) return true;
    if (/^\s*<[^>]+>/.test(text)) return true;
    return false;
}

// Cache document versions to avoid redundant rescans
const lastIndexedVersionMap = new Map();

// Indexer: scan only when parent has multiple same-child tags
function scanDocumentForTags(document) {
    const docKey = document.uri.toString();
    // Skip if version unchanged
    const currentVersion = document.version;
    if (lastIndexedVersionMap.get(docKey) === currentVersion) {
        outputChannel?.appendLine(`📄 Document unchanged (v${currentVersion}); skipping scan.`);
        return;
    }
    lastIndexedVersionMap.set(docKey, currentVersion);

    if (!isXmlDocument(document)) return;
    const text = document.getText();
    const tagRegex = /<\/?([A-Za-z0-9_:-]+)(?:[^>]*)>/g;

    // Track raw matches with parent context via stack
    const raw = [];
    const stack = [];
    let match;
    let id = 0;
    while ((match = tagRegex.exec(text)) !== null) {
        const full = match[0];
        const name = match[1];
        const isClose = /^<\//.test(full);
        const isSelfClose = /\/>$/.test(full) && !isClose;
        if (!isClose) {
            id++;
            const parent = stack.length ? stack[stack.length - 1] : 0;
            raw.push({ id, tag: name, offset: match.index, parent });
            if (!isSelfClose) stack.push(id);
        }
        if (isClose && stack.length) {
            stack.pop();
        }
    }

    // Count occurrences per parent
    const counts = {};
    raw.forEach(({ parent, tag }) => {
        const key = parent;
        counts[key] = counts[key] || {};
        counts[key][tag] = (counts[key][tag] || 0) + 1;
    });

    // Build filtered indexed data with orderInTag and global sequence
    const newData = [];
    const perParentTagOrder = {};
    raw.forEach(entry => {
        const cnt = counts[entry.parent]?.[entry.tag] || 0;
        if (cnt > 1) {
            const pid = entry.parent;
            perParentTagOrder[pid] = perParentTagOrder[pid] || {};
            const order = (perParentTagOrder[pid][entry.tag] || 0) + 1;
            perParentTagOrder[pid][entry.tag] = order;
            const pos = document.positionAt(entry.offset);
            newData.push({
                tag: entry.tag,
                orderInTag: order,
                offset: entry.offset,
                line: pos.line,
                uri: document.uri,
                globalSequence: entry.id,
                documentId: document.uri.toString()
            });
        }
    });

    // Store and output
    const keyDoc = document.uri.toString();
    globalThis.xmlIndexerData = globalThis.xmlIndexerData || new Map();
    globalThis.xmlIndexerData.set(keyDoc, newData);
    lastIndexedData = newData;
    outputChannel?.appendLine(`📊 Indexed ${newData.length} tags (filtered by multi-child rule)`);
}


// Modified decoration function to show order information
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
    
    // Count total occurrences of each tag to show context
    const tagTotals = {};
    entries.forEach(entry => {
        tagTotals[entry.tag] = Math.max(tagTotals[entry.tag] || 0, entry.orderInTag);
    });

    for (const entry of entries) {
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

        // Show order information - only display if there are multiple occurrences
        let contentText;
        const totalCount = tagTotals[entry.tag];
        
        if (totalCount > 1) {
            // Multiple occurrences - show order
            if (numberModeEnabled) {
                contentText = ` ← ${entry.orderInTag}/${totalCount} `;
            } else {
                contentText = ` ← [${entry.tag} ${entry.orderInTag}/${totalCount}] `;
            }
        } else {
            // Single occurrence - minimal display or skip
            if (numberModeEnabled) {
                contentText = ` ← #${entry.globalSequence} `;
            } else {
                contentText = ` ← [${entry.tag}] `;
            }
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
        outputChannel?.appendLine(`[decoration] Applied ${decorations.length} order decorations.`);
    } catch (e) {
        outputChannel?.appendLine(`[decoration] Failed to set decorations: ${e.message}`);
    }
}

// Modified CodeLens provider to show order information
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
            outputChannel?.appendLine(`[CodeLens] Found ${entries.length} indexed entries for this document`);

            // Count total occurrences of each tag
            const tagTotals = {};
            entries.forEach(entry => {
                tagTotals[entry.tag] = Math.max(tagTotals[entry.tag] || 0, entry.orderInTag);
            });

            const lenses = [];
            const processedLines = new Set();

            for (const entry of entries) {
                try {
                    if (processedLines.has(entry.line)) {
                        continue;
                    }
                    processedLines.add(entry.line);

                    const pos = document.positionAt(entry.offset);
                    const range = new vscode.Range(pos, pos);
                    
                    const totalCount = tagTotals[entry.tag];
                    let title;
                    
                    if (totalCount > 1) {
                        // Show order for multiple occurrences
                        title = isNumberMode()
                            ? ` ${entry.orderInTag}/${totalCount}`
                            : ` [${entry.tag} ${entry.orderInTag}/${totalCount}]`;
                    } else {
                        // Single occurrence
                        title = isNumberMode()
                            ? ` #${entry.globalSequence}`
                            : ` [${entry.tag}]`;
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
            
            outputChannel?.appendLine(`[CodeLens] Returning ${lenses.length} code lenses`);
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
    outputChannel?.appendLine(`[CodeLens] Registered CodeLens provider`);

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
            outputChannel?.appendLine(`[decoration] Error disposing decorationType: ${e.message}`);
        }
        decorationType = null;
    }
}

// CodeLens functions - FIXED DUPLICATE ANNOTATIONS
function refreshCodeLenses() {
    if (codeLensEmitter) {
        codeLensEmitter.fire();
    }
}


// XML Tree Provider - IMPROVED WITH DROPDOWN STYLE
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
            // FIXED: Group items with dropdown style
            const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
            item.iconPath = new vscode.ThemeIcon('symbol-namespace');
            item.tooltip = `${element.count} ${element.tagName} elements`;
            return item;
        }

        // Individual element items
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.command = {
            command: 'xi.revealIndexedLine',
            title: 'Go to XML Element',
            arguments: [element.uri, element.line]
        };

                // Enhanced icon mapping for XML elements
        const tagName = element.tag?.toLowerCase() || '';
        
        // Common XML structure elements
        if (tagName.includes('root') || tagName.includes('document')) {
             item.iconPath = new vscode.ThemeIcon('folder');
        } else if (tagName.includes('header') || tagName.includes('head')) {
            item.iconPath = new vscode.ThemeIcon('symbol-method');
        } else if (tagName.includes('body') || tagName.includes('content')) {
            item.iconPath = new vscode.ThemeIcon('symbol-class');
        } else if (tagName.includes('section') || tagName.includes('div') || tagName.includes('container')) {
            item.iconPath = new vscode.ThemeIcon('symbol-structure');
        } else if (tagName.includes('list') || tagName.includes('ul') || tagName.includes('ol')) {
            item.iconPath = new vscode.ThemeIcon('symbol-array');
        } else if (tagName.includes('item') || tagName.includes('li') || tagName.includes('entry')) {
            item.iconPath = new vscode.ThemeIcon('symbol-property');
        } else if (tagName.includes('text') || tagName.includes('p') || tagName.includes('span') || tagName.includes('label')) {
            item.iconPath = new vscode.ThemeIcon('symbol-string');
        } else if (tagName.includes('img') || tagName.includes('image') || tagName.includes('picture')) {
            item.iconPath = new vscode.ThemeIcon('file-media');
        } else if (tagName.includes('link') || tagName.includes('a') || tagName.includes('href')) {
            item.iconPath = new vscode.ThemeIcon('link');
        } else if (tagName.includes('button') || tagName.includes('input') || tagName.includes('form')) {
            item.iconPath = new vscode.ThemeIcon('symbol-event');
        } else if (tagName.includes('table') || tagName.includes('row') || tagName.includes('cell')) {
            item.iconPath = new vscode.ThemeIcon('symbol-field');
        } else if (tagName.includes('config') || tagName.includes('setting') || tagName.includes('property')) {
            item.iconPath = new vscode.ThemeIcon('symbol-constant');
        } else if (tagName.includes('data') || tagName.includes('value') || tagName.includes('field')) {
            item.iconPath = new vscode.ThemeIcon('symbol-variable');
        } else {
            item.iconPath = new vscode.ThemeIcon('symbol-xml');
        }
        item.tooltip = `${element.tag} element at line ${element.line + 1}`;
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
            // FIXED: Root level - create grouped dropdown structure
            const tagGroups = {};
            
            entries.forEach(entry => {
                if (!tagGroups[entry.tag]) {
                    tagGroups[entry.tag] = [];
                }
                tagGroups[entry.tag].push(entry);
            });

            const children = Object.keys(tagGroups).map(tagName => ({
                label: `${tagName} (${tagGroups[tagName].length})`,
                isGroup: true,
                tagName: tagName,
                count: tagGroups[tagName].length,
                entries: tagGroups[tagName]
            }));
            
            outputChannel?.appendLine(`[TreeProvider] Returning ${children.length} tag groups`);
            return children;
        } else if (element.isGroup) {
            // FIXED: Expanded group - show individual elements
            const children = element.entries.map((entry, index) => ({
                label: isNumberMode()
     ? `#${entry.globalSequence} (line ${entry.line + 1})`
     : `${entry.tag} [#${entry.orderInTag}] (line ${entry.line + 1})`,
                uri: editor.document.uri,
                line: entry.line,
                tag: entry.tag,
                isGroup: false
            }));
            
            outputChannel?.appendLine(`[TreeProvider] Returning ${children.length} entries for group ${element.tagName}`);
            return children;
        }
        
        return [];
    }
}

// Event handling and display functions - IMPROVED
function doIndexDisplay() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        outputChannel?.appendLine('[events] No active editor; skipping indexing.');
        return;
    }
    
    if (!isXmlDocument(editor.document)) {
        outputChannel?.appendLine(`[events] Document is not XML (${editor.document.languageId}); disposing decorations.`);
        disposeDecoration();
        return;
    }

    try {
        outputChannel?.appendLine('[events] doIndexDisplay: scanning document for tags...');
        scanDocumentForTags(editor.document);
        const entries = getIndexedDataForDocument(editor.document);
        outputChannel?.appendLine(`[events] scanDocumentForTags found ${entries.length} entries.`);

        // Inline decorations
        if (isInlineMode()) {
            outputChannel?.appendLine('[events] Inline mode is ON; applying inline decorations.');
            applyInlineDecorations(editor, true, isNumberMode());
        } else {
            outputChannel?.appendLine('[events] Inline mode is OFF; disposing decorations.');
            disposeDecoration();
        }

        // Sidebar
        if (isSidebarMode()) {
            outputChannel?.appendLine('[events] Sidebar mode is ON; refreshing sidebar provider.');
            if (xmlIndexedProvider && typeof xmlIndexedProvider.refresh === 'function') {
                xmlIndexedProvider.refresh();
                outputChannel?.appendLine('[events] Sidebar provider refreshed successfully.');
            } else {
                outputChannel?.appendLine('[events] ERROR: xmlIndexedProvider is null or missing refresh method!');
            }
        }

        // Annotations / CodeLens
        if (isAnnotationMode()) {
            outputChannel?.appendLine('[events] Refreshing CodeLenses...');
            refreshCodeLenses();
        }

    } catch (error) {
        outputChannel?.appendLine(`[events] Error during index display: ${error.message}`);
        vscode.window.showErrorMessage('Failed to index XML elements');
    }
}

// Reveal functions
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
        outputChannel?.appendLine(`Error revealing line: ${err.message}`);
    }
}

// Command registration functions
function registerCommands(context) {
    // Toggle Inline Mode
    context.subscriptions.push(
        vscode.commands.registerCommand('xi.toggleInlineMode', async () => {
            const newVal = !isInlineMode();
            await setInlineMode(newVal);

            const editor = vscode.window.activeTextEditor;
            if (editor && isXmlDocument(editor.document)) {
                if (newVal) {
                    scanDocumentForTags(editor.document);
                    applyInlineDecorations(editor, true, isNumberMode());
                } else {
                    disposeDecoration();
                }
            }

            vscode.window.showInformationMessage(`XML Inline indexing ${newVal ? 'enabled' : 'disabled'}`);
        })
    );

    // Toggle Sidebar Mode
    context.subscriptions.push(
        vscode.commands.registerCommand('xi.toggleSidebarMode', async () => {
            const newVal = !isSidebarMode();
            await setSidebarMode(newVal);

            outputChannel?.appendLine(`[Command] Sidebar mode toggled to: ${newVal}`);
            vscode.window.showInformationMessage(`XML Sidebar indexing ${newVal ? 'enabled' : 'disabled'}`);

            if (newVal) {
                const editor = vscode.window.activeTextEditor;
                if (editor && isXmlDocument(editor.document)) {
                    outputChannel?.appendLine('[Command] Scanning document for sidebar mode...');
                    scanDocumentForTags(editor.document);
                }
            }

            if (xmlIndexedProvider && typeof xmlIndexedProvider.refresh === 'function') {
                outputChannel?.appendLine('[Command] Refreshing tree provider...');
                xmlIndexedProvider.refresh();
            } else {
                outputChannel?.appendLine('[Command] ERROR: Tree provider not available!');
            }
        })
    );

    // Toggle Annotation Mode
    context.subscriptions.push(
        vscode.commands.registerCommand('xi.toggleAnnotationMode', async () => {
            const newVal = !isAnnotationMode();
            await setAnnotationMode(newVal);

            outputChannel?.appendLine(`[Command] Annotation mode toggled to: ${newVal}`);
            vscode.window.showInformationMessage(`XML Annotation indexing ${newVal ? 'enabled' : 'disabled'}`);

            const editor = vscode.window.activeTextEditor;
            if (editor && isXmlDocument(editor.document)) {
                if (newVal) {
                    outputChannel?.appendLine('[Command] Scanning document for annotation mode...');
                    scanDocumentForTags(editor.document);
                }
                refreshCodeLenses();
            }
        })
    );

    // Toggle Number Mode
    context.subscriptions.push(
        vscode.commands.registerCommand('xi.toggleNumberMode', async () => {
            const newVal = !isNumberMode();
            await setNumberMode(newVal);

            vscode.window.showInformationMessage(`XML Number-only mode ${newVal ? 'enabled' : 'disabled'}`);

            const editor = vscode.window.activeTextEditor;
            if (editor && isXmlDocument(editor.document)) {
                if (isInlineMode()) {
                    scanDocumentForTags(editor.document);
                    applyInlineDecorations(editor, true, newVal);
                }
                if (isAnnotationMode()) {
                    scanDocumentForTags(editor.document);
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
        vscode.commands.registerCommand('xi.indexChildrenAll', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || !isXmlDocument(editor.document)) {
                vscode.window.showErrorMessage('Please open an XML file first');
                return;
            }
            try {
                scanDocumentForTags(editor.document);

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
                vscode.window.showInformationMessage(`Successfully indexed ${count} XML elements`);
            } catch (error) {
                outputChannel?.appendLine(`Error: ${error.message}`);
                vscode.window.showErrorMessage('Failed to index XML elements');
            }
        })
    );

    // Close All Modes
    context.subscriptions.push(
        vscode.commands.registerCommand('xi.closeAllModes', async () => {
            await setInlineMode(false);
            await setSidebarMode(false);
            await setAnnotationMode(false);
            await setNumberMode(false);

            disposeDecoration();

            if (xmlIndexedProvider && typeof xmlIndexedProvider.refresh === 'function') {
                xmlIndexedProvider.refresh();
            }

            refreshCodeLenses();

            vscode.window.showInformationMessage('All XML indexing modes have been disabled');
        })
    );

    // Reveal Indexed Line
    context.subscriptions.push(
        vscode.commands.registerCommand('xi.revealIndexedLine', (uri, line) => revealIndexedLine(uri, line))
    );
}

// Event handlers
function registerEventHandlers(context) {
    let updateTimeout = null;

    // On active editor change
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            outputChannel?.appendLine('[events] onDidChangeActiveTextEditor triggered.');
            if (editor) {
                outputChannel?.appendLine(`[events] New editor: ${editor.document.uri.toString()}`);
                outputChannel?.appendLine(`[events] Language: ${editor.document.languageId}`);
            }
            doIndexDisplay();
        })
    );

    // On save
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(doc => {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document === doc) {
                outputChannel?.appendLine('[events] onDidSaveTextDocument triggered for active editor.');
                doIndexDisplay();
            }
        })
    );

    // On text change with debounce
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(event => {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document === event.document && isXmlDocument(editor.document)) {
                if (updateTimeout) {
                    clearTimeout(updateTimeout);
                }
                updateTimeout = setTimeout(() => {
                    outputChannel?.appendLine('[events] Debounced onDidChangeTextDocument trigger.');
                    doIndexDisplay();
                }, 500);
            }
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
        outputChannel = vscode.window.createOutputChannel('XML Indexer');
        outputChannel.appendLine('🚀 XML Indexer extension is activating...');

        // Initialize global state
        globalState = context.globalState;
        outputChannel.appendLine('✅ State manager initialized');

        // Create and register XML indexed children provider for sidebar
        xmlIndexedProvider = new XmlIndexedChildrenProvider();
        const treeView = vscode.window.createTreeView('xmlIndexedChildren', {
            treeDataProvider: xmlIndexedProvider,
            showCollapseAll: true,
            canSelectMany: false
        });
        context.subscriptions.push(treeView);
        outputChannel.appendLine('✅ XML tree view registered');

        // Register CodeLens provider for annotations
        registerXmlCodeLensProvider(context);
        outputChannel.appendLine('✅ CodeLens provider registered');

        // Register all commands
        registerCommands(context);
        outputChannel.appendLine('✅ Commands registered');

        // Register event handlers
        registerEventHandlers(context);
        outputChannel.appendLine('✅ Event handlers registered');

        // Show welcome message on first activation
        const isFirstActivation = !context.globalState.get('xmlIndexer.hasShownWelcome', false);
        if (isFirstActivation) {
            showWelcomeMessage(context);
        }

        // Trigger initial indexing if XML file is already open
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && isXmlDocument(activeEditor.document)) {
            doIndexDisplay();
            outputChannel.appendLine('✅ Initial XML document indexed');
        }

        // Register language detection and provide helpful feedback
        context.subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor(editor => {
                if (editor) {
                    if (isXmlDocument(editor.document)) {
                        outputChannel.appendLine(`📄 XML file opened: ${editor.document.fileName}`);
                        // Auto-index if any mode is enabled
                        if (isInlineMode() || isSidebarMode() || isAnnotationMode()) {
                            doIndexDisplay();
                        }
                    } else {
                        outputChannel.appendLine(`📄 Non-XML file opened: ${editor.document.languageId}`);
                    }
                }
            })
        );

        outputChannel.appendLine('🎉 XML Indexer extension activated successfully!');
        outputChannel.appendLine('💡 Use Ctrl+Shift+P and search for "XML Indexer" to see available commands');

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
    if (isInlineMode()) modes.push('Inline');
    if (isSidebarMode()) modes.push('Sidebar');
    if (isAnnotationMode()) modes.push('Annotation');
    if (isNumberMode()) modes.push('Number');
    
    if (modes.length > 0) {
        outputChannel?.appendLine(`🔧 Active modes: ${modes.join(', ')}`);
    } else {
        outputChannel?.appendLine('🔧 No modes currently active');
    }
}

/**
 * Show welcome message on first activation
 * @param {vscode.ExtensionContext} context 
 */
async function showWelcomeMessage(context) {
    const message = 'Welcome to XML Indexer! This extension helps you navigate XML documents with multiple viewing modes.';
    const actions = ['Show Commands', 'Enable Inline Mode', 'Enable Sidebar Mode', 'Don\'t Show Again'];
    
    const choice = await vscode.window.showInformationMessage(message, ...actions);
    
    switch (choice) {
        case 'Show Commands':
            vscode.commands.executeCommand('workbench.action.showCommands');
            setTimeout(() => {
                vscode.commands.executeCommand('workbench.action.quickOpen', '>XML Indexer');
            }, 100);
            break;
        case 'Enable Inline Mode':
            vscode.commands.executeCommand('xi.toggleInlineMode');
            break;
        case 'Enable Sidebar Mode':
            vscode.commands.executeCommand('xi.toggleSidebarMode');
            break;
        case 'Don\'t Show Again':
            context.globalState.update('xmlIndexer.hasShownWelcome', true);
            break;
    }
}

/**
 * This method is called when the extension is deactivated
 */
function deactivate() {
    try {
        outputChannel?.appendLine('🔄 XML Indexer extension is deactivating...');

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
        
        outputChannel?.appendLine(`📊 Extension deactivated. Final active modes: ${modes.join(', ') || 'None'}`);

        // Dispose output channel
        if (outputChannel) {
            outputChannel.dispose();
            outputChannel = null;
        }

        console.log('XML Indexer extension deactivated successfully');

    } catch (error) {
        console.error('Error during XML Indexer deactivation:', error);
    }
    vscode.workspace.onDidCloseTextDocument(doc => {
  lastIndexedVersionMap.delete(doc.uri.toString());
});
}

// Export the activate and deactivate functions
module.exports = {
    activate,
    deactivate
};