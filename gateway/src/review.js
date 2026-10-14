'use strict';
// Review report of a DOCX: tracked changes (suggestions) and comment threads with their authors.
// Everything present in the file is unresolved: accepted/rejected changes leave no trace in DOCX,
// so the portal keeps history by storing a report after every save (QMS logic, section 5).
const crypto = require('crypto');
const {readZip} = require('./zip');
const {parseXml, descendants, find} = require('./xml');
const {GatewayError} = require('./errors');

const NBSP = '\u00a0';
const STAMP = /^R(\d+)\.(?:S(\d+)|OWNER)$/;
const PROPERTY_ELEMENTS = new Set(['w:pPr', 'w:rPr', 'w:trPr', 'w:tblPr', 'w:tcPr', 'w:sectPr', 'w:tblGrid', 'w:tblPrEx']);
const FORMAT_CHANGES = new Set(['w:rPrChange', 'w:pPrChange', 'w:sectPrChange', 'w:tblPrChange', 'w:trPrChange', 'w:tcPrChange', 'w:tblGridChange', 'w:numberingChange', 'w:tblPrExChange']);
const CONTEXT_LENGTH = 200;

// "R2.S1<NBSP>Иванов И. И." -> stamp written by the gateway policy (user.group) and display name.
function parseAuthor(raw = '', userIds = new Map()) {
  const separator = raw.indexOf(NBSP);
  const groups = separator > -1 ? raw.slice(0, separator).split(',').map(group => group.trim()) : [];
  const stamp = groups.find(group => STAMP.test(group)) || null;
  const [, round, stageNo] = stamp ? STAMP.exec(stamp) : [];
  return {
    raw,
    name: separator > -1 ? raw.slice(separator + 1) : raw,
    userId: userIds.get(raw) || null,
    stamp,
    round: stamp ? Number(round) : null,
    stageNo: stageNo ? Number(stageNo) : null,
    // Reviewers and signers share the stage stamp; the portal knows the stage type from the route.
    role: stamp ? (stageNo ? 'PARTICIPANT' : 'OWNER') : null
  };
}

function runText(run) {
  let value = '';
  for (const node of descendants(run)) {
    if (node.name === 'w:t' || node.name === 'w:delText') value += node.children.map(child => child.text || '').join('');
    else if (node.name === 'w:tab') value += '\t';
    else if (node.name === 'w:br' || node.name === 'w:cr') value += '\n';
    else if (node.name === 'w:noBreakHyphen') value += '-';
  }
  return value;
}

function change(node) {
  return {author: node.attrs['w:author'] || '', date: node.attrs['w:date'] || null, userId: node.attrs['oouserid'] || null};
}

