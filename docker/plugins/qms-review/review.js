// Officier review panel: who changed, commented and locked what in the document, without clicking
// the changes. The plugin is served from the same origin as the editor and reads it directly.
(function (window) {
  'use strict';

  var NBSP = '\u00a0';
  var STAMP = /^R(\d+)\.(?:S(\d+)|OWNER)$/;
  var LOCK_TAG = 'qms-lock';
  // Editor events trigger refreshes; the timer is only a safety net for anything they miss.
  var REFRESH_MS = 3000;
  var SETTLE_MS = 100;
  var EDITOR_EVENTS = ['asc_onCollaborativeChanges', 'asc_onAddComment', 'asc_onRemoveComment', 'asc_onChangeCommentData',
    'asc_onDocumentModifiedChanged', 'asc_onShowRevisionsChange'];
  var LABELS = {
    TextAdd: 'Вставлено', TextRem: 'Удалено', ParaAdd: 'Добавлен абзац', ParaRem: 'Удалён абзац',
    TextPr: 'Изменено оформление текста', ParaPr: 'Изменено оформление абзаца', TablePr: 'Изменены свойства таблицы',
    RowsAdd: 'Добавлена строка таблицы', RowsRem: 'Удалена строка таблицы', TableRowPr: 'Изменена строка таблицы'
  };
  // Owner decisions (QMS logic 5.4) are comments on the whole document in this format; the QMS
  // gateway parses the same lines into the decision journal (gateway/src/review.js).
  var DECISION_HEADS = {ACCEPTED: 'Правка принята.', REJECTED: 'Правка отклонена.'};
  var DECISION_TEXT_LIMIT = 300;
  var signature = '';
  var timer = null;
  // Open decision form: {key, decision, text}. While it is open the list is not re-rendered.
  var pending = null;
  var latest = null;
  // Owner's session: every suggestion seen, and those decided here. A seen suggestion that left the
  // text without a decision (the owner deleted or retyped it directly) asks for one.
  var known = {};
  var decidedKeys = {};
  var tick = 0;

  function editorApi() {
    var parent = window.parent;
    return parent && parent.Asc && parent.Asc.editor && parent.Asc.editor.asc_GetTrackRevisionsReportByAuthors ? parent.Asc.editor : null;
  }

  function logicDocument(api) {
    return api.WordControl && api.WordControl.m_oLogicDocument;
  }

  function stageText(stamp) {
    var match = STAMP.exec(stamp || '');
    if (!match) return '';
    return match[2] ? 'круг ' + match[1] + ' · этап ' + match[2] : 'круг ' + match[1] + ' · автор документа';
  }

  // "R2.S1<NBSP>Иванов И. И." -> name plus route round/stage stamped by the QMS gateway.
  function parseAuthor(raw) {
    var separator = raw.indexOf(NBSP);
    var groups = separator > -1 ? raw.slice(0, separator).split(',') : [];
    var author = {raw: raw, name: separator > -1 ? raw.slice(separator + 1) : raw, stamp: '', stage: '', order: 1e6};
    for (var i = 0; i < groups.length; i++) {
      var match = STAMP.exec(groups[i].trim());
      if (!match) continue;
      author.stamp = groups[i].trim();
      author.stage = stageText(author.stamp);
      author.order = Number(match[1]) * 1000 + (match[2] ? Number(match[2]) : 0);
    }
    return author;
  }

  // What the current user may do with locks: reviewers and signers lock (and release their own
  // locks); the owner editing the document releases any lock. The gateway hides the content
  // control settings from everyone else (permissions.modifyContentControl).
  function viewer() {
    var main = window.parent.DE && window.parent.DE.getController && window.parent.DE.getController('Main');
    var options = main && main.appOptions || {};
    var user = options.user || {};
    var author = parseAuthor(user.fullname || '');
    return {
      id: String(user.id || ''), name: author.name, stamp: author.stamp,
      canLock: !!options.isReviewOnly,
      canUnlockAny: !!options.isEdit && !options.isReviewOnly && options.canEditContentControl !== false,
      // The owner reworking the document: the editor's own accept/reject is off (gateway policy).
      canDecide: !!options.isEdit && !options.isReviewOnly
    };
  }

  function typeName(type) {
    var types = window.parent.Asc.c_oAscRevisionsChangeType || {};
    for (var name in types) {
      if (types[name] === type) return name;
    }
    return '';
  }

  function valueText(value) {
    if (Array.isArray(value)) return value.filter(function (item) { return typeof item === 'string'; }).join('');
    return typeof value === 'string' ? value : '';
  }

  function color(change) {
    var c = change.get_UserColor && change.get_UserColor();
    return c ? 'rgb(' + c.r + ',' + c.g + ',' + c.b + ')' : '#999';
  }

  // Same palette as the comments panel for authors who only commented.
  function userColor(userId, raw) {
    try {
      var c = window.parent.AscCommon.getUserColorById(userId, raw, false, false);
      if (c && c.r !== undefined) return 'rgb(' + c.r + ',' + c.g + ',' + c.b + ')';
    } catch (err) {
      // fall through to neutral grey
    }
    return '#999';
  }

  function paragraphText(change) {
    var element = change.GetElement && change.GetElement();
    var text = element && element.GetText ? element.GetText() : '';
    return text.replace(/\s+/g, ' ').trim().slice(0, 160);
  }

  function paragraphId(change) {
    var element = change.GetElement && change.GetElement();
    return element && element.GetId ? String(element.GetId()) : '';
  }

  function authorEntry(byName, raw) {
    if (!byName[raw]) {
      byName[raw] = parseAuthor(raw);
      byName[raw].changes = [];
      byName[raw].suggestions = [];
      byName[raw].comments = [];
    }
    return byName[raw];
  }

  // Typing over a selection gives a deletion and an insertion of the same moment: one replacement,
  // decided together (the gateway groups adjacent pieces the same way).
  function groupSuggestions(raw, changes) {
    var suggestions = [];
    for (var i = 0; i < changes.length; i++) {
      var pieces = [changes[i]];
      var next = changes[i + 1];
      if (changes[i].type === 'TextRem' && next && next.type === 'TextAdd' && next.para === changes[i].para && Math.abs(next.date - changes[i].date) <= 1000) {
        pieces.push(next);
        i++;
      }
      suggestions.push({key: JSON.stringify([raw, pieces.map(function (p) { return [p.type, p.value, p.date, p.para]; })]), pieces: pieces, date: pieces[0].date, context: pieces[0].context});
    }
    return suggestions;
  }

  // "Правка принята./отклонена." by the document owner: a decision, shown apart from comments.
  function parseDecision(raw, text, top) {
    var author = parseAuthor(raw);
    var lines = (text || '').split(/\r?\n/);
    var decision = lines[0] === DECISION_HEADS.ACCEPTED ? 'ACCEPTED' : lines[0] === DECISION_HEADS.REJECTED ? 'REJECTED' : null;
    if (!top || !decision || !/\.OWNER$/.test(author.stamp)) return null;
    var reasonAt = -1;
    for (var i = 1; i < lines.length; i++) {
      if (/^(Обоснование|Комментарий):/.test(lines[i])) { reasonAt = i; break; }
    }
    var details = lines.slice(1, reasonAt < 0 ? lines.length : reasonAt);
    var about = /^Автор правки: (.+?)(?: \([^()]*\))?(?:, (\d{4}-\d\d-\d\dT[\d:]+Z))?$/.exec(details[0] || '') || [];
    return {
      decision: decision, by: author.name,
      suggestionAuthor: (details[0] || '').replace(/^Автор правки: /, '').replace(/, \d{4}-\d\d-\d\dT[\d:]+Z$/, ''),
      suggestionName: about[1] || '', suggestionDate: about[2] || '',
      changes: details.slice(1),
      reason: reasonAt < 0 ? '' : lines.slice(reasonAt).join('\n').replace(/^(Обоснование|Комментарий):\s?/, '')
    };
  }

  function collectAuthors(api) {
    var byName = {};
    var decisions = [];
    var revisions = api.asc_GetTrackRevisionsReportByAuthors();
    Object.keys(revisions).forEach(function (raw) {
      (revisions[raw] || []).forEach(function (change, index) {
        var author = authorEntry(byName, raw);
        var type = typeName(change.get_Type());
        author.color = author.color || color(change);
        author.changes.push({index: index, type: type, label: LABELS[type] || 'Изменение', value: valueText(change.get_Value()), date: change.get_DateTime(), para: paragraphId(change), context: paragraphText(change)});
      });
      if (byName[raw]) byName[raw].suggestions = groupSuggestions(raw, byName[raw].changes);
    });
    var comments = api.asc_GetCommentsReportByAuthors ? api.asc_GetCommentsReportByAuthors() : {};
    Object.keys(comments).forEach(function (raw) {
      (comments[raw] || []).forEach(function (entry) {
        var data = entry.Data;
        // GetDateTime() is already shifted to local time; m_sOOTime holds UTC milliseconds.
        var utc = parseInt(data.m_sOOTime, 10);
        var date = isNaN(utc) ? data.GetDateTime() : utc;
        var decision = parseDecision(raw, data.GetText(), !!entry.Top);
        if (decision) {
          decision.date = date;
          decisions.push(decision);
          return;
        }
        var author = authorEntry(byName, raw);
        author.color = author.color || userColor(data.GetUserId ? data.GetUserId() : '', raw);
        author.comments.push({reply: !entry.Top, text: data.GetText() || '', quote: entry.Top && data.GetQuoteText ? data.GetQuoteText() || '' : '', date: date});
      });
    });
    var authors = Object.keys(byName).map(function (raw) { return byName[raw]; });
    authors.sort(function (a, b) { return a.order - b.order || a.name.localeCompare(b.name); });
    decisions.sort(function (a, b) { return Number(a.date) - Number(b.date); });
    return {authors: authors, decisions: decisions};
  }

  // Lock tag: "qms-lock|<user id>|<stamp>|<name>", each part URI-encoded.
  function lockTag(me) {
    return [LOCK_TAG, me.id, me.stamp, me.name].map(encodeURIComponent).join('|');
  }

  function collectLocks(api) {
    var doc = logicDocument(api);
    if (!doc || !doc.GetAllContentControls) return [];
    return doc.GetAllContentControls().filter(function (control) {
      return (control.GetTag() || '').split('|')[0] === LOCK_TAG;
    }).map(function (control) {
      var parts = control.GetTag().split('|').map(function (part) {
        try { return decodeURIComponent(part); } catch (err) { return part; }
      });
      var text = control.GetInnerText ? control.GetInnerText() : '';
      return {id: control.GetId(), userId: parts[1] || '', stage: stageText(parts[2]), name: parts[3] || control.GetAlias() || '', text: text.replace(/\s+/g, ' ').trim().slice(0, 160)};
    });
  }

  function time(value) {
    var date = new Date(typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value);
    return isNaN(date) ? '' : date.toLocaleString('ru-RU', {day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'});
  }

  function element(tag, className, text) {
    var node = window.document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function notify(text, isError) {
    var box = window.document.getElementById('message');
    box.textContent = text || '';
    box.className = text ? (isError ? 'message error' : 'message') : 'message hidden';
    if (text) window.document.getElementById('actions').classList.remove('hidden');
  }

  // Wrapping a fragment into a content control is not a text change: keep it out of tracked changes,
  // otherwise the lock would appear as the reviewer's insertion of the whole fragment.
  function withoutTracking(api, action) {
    var tracking = api.asc_GetLocalTrackRevisions();
    api.asc_SetLocalTrackRevisions(false);
    try {
      return action();
    } finally {
      api.asc_SetLocalTrackRevisions(tracking);
    }
  }

  function lockSelection() {
    var api = editorApi();
    var doc = api && logicDocument(api);
    if (!doc) return;
    if (doc.IsSelectionEmpty()) return notify('Выделите в документе текст, который нужно заблокировать.', true);
    var me = viewer();
    var Asc = window.parent.Asc;
    var props = new window.parent.AscCommon.CContentControlPr();
    props.put_Lock(Asc.c_oAscSdtLockType.SdtContentLocked);
    props.put_Tag(lockTag(me));
    props.put_Alias('Заблокировано: ' + me.name + (me.stamp ? ' (' + stageText(me.stamp) + ')' : ''));
    var result = withoutTracking(api, function () {
      return api.asc_AddContentControl(Asc.c_oAscSdtLevelType.Inline, props) || api.asc_AddContentControl(Asc.c_oAscSdtLevelType.Block, props);
    });
    notify(result ? 'Фрагмент заблокирован: менять его может только разработчик документа.' : 'Не удалось заблокировать: фрагмент уже заблокирован или выделение пересекает другую блокировку.', !result);
    refresh();
  }

  function unlock(id) {
    var api = editorApi();
    if (!api) return;
    var Asc = window.parent.Asc;
    var props = new window.parent.AscCommon.CContentControlPr();
    props.put_Lock(Asc.c_oAscSdtLockType.Unlocked);
    withoutTracking(api, function () {
      api.asc_SetContentControlProperties(props, id);
      api.asc_RemoveContentControlWrapper(id);
    });
    notify('Блокировка снята.');
    refresh();
  }

  // The change objects of the editor go stale after every accept/reject: look each piece up afresh.
  function matchingChanges(api, raw, piece) {
    return (api.asc_GetTrackRevisionsReportByAuthors()[raw] || []).filter(function (change) {
      return typeName(change.get_Type()) === piece.type && valueText(change.get_Value()) === piece.value &&
        change.get_DateTime() === piece.date && paragraphId(change) === piece.para;
    });
  }

  function clip(value) {
    var text = String(value).replace(/\s+/g, ' ');
    return text.length > DECISION_TEXT_LIMIT ? text.slice(0, DECISION_TEXT_LIMIT) + '…' : text;
  }

  // Second precision, as DOCX stores the time of a tracked change.
  function isoSeconds(value) {
    var when = new Date(Number(value));
    return isNaN(when) ? '' : when.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  // "Вставлено: «…»" per piece: in the decision text, and to recognise an already recorded decision.
  function pieceLines(suggestion) {
    return suggestion.pieces.map(function (piece) {
      return piece.value ? piece.label + ': «' + clip(piece.value) + '»' : piece.label;
    });
  }

  function decisionText(author, suggestion, decision, text) {
    var when = isoSeconds(suggestion.date);
    var lines = [DECISION_HEADS[decision], 'Автор правки: ' + author.name + (author.stage ? ' (' + author.stage + ')' : '') + (when ? ', ' + when : '')]
      .concat(pieceLines(suggestion));
    if (text) lines.push((decision === 'REJECTED' ? 'Обоснование: ' : 'Комментарий: ') + text);
    return lines.join('\n');
  }

  // A comment on the whole document: it outlives the decided text, and comments are immutable.
  function addDocumentComment(api, text) {
    var parent = window.parent;
    var controller = parent.DE.getController('Common.Controllers.Comments');
    var data = new parent.Asc.asc_CCommentDataWord(null);
    var now = new Date();
    data.asc_putText(text);
    data.asc_putTime(controller.utcDateToString(now));
    data.asc_putOnlyOfficeTime(controller.ooDateToString(now));
    data.asc_putUserId(controller.currentUserId);
    data.asc_putUserName(parent.AscCommon.UserInfoParser.getCurrentName());
    data.asc_putDocumentFlag(true);
    data.asc_putSolved(false);
    api.asc_addComment(data);
  }

  function decide(author, suggestion, decision, text) {
    var api = editorApi();
    if (!api) return;
    text = (text || '').trim();
    if (decision === 'REJECTED' && !text) return notify('Укажите обоснование: без него правку отклонить нельзя.', true);
    var decided = 0;
    for (var i = 0; i < suggestion.pieces.length; i++) {
      var piece = suggestion.pieces[i];
      var before = matchingChanges(api, author.raw, piece);
      if (!before.length) break;
      if (decision === 'ACCEPTED') api.asc_AcceptChanges(before[0]);
      else api.asc_RejectChanges(before[0]);
      if (matchingChanges(api, author.raw, piece).length >= before.length) break;
      decided++;
    }
    pending = null;
    if (!decided) {
      notify('Не удалось: правку уже обработали или этот абзац сейчас правит другой пользователь.', true);
    } else {
      addDocumentComment(api, decisionText(author, suggestion, decision, text));
      decidedKeys[suggestion.key] = true;
      notify(decision === 'ACCEPTED' ? 'Правка принята.' : 'Правка отклонена, обоснование записано в документ.');
    }
    signature = '';
    refresh();
  }

  // A suggestion already gone from the text (edited away directly): only the decision is recorded.
  function record(author, suggestion, decision, text) {
    var api = editorApi();
    if (!api) return;
    text = (text || '').trim();
    if (decision === 'REJECTED' && !text) return notify('Укажите обоснование: без него правку отклонить нельзя.', true);
    addDocumentComment(api, decisionText(author, suggestion, decision, text));
    decidedKeys[suggestion.key] = true;
    pending = null;
    notify('Решение по удалённой правке записано в документ.');
    signature = '';
    refresh();
  }

  // Suggestions seen in this session that are no longer in the text and have no decision: deleted or
  // retyped by the owner directly. One only edited inside (the owner typed into it) reappears as a
  // newer suggestion of the same author, kind and time, and is not reported.
  function orphans(state) {
    tick++;
    var present = {};
    state.authors.forEach(function (author) {
      author.suggestions.forEach(function (suggestion) {
        present[suggestion.key] = true;
        if (!known[suggestion.key]) known[suggestion.key] = {author: {raw: author.raw, name: author.name, stage: author.stage, color: author.color}, suggestion: suggestion, seen: tick};
      });
    });
    var shape = function (suggestion) { return suggestion.pieces.map(function (p) { return p.type + '@' + p.date; }).join(); };
    return Object.keys(known).filter(function (key) {
      var entry = known[key];
      if (present[key] || decidedKeys[key]) return false;
      var stillThere = state.authors.some(function (author) {
        return author.raw === entry.author.raw && author.suggestions.some(function (s) {
          return shape(s) === shape(entry.suggestion) && known[s.key].seen > entry.seen;
        });
      });
      // Several suggestions of one reviewer often share a second: the text tells them apart.
      var lines = pieceLines(entry.suggestion).join('\n');
      var recorded = state.decisions.some(function (d) {
        return d.suggestionName === entry.author.name && d.suggestionDate === isoSeconds(entry.suggestion.date) && d.changes.join('\n') === lines;
      });
      return !stillThere && !recorded;
    }).map(function (key) { return known[key]; });
  }

  function goToLock(id) {
    var api = editorApi();
    if (!api) return;
    try {
      if (api.asc_SelectContentControl) api.asc_SelectContentControl(id);
      else logicDocument(api).SelectContentControl(id);
    } catch (err) {
      // Navigation is a convenience only.
    }
  }

  function button(className, text, onClick) {
    var node = element('button', className, text);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  }

  function openForm(key, decision) {
    pending = {key: key, decision: decision, text: ''};
    if (latest) render(latest);
  }

  function closeForm() {
    pending = null;
    signature = '';
    refresh();
  }

  // Accept (comment optional) or reject (reason required) one suggestion; for one already gone from
  // the text (orphan) only the decision is recorded.
  function decisionControls(author, suggestion, orphan) {
    var box = element('div', 'decide');
    if (!pending || pending.key !== suggestion.key) {
      box.append(
        button('link', 'Принять', function () { openForm(suggestion.key, 'ACCEPTED'); }),
        button('link reject', 'Отклонить', function () { openForm(suggestion.key, 'REJECTED'); }));
      return box;
    }
    var rejecting = pending.decision === 'REJECTED';
    var input = element('textarea', 'decide-text');
    input.rows = 3;
    input.value = pending.text;
    input.placeholder = rejecting ? 'Почему правка не принимается' : 'Комментарий к принятию';
    var confirm = button('decide-confirm' + (rejecting ? ' reject' : ''), rejecting ? 'Отклонить правку' : 'Принять правку', function () {
      (orphan ? record : decide)(author, suggestion, pending.decision, input.value);
    });
    confirm.disabled = rejecting && !pending.text.trim();
    input.addEventListener('input', function () {
      pending.text = input.value;
      confirm.disabled = rejecting && !input.value.trim();
    });
    var actions = element('div', 'decide-actions');
    actions.append(confirm, button('link', 'Отмена', closeForm));
    box.append(element('label', 'decide-label', rejecting ? 'Обоснование отклонения (обязательно)' : 'Комментарий (необязательно)'), input, actions);
    window.setTimeout(function () { input.focus(); }, 0);
    return box;
  }

  function renderAuthors(list, authors, me) {
    if (!authors.length) {
      list.append(element('div', 'empty', 'Предложенные правки и комментарии появятся здесь с именем автора, этапом и временем.'));
      return;
    }
    authors.forEach(function (author) {
      var block = element('section', 'author');
      var head = element('div', 'author-head');
      var swatch = element('span', 'swatch');
      swatch.style.background = author.color;
      var title = element('div', 'title');
      title.append(element('div', 'name', author.name));
      var counts = 'правок ' + author.suggestions.length + ' · комментариев ' + author.comments.length;
      title.append(element('div', 'stage', author.stage ? author.stage + ' · ' + counts : counts));
      head.append(swatch, title);
      block.append(head);
      author.comments.forEach(function (note) {
        var row = element('div', 'change note');
        row.style.borderLeftColor = author.color;
        row.append(element('div', 'what', (note.reply ? 'Ответ' : 'Комментарий') + ' · ' + time(note.date)));
        row.append(element('div', 'value', note.text));
        if (note.quote) row.append(element('div', 'context', 'к фрагменту: «' + note.quote + '»'));
        block.append(row);
      });
      author.suggestions.forEach(function (suggestion) {
        var first = suggestion.pieces[0];
        var row = element('button', 'change');
        row.type = 'button';
        row.style.borderLeftColor = author.color;
        row.title = 'Перейти к правке';
        row.append(element('div', 'what', (suggestion.pieces.length > 1 ? 'Заменено' : first.label) + ' · ' + time(suggestion.date)));
        suggestion.pieces.forEach(function (piece) {
          if (piece.value) row.append(element('div', 'value' + (piece.type === 'TextAdd' ? ' add' : piece.type === 'TextRem' ? ' del' : ''), '«' + piece.value + '»'));
        });
        if (suggestion.context) row.append(element('div', 'context', suggestion.context));
        row.addEventListener('click', function () { goTo(author.raw, first.index); });
        block.append(row);
        if (me.canDecide) block.append(decisionControls(author, suggestion));
      });
      list.append(block);
    });
  }

  function renderOrphans(list, entries) {
    if (!entries.length) return;
    var block = element('section', 'orphans');
    block.append(element('div', 'section-title', 'Правки исчезли без решения · ' + entries.length));
    block.append(element('div', 'hint', 'Текст правки изменён напрямую. Отмените действие (Ctrl+Z) или оформите решение.'));
    entries.forEach(function (entry) {
      var row = element('div', 'change note');
      row.style.borderLeftColor = entry.author.color;
      row.append(element('div', 'what', entry.author.name + (entry.author.stage ? ' · ' + entry.author.stage : '') + ' · ' + time(entry.suggestion.date)));
      entry.suggestion.pieces.forEach(function (piece) {
        row.append(element('div', 'value', piece.value ? piece.label + ': «' + piece.value + '»' : piece.label));
      });
      block.append(row, decisionControls(entry.author, entry.suggestion, true));
    });
    list.append(block);
  }

  // What the owner decided, with the reason: the reviewer sees the outcome of every suggestion.
  function renderDecisions(list, decisions) {
    if (!decisions.length) return;
    var block = element('section', 'decisions');
    block.append(element('div', 'section-title', 'Решения автора · ' + decisions.length));
    decisions.forEach(function (item) {
      var accepted = item.decision === 'ACCEPTED';
      var row = element('div', 'decision ' + (accepted ? 'accepted' : 'rejected'));
      row.append(element('div', 'what', (accepted ? 'Принята' : 'Отклонена') + ' · ' + time(item.date) + ' · ' + item.by));
      if (item.suggestionAuthor) row.append(element('div', 'context', item.suggestionAuthor));
      item.changes.forEach(function (line) { row.append(element('div', 'value', line)); });
      if (item.reason) row.append(element('div', 'reason', (accepted ? 'Комментарий: ' : 'Обоснование: ') + item.reason));
      block.append(row);
    });
    list.append(block);
  }

  function renderLocks(list, locks, me) {
    if (!locks.length) return;
    var block = element('section', 'locks');
    block.append(element('div', 'section-title', 'Заблокированные фрагменты · ' + locks.length));
    locks.forEach(function (lock) {
      var row = element('div', 'lock');
      row.append(element('div', 'value', '«' + lock.text + '»'));
      row.append(element('div', 'context', lock.name + (lock.stage ? ' · ' + lock.stage : '')));
      var actions = element('div', 'lock-actions');
      var go = element('button', 'link', 'Перейти');
      go.type = 'button';
      go.addEventListener('click', function () { goToLock(lock.id); });
      actions.append(go);
      if (me.canUnlockAny || (me.canLock && lock.userId === me.id)) {
        var release = element('button', 'link', 'Снять');
        release.type = 'button';
        release.addEventListener('click', function () { unlock(lock.id); });
        actions.append(release);
      }
      row.append(actions);
      block.append(row);
    });
    list.append(block);
  }

  function render(state) {
    var suggestions = state.authors.reduce(function (sum, author) { return sum + author.suggestions.length; }, 0);
    var comments = state.authors.reduce(function (sum, author) { return sum + author.comments.length; }, 0);
    window.document.getElementById('summary').textContent = 'Правок без решения: ' + suggestions + ' · комментариев: ' + comments +
      (state.decisions.length ? ' · решений: ' + state.decisions.length : '');
    window.document.getElementById('lock').classList.toggle('hidden', !state.me.canLock);
    var message = window.document.getElementById('message');
    window.document.getElementById('actions').classList.toggle('hidden', !state.me.canLock && message.classList.contains('hidden'));
    var list = window.document.getElementById('list');
    list.replaceChildren();
    renderOrphans(list, state.orphans);
    renderLocks(list, state.locks, state.me);
    renderAuthors(list, state.authors, state.me);
    renderDecisions(list, state.decisions);
  }

  function refresh() {
    var api = editorApi();
    if (!api) return;
    subscribe(api);
    var state;
    try {
      var collected = collectAuthors(api);
      state = {authors: collected.authors, decisions: collected.decisions, locks: collectLocks(api), me: viewer(), orphans: []};
      if (state.me.canDecide) state.orphans = orphans(state);
    } catch (err) {
      return; // the document is being rebuilt; the next tick will succeed
    }
    latest = state;
    // An open decision form keeps its text and focus; the list catches up when it closes.
    if (pending) return;
    var next = JSON.stringify(state);
    if (next === signature) return;
    signature = next;
    render(state);
  }

  // Put the cursor at the paragraph start and step through changes until this one is current.
  function goTo(raw, index) {
    var api = editorApi();
    if (!api) return;
    try {
      var target = api.asc_GetTrackRevisionsReportByAuthors()[raw][index];
      var paragraph = target.GetElement && target.GetElement();
      if (paragraph && paragraph.MoveCursorToStartPos && paragraph.Document_SetThisElementCurrent) {
        paragraph.MoveCursorToStartPos(false);
        paragraph.Document_SetThisElementCurrent(true);
      }
      for (var step = 0; step < 50; step++) {
        api.asc_GetNextRevisionsChange();
        var current = api.asc_GetRevisionsChangesStack ? api.asc_GetRevisionsChangesStack() : [];
        if (current && current.some(function (change) { return change.get_UserName() === raw && change.get_DateTime() === target.get_DateTime(); })) break;
      }
    } catch (err) {
      // Navigation is a convenience: the list stays valid even if the editor refuses to move.
    }
  }

  // Bursts of events (typing, a batch of co-author changes) collapse into one refresh.
  var scheduled = null;
  function soon() {
    if (scheduled) return;
    scheduled = window.setTimeout(function () {
      scheduled = null;
      refresh();
    }, SETTLE_MS);
  }

  // Co-authors' changes and comments arrive as editor events; own typing and clicks happen in the
  // editor frame, which shares our origin.
  var subscribed = false;
  function subscribe(api) {
    if (subscribed) return;
    subscribed = true;
    EDITOR_EVENTS.forEach(function (name) {
      try {
        api.asc_registerCallback(name, soon);
      } catch (err) {
        // older engines lack some events; the timer covers them
      }
    });
    ['keyup', 'mouseup'].forEach(function (type) {
      window.parent.document.addEventListener(type, soon, true);
    });
  }

  function start() {
    if (timer) return;
    window.document.getElementById('lock').addEventListener('click', lockSelection);
    refresh();
    timer = window.setInterval(refresh, REFRESH_MS);
  }

  // Data is read straight from the editor, so the panel does not wait for the plugin handshake
  // (the left-docked variant in comment-only mode never receives init).
  window.addEventListener('load', start);
  window.Asc.plugin.init = start;
  window.Asc.plugin.button = function () {
    window.clearInterval(timer);
    this.executeCommand('close', '');
  };
  window.Asc.plugin.onThemeChanged = function (theme) {
    window.Asc.plugin.onThemeChangedBase(theme);
  };
  window.Asc.plugin.event_onKeyDown = soon;
  window.Asc.plugin.event_onClick = soon;
  window.Asc.plugin.event_onTargetPositionChanged = soon;
})(window);
