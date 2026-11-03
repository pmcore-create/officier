'use strict';
// Print copy of a QMS document: its text without review markup. The document server prints tracked
// changes the way the editor shows them (deleted text struck out, inserted text underlined in the
// author's colour), so the PDF is made from a copy where every tracked change is resolved:
// - suggestions of route participants (stamp R<n>.S<m>) are decided only by the owner (QMS logic 5.4),
//   so the ones still in the file are rejected;
// - the owner's own changes, tracked after a return so that the route sees them, and changes made
//   outside the route (Word, the previous editor) are the owner's text and are accepted.
const {readZip, writeZip} = require('./zip');
const {parseXml, serializeXml} = require('./xml');
const {parseAuthor} = require('./review');

const STORY_PART = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;
const TRACKED = /<w:(?:ins|del|moveFrom|moveTo|\w+Change)\b/;
const MOVE_RANGES = new Set(['w:moveFromRangeStart', 'w:moveFromRangeEnd', 'w:moveToRangeStart', 'w:moveToRangeEnd']);
// A deleted run keeps its text in w:delText; restored, it is ordinary text again.
const RESTORED = {'w:delText': 'w:t', 'w:delInstrText': 'w:instrText'};
const PROPERTIES = new Set(['w:rPr', 'w:pPr', 'w:trPr', 'w:tblPr', 'w:tcPr', 'w:sectPr', 'w:tblGrid', 'w:tblPrEx']);
// A formatting change holds the previous properties; rejected, they replace the current ones,
// except the parts they do not describe. w:numberingChange keeps only a display string: accepted.
const FORMAT_CHANGES = new Set(['w:rPrChange', 'w:pPrChange', 'w:sectPrChange', 'w:tblPrChange', 'w:trPrChange', 'w:tcPrChange', 'w:tblGridChange', 'w:tblPrExChange', 'w:numberingChange']);
const KEPT_ON_REJECT = {'w:pPrChange': {before: [], after: ['w:rPr', 'w:sectPr']}, 'w:sectPrChange': {before: ['w:headerReference', 'w:footerReference'], after: []}};

const isElement = (node, name) => node.name === name;
const child = (node, name) => node && node.children.find(item => isElement(item, name));

function restore(node) {
  return node.name ? {...node, name: RESTORED[node.name] || node.name, children: node.children.map(restore)} : node;
}

function resolver(counts) {
  const keep = change => {
    const accepted = parseAuthor(change.attrs['w:author'] || '').role !== 'PARTICIPANT';
    counts[accepted ? 'accepted' : 'rejected']++;
    return accepted;
  };

  // The paragraph mark goes when its deletion is accepted or its insertion rejected: the text then
  // joins the next paragraph, as in the editor. A mark that ends a section stays.
  function markGone(paragraph) {
    const properties = child(paragraph, 'w:pPr');
    const mark = child(properties, 'w:rPr');
    if (!mark || child(properties, 'w:sectPr')) return false;
    const deleted = child(mark, 'w:del');
    const inserted = child(mark, 'w:ins');
    return !!(deleted && keep(deleted)) || !!(inserted && !keep(inserted));
  }

  function resolveFormat(properties) {
    const change = properties.children.find(item => FORMAT_CHANGES.has(item.name));
    if (!change) return properties;
    const rest = properties.children.filter(item => item !== change);
    if (keep(change) || isElement(change, 'w:numberingChange')) return {...properties, children: rest};
    const previous = change.children.find(item => item.name);
    const kept = KEPT_ON_REJECT[change.name] || {before: [], after: []};
    const pick = names => rest.filter(item => names.includes(item.name));
    return {...properties, children: [...pick(kept.before), ...(previous ? previous.children : []), ...pick(kept.after)]};
  }

  function rowGone(row) {
    const properties = child(row, 'w:trPr');
    const deleted = child(properties, 'w:del');
    const inserted = child(properties, 'w:ins');
    return !!(deleted && keep(deleted)) || !!(inserted && !keep(inserted));
  }

  function resolve(children) {
    const out = [];
    for (const node of children) {
      if (!node.name) {
        out.push(node);
      } else if (isElement(node, 'w:ins') || isElement(node, 'w:moveTo') || isElement(node, 'w:del') || isElement(node, 'w:moveFrom')) {
        // Empty ones are the paragraph mark and row markers, decided with their paragraph or row.
        if (!node.children.length) continue;
        const inserted = isElement(node, 'w:ins') || isElement(node, 'w:moveTo');
        if (keep(node) === inserted) out.push(...resolve(inserted ? node.children : node.children.map(restore)));
      } else if (MOVE_RANGES.has(node.name)) {
        continue;
      } else if (isElement(node, 'w:p')) {
        const join = markGone(node);
        out.push({...node, children: resolve(node.children), join});
      } else if (isElement(node, 'w:tr')) {
        if (!rowGone(node)) out.push({...node, children: resolve(node.children)});
      } else {
        let resolved = {...node, children: resolve(node.children)};
        if (PROPERTIES.has(node.name)) resolved = resolveFormat(resolved);
        // A table whose every row was removed goes with them.
        if (isElement(node, 'w:tbl') && !child(resolved, 'w:tr')) continue;
        out.push(resolved);
      }
    }
    return joinParagraphs(out);
  }

  return resolve;
}

// Content of a paragraph that lost its mark moves to the start of the next paragraph, which keeps its
// own properties; before a table or at the end of a cell the paragraph stays as it is.
function joinParagraphs(nodes) {
  const out = [];
  let carry = null;
  for (const node of nodes) {
    if (!isElement(node, 'w:p')) {
      if (carry && node.name) {
        out.push(carry.paragraph);
        carry = null;
      }
      out.push(node);
      continue;
    }
    const {join, ...paragraph} = node;
    if (carry) {
      const start = paragraph.children.findIndex(item => isElement(item, 'w:pPr')) + 1;
      paragraph.children = [...paragraph.children.slice(0, start), ...carry.content, ...paragraph.children.slice(start)];
      carry = null;
    }
    if (join) {
      carry = {paragraph, content: paragraph.children.filter(item => !isElement(item, 'w:pPr'))};
      continue;
    }
    out.push(paragraph);
  }
  if (carry) out.push(carry.paragraph);
  return out;
}

// @return {buffer, accepted, rejected}: the copy, and how many tracked changes were accepted and rejected
function printCopy(buffer) {
  const zip = readZip(buffer);
  const names = zip.names();
  const counts = {accepted: 0, rejected: 0};
  const changed = new Map();
  for (const name of names.filter(item => STORY_PART.test(item))) {
    const xml = zip.readText(name);
    if (!TRACKED.test(xml)) continue;
    const root = parseXml(xml);
    root.children = resolver(counts)(root.children);
    changed.set(name, Buffer.from(serializeXml(root), 'utf8'));
  }
  if (!changed.size) return {buffer, ...counts};
  return {buffer: writeZip(names.map(name => [name, changed.get(name) || zip.read(name)])), ...counts};
}

module.exports = {printCopy};