// Flattens one story part into ordered segments: normal text, insertions, deletions, format changes.
function collectSegments(part, root, ranges) {
  const segments = [];
  let paragraph = -1;
  const open = new Set();

  function emit(segment) {
    segments.push({part, paragraph, ...segment});
    if (segment.kind !== 'DELETE' && segment.kind !== 'FORMAT' && segment.text) {
      for (const id of open) ranges.set(id, (ranges.get(id) || '') + segment.text);
    }
  }

  function formatChanges(properties, text) {
    if (!properties) return;
    for (const node of properties.children) {
      if (FORMAT_CHANGES.has(node.name)) emit({kind: 'FORMAT', ...change(node), text, scope: node.name.slice(2)});
    }
  }

  function walk(node, tracked) {
    for (const child of node.children) {
      if (!child.name || PROPERTY_ELEMENTS.has(child.name) || child.name === 'mc:Fallback') continue;
      switch (child.name) {
        case 'w:p': {
          paragraph++;
          const first = segments.length;
          const properties = child.children.find(item => item.name === 'w:pPr');
          walk(child, tracked);
          const markProperties = properties && properties.children.find(item => item.name === 'w:rPr');
          const markInserted = markProperties && markProperties.children.find(item => item.name === 'w:ins');
          const markDeleted = markProperties && markProperties.children.find(item => item.name === 'w:del');
          if (markInserted) emit({kind: 'INSERT', ...change(markInserted), text: '\n', scope: 'paragraph'});
          else if (markDeleted) emit({kind: 'DELETE', ...change(markDeleted), text: '\n', scope: 'paragraph'});
          else emit({kind: tracked ? tracked.kind : 'normal', ...(tracked || {}), text: '\n'});
          const paragraphText = segments.slice(first).filter(item => item.kind !== 'DELETE' && item.kind !== 'FORMAT').map(item => item.text).join('');
          formatChanges(properties, paragraphText.trim());
          formatChanges(markProperties, paragraphText.trim());
          for (let i = first; i < segments.length; i++) segments[i].context = paragraphText.trim().slice(0, CONTEXT_LENGTH);
          break;
        }
        case 'w:ins':
        case 'w:moveTo':
          walk(child, {kind: 'INSERT', ...change(child), move: child.name === 'w:moveTo'});
          break;
        case 'w:del':
        case 'w:moveFrom':
          walk(child, {kind: 'DELETE', ...change(child), move: child.name === 'w:moveFrom'});
          break;
        case 'w:r': {
          const text = runText(child);
          emit(tracked ? {...tracked, text} : {kind: 'normal', text});
          formatChanges(child.children.find(item => item.name === 'w:rPr'), text);
          break;
        }
        case 'w:tr': {
          const properties = child.children.find(item => item.name === 'w:trPr');
          const rowInserted = properties && properties.children.find(item => item.name === 'w:ins');
          const rowDeleted = properties && properties.children.find(item => item.name === 'w:del');
          if (rowInserted) emit({kind: 'INSERT', ...change(rowInserted), text: '', scope: 'table-row'});
          if (rowDeleted) emit({kind: 'DELETE', ...change(rowDeleted), text: '', scope: 'table-row'});
          formatChanges(properties, '');
          walk(child, tracked);
          break;
        }
        case 'w:tbl':
          formatChanges(child.children.find(item => item.name === 'w:tblPr'), '');
          formatChanges(child.children.find(item => item.name === 'w:tblGrid'), '');
          walk(child, tracked);
          break;
        case 'w:tc':
          formatChanges(child.children.find(item => item.name === 'w:tcPr'), '');
          walk(child, tracked);
          break;
        case 'w:commentRangeStart':
          open.add(child.attrs['w:id']);
          break;
        case 'w:commentRangeEnd':
          open.delete(child.attrs['w:id']);
          break;
        default:
          walk(child, tracked);
      }
    }
  }

  walk(root, null);
  const body = find(root, 'w:body');
  if (body) formatChanges(body.children.find(item => item.name === 'w:sectPr'), '');
  return segments;
}

// Adjacent pieces of one author form one suggestion; a deletion next to an insertion is a replacement.
function groupSuggestions(segments, userIds) {
  const suggestions = [];
  const formats = new Map();
  let current = null;
  for (const segment of segments) {
    if (segment.kind === 'normal') {
      if (segment.text) current = null;
      continue;
    }
    if (segment.kind === 'FORMAT') {
      // One formatting action of one author carries one timestamp within a paragraph.
      const key = [segment.author, segment.date, segment.part, segment.paragraph, segment.scope].join('\u0001');
      const existing = formats.get(key);
      if (existing) {
        existing.textAfter += segment.text;
      } else {
        const item = suggestion('FORMAT', segment, userIds, {textAfter: segment.text, scope: segment.scope});
        formats.set(key, item);
        suggestions.push(item);
      }
      continue;
    }
    const field = segment.kind === 'INSERT' ? 'textAfter' : 'textBefore';
    if (current && current.author.raw === segment.author) {
      if (current.type !== segment.kind) current.type = 'REPLACE';
      current[field] += segment.text;
    } else {
      current = suggestion(segment.kind, segment, userIds, {[field]: segment.text, scope: segment.scope});
      suggestions.push(current);
    }
  }
  // The editor leaves empty <w:ins><w:r/></w:ins> at the cursor position: they change nothing.
  return suggestions.filter(item => item.type === 'FORMAT' || item.textBefore || item.textAfter || item.scope === 'table-row');
}

function suggestion(type, segment, userIds, values) {
  const author = parseAuthor(segment.author, userIds);
  if (!author.userId && segment.userId) author.userId = segment.userId;
  return {
    id: null,
    type,
    author,
    date: segment.date,
    textBefore: '',
    textAfter: '',
    move: !!segment.move,
    anchor: {part: segment.part, paragraph: segment.paragraph, context: segment.context || ''},
    ...values
  };
}

// Stable while the change stays in the document, so successive reports can be compared.
function assignIds(items, fields) {
  const seen = new Map();
  for (const item of items) {
    const base = crypto.createHash('sha256').update(fields(item).join('\u0001')).digest('hex').slice(0, 16);
    const occurrence = (seen.get(base) || 0) + 1;
    seen.set(base, occurrence);
    item.id = occurrence === 1 ? base : `${base}-${occurrence}`;
  }
}

function parsePeople(...sources) {
  const userIds = new Map();
  for (const xml of sources.filter(Boolean)) {
    for (const person of descendants(parseXml(xml))) {
      if (person.name !== 'w15:person') continue;
      const presence = person.children.find(item => item.name === 'w15:presenceInfo');
      if (presence && presence.attrs['w15:userId']) userIds.set(person.attrs['w15:author'], presence.attrs['w15:userId']);
    }
  }
  return userIds;
}

