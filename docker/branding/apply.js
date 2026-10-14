'use strict';
// Applies Officier branding to the upstream editor assets at image build.
// Every replacement checks its expected count, so an upstream layout change fails the build.
const fs = require('fs');
const path = require('path');

const branding = JSON.parse(fs.readFileSync(path.join(__dirname, 'branding.json'), 'utf8'));
const marker = '/*OFFICIER_BRANDING*/null';
const cacheMarker = "/*OFFICIER_CACHE_PATH*/''";

function count(text, search) {
  return text.split(search).length - 1;
}

function replaceExact(file, search, replacement, expected) {
  const text = fs.readFileSync(file, 'utf8');
  const found = count(text, search);
  if (found !== expected) throw new Error(`${file}: expected ${expected} x ${search}, found ${found}`);
  fs.writeFileSync(file, text.split(search).join(replacement));
}

// Scripts are served without a charset and decoded with the host page encoding: keep them ASCII.
function asciiOnly(source) {
  return source.replace(/[^\x00-\x7f]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
}

function escapeHtml(value) {
  return value.replace(/[&<>"]/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[char]);
}

// cachePath is upstream's "/9.4.0-{{HASH_POSTFIX}}"; the container start script fills in the tag.
function renderApiDefaults(template, api, cachePath) {
  if (count(template, marker) !== 1) throw new Error('Branding marker is missing in api-defaults.js');
  if (count(template, cacheMarker) !== 1) throw new Error('Cache path marker is missing in api-defaults.js');
  return asciiOnly(template.replace(marker, JSON.stringify(api)).replace(cacheMarker, JSON.stringify(cachePath)));
}

function indexPages(dir) {
  const pages = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const name = path.join(dir, entry.name);
    if (entry.isDirectory()) pages.push(...indexPages(name));
    else if (/^index.*\.html$/.test(entry.name)) pages.push(name);
  }
  return pages;
}

function main(apps, welcome) {
  let titles = 0;
  for (const [editor, title] of Object.entries(branding.editors)) {
    const dir = path.join(apps, editor);
    for (const page of indexPages(dir)) {
      const html = fs.readFileSync(page, 'utf8');
      const updated = html.replace(/<title>ONLYOFFICE[^<]*<\/title>/g, `<title>${escapeHtml(title)}</title>`);
      if (updated !== html) {
        fs.writeFileSync(page, updated);
        titles++;
      }
    }
    // Browser tab caption and license warnings use the product name literal five times.
    replaceExact(path.join(dir, 'main/app/controller/Main.js'), "'ONLYOFFICE'", `'${asciiOnly(title.replace(/['\\]/g, '\\$&'))}'`, 5);
  }
  if (titles < Object.keys(branding.editors).length) throw new Error(`Only ${titles} editor titles were rebranded`);

  // customization.officier.openComments: the comments panel opens once the document is ready,
  // so route participants see every comment and its author without clicking the text.
  const aboutLicense = "me.getApplication().getController('LeftMenu').leftMenu.getMenu('about').setLicInfo(me.editorConfig.customization);";
  replaceExact(path.join(apps, 'documenteditor/main/app/controller/Main.js'), aboutLicense, aboutLicense + `

                // Officier: open the comments panel on load when customization.officier.openComments is set.
                if (me.editorConfig.customization && me.editorConfig.customization.officier && me.editorConfig.customization.officier.openComments)
                    setTimeout(function() { leftmenuController.onShortcut('comments'); }, 0);`, 1);

  // api.js is generated from this template at container start (cache tag substitution).
  const api = path.join(apps, 'api/documents/api.js.tpl');
  const source = fs.readFileSync(api, 'utf8');
  if (source.includes('officierBranding')) throw new Error('api.js.tpl already contains Officier defaults');
  const template = fs.readFileSync(path.join(__dirname, 'api-defaults.js'), 'utf8');
  const cachePath = /const ver = '([^']*\{\{HASH_POSTFIX\}\}[^']*)'/.exec(source);
  if (!cachePath) throw new Error('api.js.tpl no longer defines the cache-tagged path');
  fs.writeFileSync(api, source + renderApiDefaults(template, branding.api, cachePath[1]));

  // The embedded source archive of a release (docker/install.sh) wins over the repository link.
  const sourceUrl = process.env.OFFICIER_SOURCE_URL || branding.sourceUrl;
  for (const page of ['officier.html', 'docker.html']) {
    replaceExact(path.join(welcome, page), '{{OFFICIER_SOURCE_URL}}', escapeHtml(sourceUrl), 1);
  }

  console.log(`Officier branding: ${titles} page titles, ${Object.keys(branding.editors).length} editor controllers, api.js defaults`);
}

if (require.main === module) {
  main(process.argv[2] || '/var/www/onlyoffice/documentserver/web-apps/apps',
    process.argv[3] || '/var/www/onlyoffice/documentserver-example/welcome');
}

module.exports = {branding, renderApiDefaults};
