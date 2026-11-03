const {test} = require('node:test');
const assert = require('node:assert/strict');
const {printCopy} = require('../src/revisions');
const {readZip} = require('../src/zip');
const {extractReview} = require('../src/review');
const {zip, reviewedDocx, IVANOV} = require('./helpers.cjs');

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const OWNER2 = 'R2.OWNER Сидорова А. А.';
const docx = body => zip({
  '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`
});
const change = (tag, author, content = '') => `<w:${tag} w:id="9" w:author="${author}" w:date="2026-11-04T08:00:00Z"${content ? `>${content}</w:${tag}>` : '/>'}`;
const run = text => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const deleted = text => `<w:r><w:delText xml:space="preserve">${text}</w:delText></w:r>`;
const printed = buffer => readZip(printCopy(buffer).buffer).readText('word/document.xml');
// Paragraph texts of the print copy, in order.
const paragraphs = buffer => [...printed(buffer).matchAll(/<w:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:p>)/g)]
  .map(match => [...(match[1] || '').matchAll(/<w:t\b[^>]*>([^<]*)<\/w:t>/g)].map(item => item[1]).join(''));

test('The owner\'s changes are accepted, suggestions of route participants are rejected', () => {
  const source = docx(`<w:p>${run('Срок: ')}${change('del', OWNER2, deleted('10'))}${change('ins', OWNER2, run('15'))}${run(' дней')}` +
    `${change('ins', IVANOV, run(' рабочих'))}${change('del', IVANOV, deleted(' календарных'))}.</w:p>`);
  const copy = printCopy(source);
  assert.deepEqual([copy.accepted, copy.rejected], [2, 2]);
  assert.deepEqual(paragraphs(copy.buffer), ['Срок: 15 дней календарных']);
  // Nothing tracked is left for the document server to print as markup.
  assert.equal(extractReview(copy.buffer).summary.openSuggestions, 0);
  assert.doesNotMatch(readZip(copy.buffer).readText('word/document.xml'), /w:delText|<w:ins\b|<w:del\b/);
});

test('Changes made outside the route are the owner\'s text and are accepted', () => {
  const source = docx(`<w:p>${run('Было ')}${change('del', 'Иванов Иван', deleted('старое'))}${change('ins', 'Иванов Иван', run('новое'))}</w:p>`);
  assert.deepEqual(paragraphs(source), ['Было новое']);
});

test('A deleted paragraph mark joins the paragraph with the next one, which keeps its properties', () => {
  const source = docx(
    `<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:rPr>${change('del', OWNER2)}</w:rPr></w:pPr>${change('del', OWNER2, deleted('Удаляемый абзац'))}</w:p>` +
    `<w:p><w:pPr><w:jc w:val="both"/></w:pPr>${run('Следующий абзац')}</w:p>` +
    // A participant's new paragraph: rejected with its mark, its text goes and the next one is intact.
    `<w:p><w:pPr><w:rPr>${change('ins', IVANOV)}</w:rPr></w:pPr>${change('ins', IVANOV, run('Предложенный абзац'))}</w:p>` +
    `<w:p>${run('Последний абзац')}</w:p>`);
  const xml = printed(source);
  assert.deepEqual(paragraphs(source), ['Следующий абзац', 'Последний абзац']);
  assert.doesNotMatch(xml, /Heading1/);
  assert.match(xml, /<w:jc w:val="both"\/>/);
});

test('A joined paragraph before a table stays a paragraph', () => {
  const source = docx(`<w:p><w:pPr><w:rPr>${change('del', OWNER2)}</w:rPr></w:pPr>${run('Перед таблицей')}</w:p>` +
    `<w:tbl><w:tr><w:tc><w:p>${run('Ячейка')}</w:p></w:tc></w:tr></w:tbl>`);
  assert.deepEqual(paragraphs(source), ['Перед таблицей', 'Ячейка']);
});

