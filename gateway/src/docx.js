'use strict';
// Approved version of a QMS document (QMS logic, section 6.1). The source DOCX is frozen without
// review-time artefacts: comments (immutable in the editor, they would follow the document into its
// next version), fragment locks and empty tracked insertions the editor leaves at the cursor.
// The print copy gets an approval sheet: code, edition, every decision and the source SHA-256.
const crypto = require('crypto');
const {readZip, writeZip} = require('./zip');
const {GatewayError} = require('./errors');

const STORY_PART = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;
// Comments on text, and the editor's comments on the whole document (owner decisions among them).
const COMMENT_PARTS = ['word/comments.xml', 'word/commentsExtended.xml', 'word/commentsIds.xml', 'word/commentsExtensible.xml',
  'word/commentsDocument.xml', 'word/commentsExtendedDocument.xml', 'word/commentsIdsDocument.xml', 'word/commentsExtensibleDocument.xml', 'word/peopleDocument.xml'];
const COMMENT_RELS = /^word\/_rels\/comments\w*\.xml\.rels$/;
const COMMENT_MARKER = /<w:comment(?:RangeStart|RangeEnd|Reference)\b[^>]*\/>/g;
// <w:ins …> holding only empty runs; a self-closing <w:ins/> (paragraph mark) is a real change.
const ATTRIBUTES = '(?:[^>/]|\\/(?!>))*';
const EMPTY_INSERTION = new RegExp(`<w:ins\\b${ATTRIBUTES}>(?:\\s*<w:r\\b${ATTRIBUTES}(?:\\/>|>\\s*<\\/w:r>))*\\s*<\\/w:ins>`, 'g');
const SDT = /<w:sdt(?:\s[^>]*)?>|<\/w:sdt>/g;
const LOCK_TAG = /<w:tag\s+w:val="qms-lock\|/;
const DEFAULT_TEXT_WIDTH = 9638; // A4 with 2 cm margins, twips

function invalid(message) {
  return new GatewayError(422, 'GW-422-NOT-DOCX', message);
}

const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

// Replaces every lock content control with its content; content controls may nest.
function unwrapLocks(xml) {
  const roots = [];
  const stack = [];
  for (const match of xml.matchAll(SDT)) {
    if (match[0] === '</w:sdt>') {
      const node = stack.pop();
      if (!node) throw invalid('Unbalanced content controls in the document');
      node.end = match.index + match[0].length;
      (stack.length ? stack[stack.length - 1].children : roots).push(node);
    } else {
      stack.push({start: match.index, openEnd: match.index + match[0].length, children: []});
    }
  }
  if (stack.length) throw invalid('Unbalanced content controls in the document');

  let count = 0;
  const render = (from, to, children) => {
    let out = '';
    let position = from;
    for (const child of children) {
      out += xml.slice(position, child.start) + renderNode(child);
      position = child.end;
    }
    return out + xml.slice(position, to);
  };
  const renderNode = node => {
    let contentOpen = xml.indexOf('<w:sdtContent', node.openEnd);
    if (contentOpen > node.end) contentOpen = -1;
    if (!LOCK_TAG.test(xml.slice(node.start, contentOpen < 0 ? node.end : contentOpen))) return render(node.start, node.end, node.children);
    count++;
    if (contentOpen < 0) return '';
    const contentStart = xml.indexOf('>', contentOpen) + 1;
    if (xml[contentStart - 2] === '/') return '';
    // Search inside this control: the parent's closing tag may start right where this one ends.
    const contentEnd = xml.lastIndexOf('</w:sdtContent>', node.end - '</w:sdt>'.length - '</w:sdtContent>'.length);
    return render(contentStart, contentEnd, node.children);
  };
  return {xml: render(0, xml.length, roots), count};
}

function countMatches(text, pattern) {
  return (text.match(pattern) || []).length;
}

// Relationship targets are relative to the part's folder unless absolute.
function relationshipTarget(target) {
  return target.startsWith('/') ? target.slice(1) : `word/${target}`;
}

