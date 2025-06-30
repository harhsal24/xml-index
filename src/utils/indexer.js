// src/utils/indexer.js

let lastIndexedData = [];

/**
 * Scan document text for XML tags and populate lastIndexedData.
 * Each entry: { tag, index, offset, line, uri, sequence }.
 */
function scanDocumentForTags(document) {
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
      sequence: seq
    });
  } 

  lastIndexedData = newIndexedData;
}

/**
 * Return the latest indexed entries.
 */
function getLastIndexedData() {
  return lastIndexedData;
}

module.exports = { scanDocumentForTags, getLastIndexedData };