test('Rows deleted by the owner and rows suggested by participants are removed', () => {
  const row = (marker, text) => `<w:tr><w:trPr>${marker}</w:trPr><w:tc><w:p>${run(text)}</w:p></w:tc></w:tr>`;
  const source = docx(`<w:tbl>${row('', 'Остаётся')}${row(change('del', OWNER2), 'Удалена автором')}${row(change('ins', IVANOV), 'Предложена')}` +
    `${row(change('del', IVANOV), 'Удаление не принято')}</w:tbl><w:tbl>${row(change('del', OWNER2), 'Единственная строка')}</w:tbl>`);
  const xml = printed(source);
  assert.deepEqual(paragraphs(source), ['Остаётся', 'Удаление не принято']);
  // A table without rows is not left behind.
  assert.equal((xml.match(/<w:tbl>/g) || []).length, 1);
});

test('Text inserted by the owner and deleted by a participant stays: the deletion is a suggestion', () => {
  const source = docx(`<w:p>${run('Пункт ')}${change('ins', OWNER2, change('del', IVANOV, deleted('важный')))}</w:p>`);
  assert.deepEqual(paragraphs(source), ['Пункт важный']);
});

test('Moves resolve like insertions and deletions, field codes are restored', () => {
  const source = docx(`<w:p><w:moveFromRangeStart w:id="1" w:name="m"/>${change('moveFrom', OWNER2, deleted('Перенесено'))}<w:moveFromRangeEnd w:id="1"/></w:p>` +
    `<w:p>${change('moveTo', OWNER2, run('Перенесено'))}${change('del', IVANOV, '<w:r><w:delInstrText> PAGE </w:delInstrText></w:r>')}</w:p>`);
  const xml = printed(source);
  assert.doesNotMatch(xml, /moveFrom|moveTo/);
  assert.match(xml, /<w:instrText> PAGE <\/w:instrText>/);
  assert.deepEqual(paragraphs(source), ['', 'Перенесено']);
});

test('Formatting: the owner\'s is kept, a participant\'s gives way to the previous properties', () => {
  const source = docx(
    `<w:p><w:r><w:rPr><w:b/>${change('rPrChange', OWNER2, '<w:rPr/>')}</w:rPr><w:t>Жирный автора</w:t></w:r></w:p>` +
    `<w:p><w:r><w:rPr><w:i/>${change('rPrChange', IVANOV, '<w:rPr><w:u w:val="single"/></w:rPr>')}</w:rPr><w:t>Курсив участника</w:t></w:r></w:p>` +
    `<w:p><w:pPr><w:jc w:val="center"/><w:rPr><w:sz w:val="20"/></w:rPr>${change('pPrChange', IVANOV, '<w:pPr><w:jc w:val="left"/></w:pPr>')}</w:pPr>${run('Абзац')}</w:p>`);
  const copy = printCopy(source);
  const xml = readZip(copy.buffer).readText('word/document.xml');
  assert.deepEqual([copy.accepted, copy.rejected], [1, 2]);
  assert.match(xml, /<w:rPr><w:b\/><\/w:rPr><w:t>Жирный автора/);
  assert.match(xml, /<w:rPr><w:u w:val="single"\/><\/w:rPr><w:t>Курсив участника/);
  assert.match(xml, /<w:pPr><w:jc w:val="left"\/><w:rPr><w:sz w:val="20"\/><\/w:rPr><\/w:pPr>/);
  assert.doesNotMatch(xml, /Change/);
});

test('The reviewed regulation prints without markup; untouched parts and files are copied', () => {
  const source = reviewedDocx();
  const copy = printCopy(source);
  const archive = readZip(copy.buffer);
  assert.equal(extractReview(copy.buffer).summary.openSuggestions, 0);
  assert.deepEqual(archive.names(), readZip(source).names());
  assert.deepEqual(paragraphs(source), ['Регламент вводится &amp; применяется.', 'Срок: старый порядок.', 'Важно знать', 'Определяет область применения']);
  // The participant's paragraph went with its mark; the bold they suggested is not printed.
  assert.doesNotMatch(archive.readText('word/document.xml'), /Новый абзац|<w:b\/>/);
  assert.match(archive.readText('word/header1.xml'), /<w:t>Проект<\/w:t>/);
  assert.equal(archive.readText('word/comments.xml'), readZip(source).readText('word/comments.xml'));
  // Without tracked changes the file is printed as it is.
  const clean = docx(`<w:p>${run('Чистый текст')}</w:p>`);
  assert.equal(printCopy(clean).buffer, clean);
});
