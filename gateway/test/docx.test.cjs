const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {zip, IVANOV, OWNER} = require('./helpers.cjs');
const {readZip} = require('../src/zip');
const {extractReview} = require('../src/review');
const {prepareApproval, unwrapLocks, formatDate} = require('../src/docx');

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"';
const LOCK = (text, inner = `<w:r><w:t>${text}</w:t></w:r>`) =>
  `<w:sdt><w:sdtPr><w:alias w:val="Заблокировано"/><w:tag w:val="qms-lock|u-201|R1.S2|%D0%9F"/><w:lock w:val="sdtContentLocked"/></w:sdtPr><w:sdtContent>${inner}</w:sdtContent></w:sdt>`;

// A document after the route: every suggestion decided, a comment thread, a lock and editor leftovers.
function approvedDocx() {
  return zip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="main"/><Override PartName="/word/comments.xml" ContentType="comments"/><Override PartName="/word/commentsExtended.xml" ContentType="ext"/><Override PartName="/word/people.xml" ContentType="people"/></Types>',
    'word/_rels/document.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="styles" Target="styles.xml" /><Relationship Id="rId9" Type="comments" Target="comments.xml" /><Relationship Id="rId10" Type="commentsExtended" Target="commentsExtended.xml" /><Relationship Id="rId13" Type="people" Target="people.xml" /></Relationships>',
    'word/_rels/comments.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
    'word/styles.xml': `<?xml version="1.0"?><w:styles ${W}/>`,
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>
<w:p><w:r><w:t xml:space="preserve">Регламент </w:t></w:r><w:commentRangeStart w:id="0"/><w:r><w:t>вводится</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>${LOCK('Officier')}<w:ins w:id="1" w:author="${IVANOV}" w:date="2026-10-14T07:29:22Z" oouserid="u-101"><w:r></w:r></w:ins><w:r></w:r></w:p>
<w:p><w:pPr><w:rPr><w:ins w:id="6" w:author="${OWNER}" w:date="2026-10-13T09:12:00Z"/></w:rPr></w:pPr><w:r><w:t>Сроки</w:t></w:r></w:p>
<w:sectPr><w:pgSz w:h="16838" w:orient="portrait" w:w="11906" /><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`,
    'word/footer1.xml': `<?xml version="1.0"?><w:ftr ${W}><w:p>${LOCK('Подвал')}</w:p></w:ftr>`,
    'word/comments.xml': `<?xml version="1.0"?><w:comments ${W}><w:comment w:id="0" w:author="${IVANOV}"><w:p w14:paraId="00000001"><w:r><w:t>Уточнить</w:t></w:r></w:p></w:comment><w:comment w:id="1" w:author="${OWNER}"><w:p w14:paraId="00000002"><w:r><w:t>Уточнено</w:t></w:r></w:p></w:comment></w:comments>`,
    'word/commentsExtended.xml': `<?xml version="1.0"?><w15:commentsEx ${W}/>`,
    'word/people.xml': `<?xml version="1.0"?><w15:people ${W}/>`
  });
}

const sheet = {
  code: 'РЕГ-ДОТиОС-2026-014', name: 'Регламент управления документацией', versionNo: 2, timeZone: 'Asia/Almaty',
  approvals: [
    {name: 'Иванов И. И.', position: 'Начальник ОТиОС', stage: 'Согласование', decision: 'Согласовано', date: '2026-10-13T20:30:00Z'},
    {name: 'Петров <П.> & Ко', stage: 'Нормоконтроль', decision: 'Согласовано с замечаниями', comment: 'Учтено в п. 2', date: '2026-10-14'}
  ]
};

test('Approved source keeps the text and drops comments, locks and empty insertions', () => {
  const {source, sourceSha256, removed} = prepareApproval(approvedDocx(), {sheet});
  assert.deepEqual(removed, {comments: 2, locks: 2, emptyInsertions: 1});
  assert.equal(sourceSha256, crypto.createHash('sha256').update(source).digest('hex'));
  const archive = readZip(source);
  for (const part of ['word/comments.xml', 'word/commentsExtended.xml', 'word/_rels/comments.xml.rels']) assert.equal(archive.read(part), null, part);
  assert.ok(archive.read('word/people.xml'), 'people.xml stays: tracked change authors use it');
  assert.doesNotMatch(archive.readText('word/_rels/document.xml.rels'), /comments/);
  assert.match(archive.readText('word/_rels/document.xml.rels'), /styles\.xml.*people\.xml/);
  assert.doesNotMatch(archive.readText('[Content_Types].xml'), /comments/);
  const documentXml = archive.readText('word/document.xml');
  assert.doesNotMatch(documentXml, /w:comment|w:sdt|<w:ins w:id="1"/);
  assert.match(documentXml, /<w:r><w:t>Officier<\/w:t><\/w:r>/, 'locked text stays in place');
  assert.match(documentXml, /<w:ins w:id="6"[^>]*\/>/, 'a tracked paragraph mark is a real change and is kept');
  assert.match(archive.readText('word/footer1.xml'), /<w:p><w:r><w:t>Подвал<\/w:t><\/w:r><\/w:p>/);
  const review = extractReview(source);
  assert.deepEqual([review.summary.comments, review.summary.locks], [0, 0]);
});

test('Comments and locks can be kept on request', () => {
  const {source, removed} = prepareApproval(approvedDocx(), {keepComments: true, keepLocks: true, sheet});
  assert.deepEqual(removed, {comments: 0, locks: 0, emptyInsertions: 1});
  const review = extractReview(source);
  assert.deepEqual([review.summary.comments, review.summary.locks], [2, 2]);
});

test('Print copy ends with the approval sheet in the last section', () => {
  const {print, sourceSha256} = prepareApproval(approvedDocx(), {sheet});
  const documentXml = readZip(print).readText('word/document.xml');
  const sheetStart = documentXml.indexOf('ЛИСТ СОГЛАСОВАНИЯ');
  assert.ok(sheetStart > documentXml.indexOf('Сроки') && sheetStart < documentXml.indexOf('<w:sectPr'), 'sheet after the text, before the body section');
  assert.match(documentXml, /<w:pageBreakBefore\/>[\s\S]*ЛИСТ СОГЛАСОВАНИЯ/);
  assert.match(documentXml, /РЕГ-ДОТиОС-2026-014, ред\. 2/);
  // Evening UTC is the next morning in Kazakhstan; plain dates are printed as given.
  assert.match(documentXml, /Иванов И\. И\.[\s\S]*Начальник ОТиОС[\s\S]*Согласовано[\s\S]*14\.10\.2026/);
  assert.match(documentXml, /Петров &lt;П\.&gt; &amp; Ко[\s\S]*Учтено в п\. 2[\s\S]*14\.10\.2026/);
  assert.match(documentXml, new RegExp(`SHA-256: ${sourceSha256}`));
  // Text width of A4 with 1-inch margins: 11906 - 2 * 1440.
  const grid = [...documentXml.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].reduce((sum, match) => sum + Number(match[1]), 0);
  assert.ok(grid <= 9026 && grid > 9000, `table width ${grid}`);
});

test('Nested content controls: only lock controls are unwrapped', () => {
  const other = inner => `<w:sdt><w:sdtPr><w:tag w:val="other"/></w:sdtPr><w:sdtContent>${inner}</w:sdtContent></w:sdt>`;
  const xml = `<w:p>${other(LOCK('a', `<w:r><w:t>a</w:t></w:r>${other('<w:r><w:t>b</w:t></w:r>')}`))}${LOCK('c', '')}</w:p>`;
  const result = unwrapLocks(xml);
  assert.equal(result.count, 2);
  assert.equal(result.xml, `<w:p>${other(`<w:r><w:t>a</w:t></w:r>${other('<w:r><w:t>b</w:t></w:r>')}`)}</w:p>`);
  assert.throws(() => unwrapLocks('<w:sdt><w:sdtContent>'), /Unbalanced/);
});

test('Decision dates', () => {
  assert.equal(formatDate('2026-03-01', 'Asia/Almaty'), '01.03.2026');
  assert.equal(formatDate('2026-10-13T18:59:00Z', 'Asia/Almaty'), '13.10.2026');
  assert.equal(formatDate('2026-10-13T19:00:00Z', 'Asia/Almaty'), '14.10.2026');
});
