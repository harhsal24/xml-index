// src/utils/stateManager.js

let globalState = null;

function init(gs) {
  globalState = gs;
}

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

module.exports = {
  init,
  isInlineMode, setInlineMode,
  isSidebarMode, setSidebarMode,
  isAnnotationMode, setAnnotationMode,
  isNumberMode, setNumberMode
};
