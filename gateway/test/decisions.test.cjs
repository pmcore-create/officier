const {test} = require('node:test');
const assert = require('node:assert/strict');
const {zip, IVANOV, PETROV, OWNER} = require('./helpers.cjs');
const {extractReview} = require('../src/review');
const {prepareApproval} = require('../src/docx');
const {readZip} = require('../src/zip');

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"';
const paragraphs = text => text.split('\n').map((line, index) => `<w:p w14:paraId="0000010${index}"><w:r><w:t xml:space="preserve">${line}</w:t></w:r></w:p>`).join('');
const comment = (id, author, text, date = '2026-10-14T10:00:00Z') => `<w:comment w:id="${id}" w:author="${author}" w:date="${date}">${paragraphs(text)}</w:comment>`;

// What the editor saves after the owner decided through the review panel: comments on the whole
// document live in the editor's own parts next to the regular comments.
function decidedDocx() {
  return zip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/commentsDocument.xml" ContentType="comments"/><Override PartName="/word/peopleDocument.xml" ContentType="people"/></Types>',
    'word/_rels/document.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="styles" Target="styles.xml" /><Relationship Id="rId8" Type="http://schemas.onlyoffice.com/commentsDocument" Target="commentsDocument.xml" /><Relationship Id="rId12" Type="http://schemas.onlyoffice.com/peopleDocument" Target="peopleDocument.xml" /></Relationships>',
    'word/document.xml': `<?xml version="1.0"?><w:document ${W}><w:body><w:p><w:r><w:t>Officier итоговый document.</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`,
    'word/comments.xml': `<?xml version="1.0"?><w:comments ${W}>${comment(0, PETROV, 'Уточнить формулировку')}</w:comments>`,
    'word/commentsDocument.xml': `<?xml version="1.0"?><w:comments ${W}>${[
      comment(0, OWNER, 'Правка отклонена.\nАвтор правки: Петров П. П. (круг 1 · этап 2), 2026-10-13T09:05:12Z\nВставлено: «Замечание согласующего. »\nОбоснование: формулировка избыточна,\nсм. п. 1.2'),
      comment(1, OWNER, 'Правка принята.\nАвтор правки: Иванов И. И. (круг 1 · этап 1), 2026-10-13T09:06:00Z\nУдалено: «smoke»\nВставлено: «итоговый»', '2026-10-14T10:01:00Z'),
      comment(2, IVANOV, 'Правка отклонена.\nАвтор правки: Петров П. П. (круг 1 · этап 2), 2026-10-13T09:05:12Z\nОбоснование: я не автор документа'),
      // Saved last but decided first: the editor does not keep these comments in creation order.
      comment(3, OWNER, 'Правка принята.\nАвтор правки: Петров П. П. (круг 1 · этап 2), 2026-10-13T09:07:00Z\nИзменено оформление текста: «Важно»\nКомментарий: согласна', '2026-10-14T09:59:00Z')
    ].join('')}</w:comments>`,
    'word/peopleDocument.xml': `<?xml version="1.0"?><w15:people ${W}><w15:person w15:author="${OWNER}"><w15:presenceInfo w15:providerId="Teamlab" w15:userId="u-100"/></w15:person></w15:people>`
  });
}

test('Comments on the whole document are reported apart from comments on text', () => {
  const {comments, summary} = extractReview(decidedDocx());
  assert.equal(summary.comments, 5);
  assert.deepEqual(comments.map(item => [item.id, item.document]), [['0', false], ['doc-0', true], ['doc-1', true], ['doc-2', true], ['doc-3', true]]);
  assert.equal(comments[1].author.userId, 'u-100', 'authors of document comments come from peopleDocument.xml');
});

test('Owner decisions are parsed from the panel format; lookalikes from others are ignored', () => {
  const {decisions, summary} = extractReview(decidedDocx());
  assert.deepEqual(summary.decisions, {accepted: 2, rejected: 1});
  assert.deepEqual(decisions.map(item => item.commentId), ['doc-3', 'doc-0', 'doc-1'], 'chronological journal');
  const [formatted, rejected, replaced] = decisions;
  assert.deepEqual({...rejected, decidedBy: rejected.decidedBy.stamp}, {
    commentId: 'doc-0', decision: 'REJECTED', reason: 'формулировка избыточна,\nсм. п. 1.2', decidedBy: 'R1.OWNER', decidedAt: '2026-10-14T10:00:00Z',
    suggestion: {
      author: {name: 'Петров П. П.', round: 1, stageNo: 2, stamp: 'R1.S2'}, date: '2026-10-13T09:05:12Z', type: 'INSERT',
      textBefore: '', textAfter: 'Замечание согласующего. ', changes: [{label: 'Вставлено', text: 'Замечание согласующего. '}]
    }
  });
  assert.deepEqual([replaced.decision, replaced.reason, replaced.suggestion.type, replaced.suggestion.textBefore, replaced.suggestion.textAfter, replaced.suggestion.author.stamp],
    ['ACCEPTED', null, 'REPLACE', 'smoke', 'итоговый', 'R1.S1']);
  assert.deepEqual([formatted.suggestion.type, formatted.reason], ['FORMAT', 'согласна']);
  assert.equal(decisions.some(item => item.decidedBy.stamp === 'R1.S1'), false, 'a reviewer cannot record a decision');
});

test('The frozen source drops comments on text and on the whole document', () => {
  const {source, removed} = prepareApproval(decidedDocx(), {sheet: {code: 'К-1', name: 'Д', versionNo: 1, approvals: [], timeZone: 'Asia/Almaty'}});
  assert.equal(removed.comments, 5);
  const archive = readZip(source);
  for (const part of ['word/comments.xml', 'word/commentsDocument.xml', 'word/peopleDocument.xml']) assert.equal(archive.read(part), null, part);
  assert.doesNotMatch(archive.readText('word/_rels/document.xml.rels'), /commentsDocument|peopleDocument/);
  assert.doesNotMatch(archive.readText('[Content_Types].xml'), /commentsDocument|peopleDocument/);
  const review = extractReview(source);
  assert.deepEqual([review.summary.comments, review.decisions.length], [0, 0]);
});