// Comments on text live in comments.xml; comments on the whole document are an editor extension
// stored in commentsDocument.xml (their ids restart from 0, hence the "doc-" prefix).
const COMMENT_SETS = [
  {comments: 'word/comments.xml', extended: 'word/commentsExtended.xml', idPrefix: '', document: false},
  {comments: 'word/commentsDocument.xml', extended: 'word/commentsExtendedDocument.xml', idPrefix: 'doc-', document: true}
];

function parseComments(zip, ranges, userIds) {
  return COMMENT_SETS.flatMap(set => parseCommentSet(zip, set, ranges, userIds));
}

function parseCommentSet(zip, set, ranges, userIds) {
  const xml = zip.readText(set.comments);
  if (!xml) return [];
  const extended = new Map();
  const extendedXml = zip.readText(set.extended);
  if (extendedXml) {
    for (const node of descendants(parseXml(extendedXml))) {
      if (node.name === 'w15:commentEx') extended.set(node.attrs['w15:paraId'], {parent: node.attrs['w15:paraIdParent'] || null, done: node.attrs['w15:done'] === '1'});
    }
  }
  const comments = [];
  const byParaId = new Map();
  for (const node of descendants(parseXml(xml))) {
    if (node.name !== 'w:comment') continue;
    const paragraphs = node.children.filter(item => item.name === 'w:p');
    const lastParaId = paragraphs.length ? paragraphs[paragraphs.length - 1].attrs['w14:paraId'] : null;
    const meta = extended.get(lastParaId) || {};
    const comment = {
      id: set.idPrefix + node.attrs['w:id'],
      parentId: null,
      author: parseAuthor(node.attrs['w:author'] || '', userIds),
      date: node.attrs['w:date'] || null,
      text: paragraphs.map(runText).join('\n'),
      resolved: !!meta.done,
      document: set.document,
      anchorText: set.document ? '' : (ranges.get(node.attrs['w:id']) || '').trim(),
      parentParaId: meta.parent || null
    };
    if (lastParaId) byParaId.set(lastParaId, comment);
    comments.push(comment);
  }
  for (const comment of comments) {
    const parent = comment.parentParaId && byParaId.get(comment.parentParaId);
    comment.parentId = parent ? parent.id : null;
    delete comment.parentParaId;
  }
  return comments;
}

// Owner's decisions on suggestions (QMS logic 5.4), written by the review panel as comments on the
// whole document, so they survive the change itself and stay immutable like every comment:
//   Правка отклонена.
//   Автор правки: Петров П. П. (круг 1 · этап 2), 2026-10-13T09:05:12Z
//   Удалено: «старый»
//   Вставлено: «новый»
//   Обоснование: …
// Only the document owner decides, so a lookalike comment of anyone else is a plain comment.
const DECISIONS = {'Правка принята.': 'ACCEPTED', 'Правка отклонена.': 'REJECTED'};
const DECISION_AUTHOR = /^Автор правки: (.+?)(?: \(круг (\d+) · (?:этап (\d+)|автор документа)\))?(?:, (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z))?$/;
const DECISION_CHANGE = /^([^:«»]+?)(?:: «([\s\S]*)»)?$/;
const DECISION_REASON = /^(?:Обоснование|Комментарий):\s?/;
const INSERT_LABELS = new Set(['Вставлено', 'Добавлен абзац', 'Добавлена строка таблицы']);
const DELETE_LABELS = new Set(['Удалено', 'Удалён абзац', 'Удалена строка таблицы']);

