'use strict';
// Small non-validating XML parser for OOXML parts: elements, attributes and text only.
// DOCTYPE is rejected; entities other than the predefined and numeric ones are left as is.
const {GatewayError} = require('./errors');

const TOKEN = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<!([^>]*)>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
const ATTRIBUTE = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const ENTITIES = {lt: '<', gt: '>', amp: '&', quot: '"', apos: "'"};

function decode(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity] ?? match;
  });
}

function parseXml(source) {
  const root = {name: '#document', attrs: {}, children: []};
  const stack = [root];
  for (const match of source.matchAll(TOKEN)) {
    const [, cdata, declaration, closing, opening, attributes, selfClosing, textValue] = match;
    const parent = stack[stack.length - 1];
    if (declaration !== undefined) {
      if (/^DOCTYPE/i.test(declaration)) throw new GatewayError(422, 'GW-422-NOT-DOCX', 'DOCTYPE is not allowed in DOCX parts');
    } else if (closing !== undefined) {
      if (stack.length > 1) stack.pop();
    } else if (opening !== undefined) {
      const attrs = {};
      for (const [, key, double, single] of (attributes || '').matchAll(ATTRIBUTE)) attrs[key] = decode(double ?? single);
      const node = {name: opening, attrs, children: []};
      parent.children.push(node);
      if (!selfClosing) stack.push(node);
    } else if (cdata !== undefined) {
      parent.children.push({text: cdata});
    } else if (textValue !== undefined) {
      parent.children.push({text: decode(textValue)});
    }
  }
  return root;
}

function* descendants(node) {
  for (const child of node.children || []) {
    if (child.name) {
      yield child;
      yield* descendants(child);
    }
  }
}

function find(node, name) {
  for (const child of descendants(node)) if (child.name === name) return child;
  return null;
}

module.exports = {parseXml, descendants, find};
