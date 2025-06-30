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
function isInlineMode() {
    return globalState?.get('xiInlineMode', false);
}

function setInlineMode(val) {
    return globalState.update('xiInlineMode', val);
}

function isSidebarMode() {
    return globalState?.get('xiSidebarMode', false);
}

function setSidebarMode(val) {
    return globalState.update('xiSidebarMode', val);
}

function isAnnotationMode() {
    return globalState?.get('xiAnnotationMode', false);
}

function setAnnotationMode(val) {
    return globalState.update('xiAnnotationMode', val);
}

function isNumberMode() {
    return globalState?.get('xiNumberMode', false);
}

function setNumberMode(val) {
    return globalState.update('xiNumberMode', val);
}

// Helper function to check if document is XML
function isXmlDocument(document) {
    if (!document) return false;
    
    // Check language ID
    if (document.languageId === 'xml') return true;
    
    // Check file extension for diff scenarios
    const fileName = document.fileName || document.uri?.fsPath || '';
    if (fileName.match(/\.xml$/i)) return true;
    
    // Check content for XML patterns (first few lines)
    const text = document.getText();
    const firstLines = text.split('\n').slice(0, 5).join('\n');
    
    // Look for XML declaration or common XML patterns
    if (firstLines.match(/<\?xml\s+version/i)) return true;
    if (firstLines.match(/<[a-zA-Z][^>]*>/)) return true;
    
    return false;
}

// Indexer functions
function scanDocumentForTags(document) {
    if (!isXmlDocument(document)) {
        outputChannel?.appendLine(`[indexer] Document is not XML, skipping scan`);
        return;
    }

    const text = document.getText();
    const tagRegex = /<([A-Za-z0-9_:-]+)(\s[^>]*)?>/g;
    const tagCounts = Object.create(null);
    const newIndexedData = [];
    let match;
    let seq = 0;

    while ((match = tagRegex.exec(text)) !== null) {
        seq++;
        const tag = match[1];
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
        const index = tagCounts[tag];
        const offset = match.index;
        const position = document.positionAt(offset);
        newIndexedData.push({
            tag,
            index,
            offset,
            line: position.line,
            uri: document.uri,
            sequence: seq,
            documentId: document.uri.toString() // Add unique document identifier
        });
    }

    // Store indexed data per document
    const docKey = document.uri.toString();
    if (!globalThis.xmlIndexerData) {
        globalThis.xmlIndexerData = new Map();
    }
    globalThis.xmlIndexerData.set(docKey, newIndexedData);
    
    // Update global lastIndexedData for backward compatibility
    lastIndexedData = newIndexedData;
    
    outputChannel?.appendLine(`📊 Indexed ${newIndexedData.length} XML tags for ${docKey}`);
    
    // Debug: Log some sample data
    if (newIndexedData.length > 0) {
        outputChannel?.appendLine(`📝 Sample tag: ${newIndexedData[0].tag} at line ${newIndexedData[0].line}`);
    }
}

function getLastIndexedData() {
    return lastIndexedData;
}

function getIndexedDataForDocument(document) {
    if (!globalThis.xmlIndexerData) {
        return [];
    }
    const docKey = document.uri.toString();
    return globalThis.xmlIndexerData.get(docKey) || [];
}

// Decoration functions
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
            margin: '0 0 0 1em',
            fontStyle: 'italic',
            color: new vscode.ThemeColor('editorCodeLens.foreground')
        }
    });

    const decorations = [];
    const text = doc.getText();
    const entries = getIndexedDataForDocument(doc);

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

        const contentText = numberModeEnabled
            ? `← #${entry.sequence}`
            : `← [${entry.tag} #${entry.index}]`;

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
        outputChannel?.appendLine(`[decoration] Applied ${decorations.length} inline decorations.`);
    } catch (e) {
        outputChannel?.appendLine(`[decoration] Failed to set decorations: ${e.message}`);
    }
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

// CodeLens functions - FIXED FOR DIFF MODE
function refreshCodeLenses() {
    if (codeLensEmitter) {
        codeLensEmitter.fire();
    }
}

