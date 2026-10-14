'use strict';
// Sample QMS regulation as a minimal DOCX, so the demo works without uploading a file.
const zlib = require('zlib');

function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const packed = zlib.deflateRawSync(data);
    const nameBytes = Buffer.from(name, 'utf8');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(zlib.crc32(data), 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(zlib.crc32(data), 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(header, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += header.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function paragraph(text, {bold = false, size = 28, align = 'both', before = 0, after = 120} = {}) {
  const runProperties = `<w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>${bold ? '<w:b/>' : ''}<w:sz w:val="${size}"/><w:lang w:val="ru-RU"/></w:rPr>`;
  return `<w:p><w:pPr><w:spacing w:before="${before}" w:after="${after}" w:line="276" w:lineRule="auto"/><w:jc w:val="${align}"/>${runProperties}</w:pPr><w:r>${runProperties}<w:t xml:space="preserve">${escape(text)}</w:t></w:r></w:p>`;
}

function sampleRegulation() {
  const body = [
    paragraph('АО «Эмбамунайгаз»', {bold: true, align: 'center', after: 0}),
    paragraph('Интегрированная система управления', {align: 'center', after: 360}),
    paragraph('РЕГЛАМЕНТ УПРАВЛЕНИЯ ДОКУМЕНТАЦИЕЙ СМК', {bold: true, size: 32, align: 'center', after: 0}),
    paragraph('РЕГ-ДОТиОС-2026-014, ред. 1', {align: 'center', after: 480}),
    paragraph('1. Общие положения', {bold: true, before: 240}),
    paragraph('1.1. Настоящий регламент устанавливает порядок разработки, согласования, утверждения, ознакомления, пересмотра и отмены документов системы менеджмента качества.'),
    paragraph('1.2. Требования регламента обязательны для всех структурных подразделений Общества, входящих в область применения.'),
    paragraph('2. Область применения', {bold: true, before: 240}),
    paragraph('2.1. Регламент распространяется на политики, стандарты, регламенты, инструкции, процедуры и записи СМК.'),
    paragraph('2.2. Документы согласовываются по маршруту, утверждённому администратором СМК, в сроки, установленные справочником SLA.'),
    paragraph('3. Ответственность', {bold: true, before: 240}),
    paragraph('3.1. Владелец документа отвечает за актуальность содержания и своевременный пересмотр.'),
    paragraph('3.2. Согласующие рассматривают документ в установленный срок и оформляют замечания в режиме рецензирования.'),
    paragraph('3.3. Нормоконтролёр проверяет соответствие документа требованиям к оформлению и кодировке.'),
    paragraph('4. Пересмотр', {bold: true, before: 240}),
    paragraph('4.1. Документ пересматривается не реже одного раза в три года либо при изменении процессов и нормативных требований.')
  ].join('');
  const w = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  return zip({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${w}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1701" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>`
  });
}

module.exports = {sampleRegulation};
