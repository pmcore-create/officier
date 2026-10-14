const zlib = require('node:zlib');

// Builds a ZIP with stored (uncompressed) and deflated entries for DOCX fixtures.
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  Object.entries(files).forEach(([name, content], index) => {
    const data = Buffer.from(content, 'utf8');
    const deflate = index % 2 === 1;
    const stored = deflate ? zlib.deflateRawSync(data) : data;
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, stored);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + stored.length;
  });
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"';
const IVANOV = 'R1.S1\u00a0Иванов И. И.';
const PETROV = 'R1.S2\u00a0Петров П. П.';
const OWNER = 'R1.OWNER\u00a0Сидорова А. А.';

// A regulation reviewed by two route participants, with a comment thread and a header change.
function reviewedDocx() {
  return zip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>
<w:p><w:r><w:t xml:space="preserve">Регламент </w:t></w:r><w:ins w:id="1" w:author="${IVANOV}" w:date="2026-10-13T09:00:00Z"><w:r><w:t xml:space="preserve">срочно </w:t></w:r></w:ins><w:r><w:t>вводится &amp; применяется.</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Срок: </w:t></w:r><w:del w:id="2" w:author="${PETROV}" w:date="2026-10-13T09:05:00Z"><w:r><w:delText>старый</w:delText></w:r></w:del><w:ins w:id="3" w:author="${PETROV}" w:date="2026-10-13T09:05:00Z"><w:r><w:t>новый</w:t></w:r></w:ins><w:r><w:t xml:space="preserve"> порядок.</w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:b/><w:rPrChange w:id="4" w:author="${IVANOV}" w:date="2026-10-13T09:10:00Z"><w:rPr/></w:rPrChange></w:rPr><w:t xml:space="preserve">Важно </w:t></w:r><w:r><w:rPr><w:b/><w:rPrChange w:id="5" w:author="${IVANOV}" w:date="2026-10-13T09:10:00Z"><w:rPr/></w:rPrChange></w:rPr><w:t>знать</w:t></w:r></w:p>
<w:p><w:pPr><w:rPr><w:ins w:id="6" w:author="${IVANOV}" w:date="2026-10-13T09:12:00Z"/></w:rPr></w:pPr><w:ins w:id="7" w:author="${IVANOV}" w:date="2026-10-13T09:12:00Z"><w:r><w:t>Новый абзац</w:t></w:r></w:ins></w:p>
<w:p><w:r><w:t xml:space="preserve">Определяет </w:t></w:r><w:commentRangeStart w:id="0"/><w:r><w:t>область применения</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>
<w:sectPr/></w:body></w:document>`,
    'word/header1.xml': `<?xml version="1.0"?><w:hdr ${W}><w:p><w:del w:id="8" w:author="${PETROV}" w:date="2026-10-13T09:20:00Z"><w:r><w:delText>Проект</w:delText></w:r></w:del></w:p></w:hdr>`,
    'word/comments.xml': `<?xml version="1.0"?><w:comments ${W}>
<w:comment w:id="0" w:author="${IVANOV}" w:date="2026-10-13T09:15:00Z" w:initials="ИИ"><w:p w14:paraId="00000001"><w:r><w:t>Уточнить область</w:t></w:r></w:p></w:comment>
<w:comment w:id="1" w:author="${OWNER}" w:date="2026-10-13T11:00:00Z" w:initials="СА"><w:p w14:paraId="00000002"><w:r><w:t>Уточнено в п. 1.2</w:t></w:r></w:p></w:comment>
</w:comments>`,
    'word/commentsExtended.xml': `<?xml version="1.0"?><w15:commentsEx ${W}><w15:commentEx w15:paraId="00000001" w15:done="0"/><w15:commentEx w15:paraId="00000002" w15:paraIdParent="00000001" w15:done="0"/></w15:commentsEx>`,
    'word/people.xml': `<?xml version="1.0"?><w15:people ${W}><w15:person w15:author="${IVANOV}"><w15:presenceInfo w15:providerId="Teamlab" w15:userId="u-101"/></w15:person></w15:people>`
  });
}

module.exports = {zip, reviewedDocx, IVANOV, PETROV, OWNER};