function registerXmlCodeLensProvider(context) {
    codeLensEmitter = new vscode.EventEmitter();

    const provider = {
        provideCodeLenses(document, token) {
            outputChannel?.appendLine(`[CodeLens] provideCodeLenses called for: ${document.uri.toString()}`);
            outputChannel?.appendLine(`[CodeLens] Document language: ${document.languageId}`);
            outputChannel?.appendLine(`[CodeLens] Annotation mode: ${isAnnotationMode()}`);
            
            if (!isAnnotationMode()) {
                outputChannel?.appendLine('[CodeLens] Annotation mode disabled, returning empty array');
                return [];
            }

            if (!isXmlDocument(document)) {
                outputChannel?.appendLine('[CodeLens] Document is not XML, returning empty array');
                return [];
            }

            // Get indexed data for this specific document
            const entries = getIndexedDataForDocument(document);
            outputChannel?.appendLine(`[CodeLens] Found ${entries.length} indexed entries for this document`);

            const lenses = [];
            for (const entry of entries) {
                try {
                    const pos = document.positionAt(entry.offset);
                    const range = new vscode.Range(pos, pos);
                    const title = isNumberMode()
                        ? `#${entry.sequence}`
                        : `[${entry.tag} #${entry.index}]`;

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

    // IMPROVED SELECTOR FOR DIFF MODE
    const selectors = [
        { language: 'xml', scheme: '*' },
        { pattern: '**/*.xml', scheme: '*' },
        { scheme: 'vscode-diff' }, // For diff view
        { scheme: 'file' }, // Fallback for file scheme
    ];

    // Register provider for multiple selectors
    selectors.forEach((selector, index) => {
        try {
            const disposable = vscode.languages.registerCodeLensProvider(selector, provider);
            context.subscriptions.push(disposable);
            outputChannel?.appendLine(`[CodeLens] Registered provider ${index + 1} with selector: ${JSON.stringify(selector)}`);
        } catch (error) {
            outputChannel?.appendLine(`[CodeLens] Failed to register provider ${index + 1}: ${error.message}`);
        }
    });

    return provider;
}

// XML Tree Provider - IMPROVED FOR DIFF MODE
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

    getChildren(element) {
        outputChannel?.appendLine(`[TreeProvider] getChildren called. Element: ${element ? element.label : 'root'}`);
        
        if (!isSidebarMode()) {
            outputChannel?.appendLine('[TreeProvider] Sidebar mode is disabled, returning empty array');
            return [];
        }

        if (!element) {
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
            
            const children = entries.map(entry => ({
                label: isNumberMode() 
                    ? `#${entry.sequence} - ${entry.tag}` 
                    : `${entry.tag} [#${entry.index}] (line ${entry.line + 1})`,
                uri: editor.document.uri,
                line: entry.line,
                tag: entry.tag
            }));
            
            outputChannel?.appendLine(`[TreeProvider] Returning ${children.length} children`);
            return children;
        }
        
        return [];
    }
}

// Event handling and display functions - IMPROVED FOR DIFF MODE
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

        // Annotations / CodeLens - FORCE REFRESH
        outputChannel?.appendLine('[events] Refreshing CodeLenses...');
        refreshCodeLenses();
        
        // Additional delay for diff mode
        setTimeout(() => {
            refreshCodeLenses();
            outputChannel?.appendLine('[events] CodeLenses refreshed with delay');
        }, 100);

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

            if (isAnnotationMode()) {
                refreshCodeLenses();
            }
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

    // Toggle Annotation Mode - IMPROVED
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
                
                // Force refresh CodeLenses multiple times for diff mode
                refreshCodeLenses();
                setTimeout(() => refreshCodeLenses(), 100);
                setTimeout(() => refreshCodeLenses(), 500);
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
            if (editor && isXmlDocument(editor.document) && isInlineMode()) {
                scanDocumentForTags(editor.document);
                applyInlineDecorations(editor, true, newVal);
            }
            if (isAnnotationMode()) {
                if (editor && isXmlDocument(editor.document)) {
                    scanDocumentForTags(editor.document);
                }
                refreshCodeLenses();
            }
            if (isSidebarMode() && xmlIndexedProvider) {
                xmlIndexedProvider.refresh();
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

// Event handlers - IMPROVED FOR DIFF MODE
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

    // Additional event for diff mode - when visible text editors change
    context.subscriptions.push(
        vscode.window.onDidChangeVisibleTextEditors(editors => {
            outputChannel?.appendLine(`[events] onDidChangeVisibleTextEditors: ${editors.length} editors`);
            editors.forEach((editor, index) => {
                if (isXmlDocument(editor.document)) {
                    outputChannel?.appendLine(`[events] Visible XML editor ${index}: ${editor.document.uri.toString()}`);
                    scanDocumentForTags(editor.document);
                }
            });
            if (isAnnotationMode()) {
                refreshCodeLenses();
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
}

// Export the activate and deactivate functions
module.exports = {
    activate,
    deactivate
};