function parseDecision(comment) {
  if (comment.parentId || comment.author.role !== 'OWNER') return null;
  const lines = comment.text.split('\n');
  const decision = DECISIONS[lines[0].trim()];
  if (!decision) return null;
  const suggestion = {author: null, date: null, type: 'OTHER', textBefore: '', textAfter: '', changes: []};
  let reason = null;
  for (let i = 1; i < lines.length; i++) {
    if (DECISION_REASON.test(lines[i])) {
      reason = [lines[i].replace(DECISION_REASON, ''), ...lines.slice(i + 1)].join('\n').trim() || null;
      break;
    }
    const author = DECISION_AUTHOR.exec(lines[i]);
    if (author && !suggestion.author) {
      const [, name, round, stageNo, date] = author;
      suggestion.author = {name, round: round ? Number(round) : null, stageNo: stageNo ? Number(stageNo) : null, stamp: round ? `R${round}.${stageNo ? `S${stageNo}` : 'OWNER'}` : null};
      suggestion.date = date || null;
      continue;
    }
    const change = DECISION_CHANGE.exec(lines[i].trim());
    if (!change || !lines[i].trim()) continue;
    const [, label, text = ''] = change;
    suggestion.changes.push({label, text});
    if (INSERT_LABELS.has(label)) suggestion.textAfter += text;
    else if (DELETE_LABELS.has(label)) suggestion.textBefore += text;
  }
  const inserted = suggestion.changes.some(item => INSERT_LABELS.has(item.label));
  const deleted = suggestion.changes.some(item => DELETE_LABELS.has(item.label));
  if (inserted && deleted) suggestion.type = 'REPLACE';
  else if (inserted) suggestion.type = 'INSERT';
  else if (deleted) suggestion.type = 'DELETE';
  else if (suggestion.changes.length && suggestion.changes.every(item => /^Изменен/.test(item.label))) suggestion.type = 'FORMAT';
  return {commentId: comment.id, decision, reason, decidedBy: comment.author, decidedAt: comment.date, suggestion};
}

function storyParts(zip) {
  const names = zip.names();
  if (!names.includes('word/document.xml')) throw new GatewayError(422, 'GW-422-NOT-DOCX', 'word/document.xml is missing');
  const extra = names.filter(name => /^word\/(header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(name)).sort();
  return ['word/document.xml', ...extra];
}

function decodePart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Fragment locks set from the review panel: content controls tagged "qms-lock|<user id>|<stamp>|<name>".
function collectLocks(part, root) {
  const locks = [];
  for (const node of descendants(root)) {
    if (node.name !== 'w:sdt') continue;
    const properties = node.children.find(item => item.name === 'w:sdtPr');
    const tag = properties && properties.children.find(item => item.name === 'w:tag');
    const fields = (tag && tag.attrs['w:val'] || '').split('|').map(decodePart);
    if (fields[0] !== 'qms-lock') continue;
    const lock = properties.children.find(item => item.name === 'w:lock');
    const content = node.children.find(item => item.name === 'w:sdtContent');
    const stamp = STAMP.test(fields[2] || '') ? fields[2] : null;
    const [, round, stageNo] = stamp ? STAMP.exec(stamp) : [];
    locks.push({
      userId: fields[1] || null,
      name: fields[3] || '',
      stamp,
      round: stamp ? Number(round) : null,
      stageNo: stageNo ? Number(stageNo) : null,
      contentLocked: !!lock && ['sdtContentLocked', 'contentLocked'].includes(lock.attrs['w:val']),
      text: content ? content.children.filter(item => item.name).map(runText).join('').trim() : '',
      part
    });
  }
  return locks;
}

function extractReview(buffer) {
  const zip = readZip(buffer);
  const userIds = parsePeople(zip.readText('word/people.xml'), zip.readText('word/peopleDocument.xml'));
  const ranges = new Map();
  const segments = [];
  const locks = [];
  for (const part of storyParts(zip)) {
    const root = parseXml(zip.readText(part));
    segments.push(...collectSegments(part, root, ranges));
    locks.push(...collectLocks(part, root));
  }

  const suggestions = groupSuggestions(segments, userIds);
  assignIds(suggestions, item => [item.type, item.author.raw, item.date, item.textBefore, item.textAfter, item.anchor.part]);
  const comments = parseComments(zip, ranges, userIds);
  // The editor does not keep comments on the document in creation order: the journal is chronological.
  const decisions = comments.map(parseDecision).filter(Boolean)
    .sort((a, b) => (a.decidedAt || '').localeCompare(b.decidedAt || ''));

  const byStamp = {};
  const count = (stamp, key) => {
    const bucket = byStamp[stamp || 'UNSTAMPED'] || (byStamp[stamp || 'UNSTAMPED'] = {suggestions: 0, comments: 0});
    bucket[key]++;
  };
  suggestions.forEach(item => count(item.author.stamp, 'suggestions'));
  comments.forEach(item => count(item.author.stamp, 'comments'));
  const roots = comments.filter(item => !item.parentId);
  return {
    suggestions,
    comments,
    locks,
    decisions,
    summary: {
      openSuggestions: suggestions.length,
      comments: comments.length,
      threads: roots.length,
      unresolvedThreads: roots.filter(item => !item.resolved).length,
      locks: locks.length,
      decisions: {
        accepted: decisions.filter(item => item.decision === 'ACCEPTED').length,
        rejected: decisions.filter(item => item.decision === 'REJECTED').length
      },
      byStamp
    }
  };
}

module.exports = {extractReview, parseAuthor, parseDecision};
