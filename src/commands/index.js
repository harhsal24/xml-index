// src/commands/index.js
const toggleInlineMode = require('./toggleInlineMode');
const toggleSidebarMode = require('./toggleSidebarMode');
const toggleAnnotationMode = require('./toggleAnnotationMode');
const toggleNumberMode = require('./toggleNumberMode');
const indexChildrenAll = require('./indexChildrenAll');
const revealCommands = require('./revealCommands');
const closeAllModes = require('./closeAllModes');


function registerAll(context, xmlIndexedProvider, bookmarkProvider) {
  toggleInlineMode.register(context);
  toggleSidebarMode.register(context, xmlIndexedProvider);
  toggleAnnotationMode.register(context);
  toggleNumberMode.register(context);
  indexChildrenAll.register(context, xmlIndexedProvider);
  revealCommands.register(context);
  closeAllModes.register(context, xmlIndexedProvider);
}

module.exports = { registerAll };