// Drops the relationships and content types of the removed comment parts.
function dropCommentReferences(parts) {
  const rels = parts.get('word/_rels/document.xml.rels');
  if (rels) {
    parts.set('word/_rels/document.xml.rels', rels.replace(/<Relationship\b[^>]*\/>/g, item => {
      const target = /\bTarget="([^"]*)"/.exec(item);
      return target && COMMENT_PARTS.includes(relationshipTarget(target[1])) ? '' : item;
    }));
  }
  const types = parts.get('[Content_Types].xml');
  if (types) {
    parts.set('[Content_Types].xml', types.replace(/<Override\b[^>]*\/>/g, item => {
      const part = /\bPartName="\/([^"]*)"/.exec(item);
      return part && COMMENT_PARTS.includes(part[1]) ? '' : item;
    }));
  }
}

function escapeXml(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function run(text, {bold = false, size} = {}) {
  const properties = (bold ? '<w:b/><w:bCs/>' : '') + (size ? `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` : '');
  return `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ''}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

function paragraph(runs, {align, pageBreakBefore = false, before = 0, after = 120, keepNext = false} = {}) {
  const properties = (keepNext ? '<w:keepNext/>' : '') + (pageBreakBefore ? '<w:pageBreakBefore/>' : '') +
    `<w:spacing w:before="${before}" w:after="${after}"/>` + (align ? `<w:jc w:val="${align}"/>` : '');
  return `<w:p><w:pPr>${properties}</w:pPr>${runs}</w:p>`;
}

function formatDate(value, timeZone) {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) return `${dateOnly[3]}.${dateOnly[2]}.${dateOnly[1]}`;
  return new Intl.DateTimeFormat('ru-RU', {timeZone, day: '2-digit', month: '2-digit', year: 'numeric'}).format(new Date(value));
}

// Text width of the last section, so the table spans exactly the printable area.
function textWidth(sectPr) {
  const page = /<w:pgSz\b[^>]*\bw:w="(\d+)"/.exec(sectPr);
  const left = /<w:pgMar\b[^>]*\bw:left="(\d+)"/.exec(sectPr);
  const right = /<w:pgMar\b[^>]*\bw:right="(\d+)"/.exec(sectPr);
  const width = page && left && right ? Number(page[1]) - Number(left[1]) - Number(right[1]) : 0;
  return width > 2000 ? width : DEFAULT_TEXT_WIDTH;
}

// "Нормоконтроль" and "14.10.2026" must fit on one line at 10 pt on a portrait A4.
const COLUMNS = [['№', 0.05], ['ФИО', 0.2], ['Должность', 0.22], ['Этап', 0.21], ['Решение', 0.19], ['Дата', 0.13]];

function approvalSheet({code, name, versionNo, approvals, sourceSha256, timeZone}, width) {
  const widths = COLUMNS.map(([, share]) => Math.floor(width * share));
  const border = side => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`;
  const cell = (index, content, header = false) =>
    `<w:tc><w:tcPr><w:tcW w:w="${widths[index]}" w:type="dxa"/>${header ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' : ''}</w:tcPr>${content}</w:tc>`;
  const cellText = (text, options) => paragraph(run(text, {size: 20, ...options}), {after: 0});
  const header = `<w:tr><w:trPr><w:tblHeader/><w:cantSplit/></w:trPr>${COLUMNS.map(([title], index) => cell(index, cellText(title, {bold: true}), true)).join('')}</w:tr>`;
  const rows = approvals.map((item, index) => {
    const decision = cellText(item.decision) + (item.comment ? paragraph(run(item.comment, {size: 18}), {after: 0}) : '');
    return `<w:tr><w:trPr><w:cantSplit/></w:trPr>${[
      cell(0, cellText(String(index + 1))),
      cell(1, cellText(item.name)),
      cell(2, cellText(item.position || '')),
      cell(3, cellText(item.stage || '')),
      cell(4, decision),
      cell(5, cellText(formatDate(item.date, timeZone)))
    ].join('')}</w:tr>`;
  });
  const table = '<w:tbl><w:tblPr>' +
    `<w:tblW w:w="${widths.reduce((sum, value) => sum + value, 0)}" w:type="dxa"/>` +
    `<w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders>` +
    '<w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar>' +
    `</w:tblPr><w:tblGrid>${widths.map(value => `<w:gridCol w:w="${value}"/>`).join('')}</w:tblGrid>${header}${rows.join('')}</w:tbl>`;
  return paragraph(run('ЛИСТ СОГЛАСОВАНИЯ', {bold: true, size: 28}), {align: 'center', pageBreakBefore: true, after: 240, keepNext: true}) +
    paragraph(run(name, {bold: true}), {align: 'center', after: 60, keepNext: true}) +
    paragraph(run(`${code}, ред. ${versionNo}`), {align: 'center', after: 240, keepNext: true}) +
    table +
    paragraph(run(`Исходный файл DOCX, SHA-256: ${sourceSha256}`, {size: 16}), {before: 240, after: 0});
}

// The approval sheet goes before the body's own section properties, i.e. into the last section.
function appendToBody(xml, fragment) {
  const bodyEnd = xml.lastIndexOf('</w:body>');
  if (bodyEnd < 0) throw invalid('word/document.xml has no body');
  const sectionStart = xml.lastIndexOf('<w:sectPr', bodyEnd);
  const tail = sectionStart < 0 ? '' : xml.slice(sectionStart, bodyEnd);
  const bodySection = /^<w:sectPr\b(?:[^>]*\/>|[\s\S]*<\/w:sectPr>)\s*$/.test(tail);
  const at = bodySection ? sectionStart : bodyEnd;
  return {xml: xml.slice(0, at) + fragment + xml.slice(at), sectPr: bodySection ? tail : ''};
}

function prepareApproval(buffer, {keepComments = false, keepLocks = false, sheet}) {
  const zip = readZip(buffer);
  const names = zip.names();
  if (!names.includes('word/document.xml')) throw invalid('word/document.xml is missing');
  // Changed parts as text; null removes a part; parts not listed are copied as they are.
  const parts = new Map();
  const removed = {comments: 0, locks: 0, emptyInsertions: 0};
  const comments = ['word/comments.xml', 'word/commentsDocument.xml'].map(name => zip.readText(name) || '').join('');
  if (!keepComments && names.some(name => COMMENT_PARTS.includes(name))) {
    removed.comments = countMatches(comments, /<w:comment\b/g);
    for (const name of names.filter(item => COMMENT_PARTS.includes(item) || COMMENT_RELS.test(item))) parts.set(name, null);
    for (const name of ['word/_rels/document.xml.rels', '[Content_Types].xml']) {
      const text = zip.readText(name);
      if (text !== null) parts.set(name, text);
    }
    dropCommentReferences(parts);
  }
  for (const name of names.filter(item => STORY_PART.test(item))) {
    let xml = zip.readText(name);
    if (!keepComments) xml = xml.replace(COMMENT_MARKER, '');
    if (!keepLocks) {
      const unwrapped = unwrapLocks(xml);
      removed.locks += unwrapped.count;
      xml = unwrapped.xml;
    }
    removed.emptyInsertions += countMatches(xml, EMPTY_INSERTION);
    parts.set(name, xml.replace(EMPTY_INSERTION, ''));
  }

  const write = overrides => writeZip(names
    .filter(name => parts.get(name) !== null)
    .map(name => {
      const value = overrides.has(name) ? overrides.get(name) : parts.get(name);
      return [name, value === undefined ? zip.read(name) : Buffer.from(value, 'utf8')];
    }));
  const source = write(new Map());
  const sourceSha256 = sha256(source);
  const documentXml = parts.get('word/document.xml');
  const sheetXml = approvalSheet({...sheet, sourceSha256}, textWidth(appendToBody(documentXml, '').sectPr));
  const print = write(new Map([['word/document.xml', appendToBody(documentXml, sheetXml).xml]]));
  return {source, sourceSha256, print, removed};
}

module.exports = {prepareApproval, unwrapLocks, approvalSheet, appendToBody, formatDate, sha256};
