const {test} = require('node:test');
const assert = require('node:assert/strict');
const {extractReview, parseAuthor} = require('../src/review');
const {zip, reviewedDocx, IVANOV, PETROV, OWNER} = require('./helpers.cjs');

test('Author stamps carry the route round and stage written by the policy', () => {
  assert.deepEqual(parseAuthor(IVANOV, new Map([[IVANOV, 'u-101']])), {
    raw: IVANOV, name: 'Иванов И. И.', userId: 'u-101', stamp: 'R1.S1', round: 1, stageNo: 1, role: 'PARTICIPANT'
  });
  assert.equal(parseAuthor(OWNER).role, 'OWNER');
  assert.deepEqual(parseAuthor('Word User'), {raw: 'Word User', name: 'Word User', userId: null, stamp: null, round: null, stageNo: null, role: null});
});

test('Suggestions are grouped into insert, replace, format and paragraph changes', () => {
  const {suggestions} = extractReview(reviewedDocx());
  const brief = suggestions.map(item => [item.type, item.author.stamp, item.textBefore, item.textAfter, item.anchor.part, item.anchor.paragraph]);
  assert.deepEqual(brief, [
    ['INSERT', 'R1.S1', '', 'срочно ', 'word/document.xml', 0],
    ['REPLACE', 'R1.S2', 'старый', 'новый', 'word/document.xml', 1],
    ['FORMAT', 'R1.S1', '', 'Важно знать', 'word/document.xml', 2],
    ['INSERT', 'R1.S1', '', 'Новый абзац\n', 'word/document.xml', 3],
    ['DELETE', 'R1.S2', 'Проект', '', 'word/header1.xml', 0]
  ]);
  assert.equal(suggestions[0].anchor.context, 'Регламент срочно вводится & применяется.');
  assert.equal(suggestions[0].author.userId, 'u-101');
  assert.equal(suggestions[0].date, '2026-10-13T09:00:00Z');
});

test('Suggestion ids are stable across saves and unique within a report', () => {
  const first = extractReview(reviewedDocx()).suggestions.map(item => item.id);
  const second = extractReview(reviewedDocx()).suggestions.map(item => item.id);
  assert.deepEqual(first, second);
  assert.equal(new Set(first).size, first.length);
});

test('Comments keep threads, anchors and authors', () => {
  const {comments, summary} = extractReview(reviewedDocx());
  assert.deepEqual(comments.map(item => [item.id, item.parentId, item.author.stamp, item.text, item.anchorText, item.resolved]), [
    ['0', null, 'R1.S1', 'Уточнить область', 'область применения', false],
    ['1', '0', 'R1.OWNER', 'Уточнено в п. 1.2', '', false]
  ]);
  assert.deepEqual(summary, {
    openSuggestions: 5,
    comments: 2,
    threads: 1,
    unresolvedThreads: 1,
    locks: 0,
    decisions: {accepted: 0, rejected: 0},
    byStamp: {'R1.S1': {suggestions: 3, comments: 1}, 'R1.S2': {suggestions: 2, comments: 0}, 'R1.OWNER': {suggestions: 0, comments: 1}}
  });
});

test('Empty revision runs left by the editor are not suggestions, empty inserted table rows are', () => {
  const docx = zip({'word/document.xml': `<w:document xmlns:w="w"><w:body>
<w:p><w:r><w:t>Текст</w:t></w:r><w:ins w:id="1" w:author="${IVANOV}" w:date="2026-10-13T08:23:06Z" oouserid="u-101"><w:r></w:r></w:ins><w:r></w:r></w:p>
<w:tbl><w:tr><w:trPr><w:ins w:id="2" w:author="${IVANOV}" w:date="2026-10-13T08:24:00Z"/></w:trPr><w:tc><w:p/></w:tc></w:tr></w:tbl>
</w:body></w:document>`});
  const {suggestions} = extractReview(docx);
  assert.deepEqual(suggestions.map(item => [item.type, item.scope, item.author.userId]), [['INSERT', 'table-row', null]]);
});

test('Fragment locks report who locked what and on which stage', () => {
  const tag = ['qms-lock', 'u-201', 'R1.S2', 'Петров П. П.'].map(encodeURIComponent).join('|');
  const docx = zip({'word/document.xml': `<w:document xmlns:w="w"><w:body>
<w:p><w:r><w:t xml:space="preserve">Срок </w:t></w:r><w:sdt><w:sdtPr><w:alias w:val="Заблокировано: Петров П. П."/><w:tag w:val="${tag}"/><w:lock w:val="sdtContentLocked"/></w:sdtPr><w:sdtContent><w:r><w:t>30 дней</w:t></w:r></w:sdtContent></w:sdt></w:p>
<w:sdt><w:sdtPr><w:tag w:val="other"/></w:sdtPr><w:sdtContent><w:p><w:r><w:t>Поле формы</w:t></w:r></w:p></w:sdtContent></w:sdt>
</w:body></w:document>`});
  const {locks, summary, suggestions} = extractReview(docx);
  assert.deepEqual(locks, [{userId: 'u-201', name: 'Петров П. П.', stamp: 'R1.S2', round: 1, stageNo: 2, contentLocked: true, text: '30 дней', part: 'word/document.xml'}]);
  assert.equal(summary.locks, 1);
  assert.deepEqual(suggestions, []);
});

test('A clean document has nothing open', () => {
  const docx = zip({'word/document.xml': '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Текст</w:t></w:r></w:p></w:body></w:document>'});
  assert.deepEqual(extractReview(docx).summary, {openSuggestions: 0, comments: 0, threads: 0, unresolvedThreads: 0, locks: 0, decisions: {accepted: 0, rejected: 0}, byStamp: {}});
});

test('Non-DOCX input and DOCTYPE are rejected', () => {
  assert.throws(() => extractReview(Buffer.from('not a zip')), {code: 'GW-422-NOT-DOCX'});
  assert.throws(() => extractReview(zip({'a.txt': 'x'})), {code: 'GW-422-NOT-DOCX'});
  assert.throws(() => extractReview(zip({'word/document.xml': '<!DOCTYPE x [<!ENTITY e "e">]><w:document/>'})), {code: 'GW-422-NOT-DOCX'});
});
