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
    var custom = main && main.editorConfig && main.editorConfig.customization || {};
    var user = options.user || {};
    var author = parseAuthor(user.fullname || '');
    var canDecide = !!options.isEdit && !options.isReviewOnly;
    return {
      id: String(user.id || ''), name: author.name, stamp: author.stamp,
      canLock: !!options.isReviewOnly,
      canUnlockAny: !!options.isEdit && !options.isReviewOnly && options.canEditContentControl !== false,
      // The owner reworking the document: the editor's own accept/reject is off (gateway policy).
      canDecide: canDecide,
      // After a return and in a new edition the route sees what the owner changed (gateway policy,
      // trackOwnChanges). The editor applies review.trackChanges only with permissions.review, which
      // the owner does not have, so the panel keeps tracking on.
      trackOwn: canDecide && !!(custom.officier && custom.officier.trackOwnChanges)
    };
  }

  function isOwnerStamp(stamp) {
    return /\.OWNER$/.test(stamp || '');
  }

  function keepTracking(api) {
    if (!api.asc_IsTrackRevisions()) api.asc_SetLocalTrackRevisions(true);
  }

  // The owner's changes of an earlier round were seen by the route of that round: accepted when the
  // owner opens the document again, so the route sees only what changed since its remarks.
  var settledOwners = {};
  function acceptEarlierOwn(api, me) {
    var revisions = api.asc_GetTrackRevisionsReportByAuthors();
    Object.keys(revisions).forEach(function (raw) {
      var stamp = parseAuthor(raw).stamp;
      if (settledOwners[raw] || !isOwnerStamp(stamp) || stamp === me.stamp) return;
      settledOwners[raw] = true;
      withoutTracking(api, function () {
        for (var guard = 0; guard < 1000; guard++) {
          var left = api.asc_GetTrackRevisionsReportByAuthors()[raw] || [];
          if (!left.length) return;
          api.asc_AcceptChanges(left[0]);
          if ((api.asc_GetTrackRevisionsReportByAuthors()[raw] || []).length >= left.length) return;
        }
      });
    });
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
    latestRevisions = revisions;
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
    // The owner's text is tracked after a return: the decision itself must not become a change.
    withoutTracking(api, function () {
      for (var i = 0; i < suggestion.pieces.length; i++) {
        var piece = suggestion.pieces[i];
        var before = matchingChanges(api, author.raw, piece);
        if (!before.length) break;
        if (decision === 'ACCEPTED') api.asc_AcceptChanges(before[0]);
        else api.asc_RejectChanges(before[0]);
        if (matchingChanges(api, author.raw, piece).length >= before.length) break;
        decided++;
      }
    });
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
      // The owner's own changes need no decision: retyping them is ordinary editing.
      if (isOwnerStamp(author.stamp)) return;
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
    // The decision form needs the room of the list; the balloon only starts it.
    if (view !== 'list') setView('list');
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
      var owner = isOwnerStamp(author.stamp);
      var block = element('section', 'author');
      var head = element('div', 'author-head');
      var swatch = element('span', 'swatch');
      swatch.style.background = author.color;
      var title = element('div', 'title');
      title.append(element('div', 'name', author.name));
      var counts = (owner ? 'изменений ' : 'правок ') + author.suggestions.length + ' · комментариев ' + author.comments.length;
      title.append(element('div', 'stage', author.stage ? author.stage + ' · ' + counts : counts));
      head.append(swatch, title);
      block.append(head);
      if (owner && author.suggestions.length) {
        block.append(element('div', 'hint', author.stamp === me.stamp && me.canDecide
          ? 'Ваши изменения после возврата: согласующие увидят их в тексте цветом, решать по ним не нужно.'
          : 'Что изменил автор документа: в тексте выделено его цветом.'));
      }
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
        if (me.canDecide && !owner) block.append(decisionControls(author, suggestion));
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
    var count = function (owner) {
      return state.authors.reduce(function (sum, author) { return isOwnerStamp(author.stamp) === owner ? sum + author.suggestions.length : sum; }, 0);
    };
    var suggestions = count(false);
    var ownChanges = count(true);
    var comments = state.authors.reduce(function (sum, author) { return sum + author.comments.length; }, 0);
    window.document.getElementById('summary').textContent = 'Правок без решения: ' + suggestions + ' · комментариев: ' + comments +
      (ownChanges ? ' · изменений автора: ' + ownChanges : '') + (state.decisions.length ? ' · решений: ' + state.decisions.length : '');
    window.document.getElementById('lock').classList.toggle('hidden', !state.me.canLock);
    var message = window.document.getElementById('message');
    window.document.getElementById('actions').classList.toggle('hidden', !state.me.canLock && message.classList.contains('hidden'));
    var list = window.document.getElementById('list');
    // Rebuilding the list must not throw the reader back to its top.
    var scrolled = list.scrollTop;
    list.replaceChildren();
    renderOrphans(list, state.orphans);
    renderLocks(list, state.locks, state.me);
    renderAuthors(list, state.authors, state.me);
    renderDecisions(list, state.decisions);
    list.scrollTop = scrolled;
    renderNotes(state);
    buildBalloons(state);
  }

  // ---- "Напротив текста": balloons beside their place in the text, as in Word's markup area ----

  var VIEW_KEY = 'officier-qms-review-view';
  var view = 'margin';
  try {
    if (window.localStorage.getItem(VIEW_KEY) === 'list') view = 'list';
  } catch (err) {
    // storage may be unavailable; the margin view is the default
  }
  var latestRevisions = {};
  var balloons = [];
  var layoutKey = '';
  // More balloons than fit beside the visible text, or the end of the document: the wheel then moves
  // the stack itself by this many pixels, so that every balloon can be reached.
  var stackOffset = 0;
  var stackOverflow = 0;

  function setView(next) {
    view = next;
    try {
      window.localStorage.setItem(VIEW_KEY, next);
    } catch (err) {
      // the choice then lasts for this session only
    }
    applyView();
  }

  function applyView() {
    var doc = window.document;
    doc.body.classList.toggle('margin-view', view === 'margin');
    doc.getElementById('margin').classList.toggle('hidden', view !== 'margin');
    doc.getElementById('notes').classList.toggle('hidden', view !== 'margin');
    Array.prototype.forEach.call(doc.querySelectorAll('#views button'), function (node) {
      node.classList.toggle('active', node.getAttribute('data-view') === view);
    });
    layoutKey = '';
  }

  // What the margin cannot show is one click away in the list.
  function renderNotes(state) {
    var notes = window.document.getElementById('notes');
    notes.replaceChildren();
    var lines = [];
    if (state.orphans.length) lines.push('Правки исчезли без решения: ' + state.orphans.length);
    if (state.locks.length) lines.push('Заблокированные фрагменты: ' + state.locks.length);
    if (state.decisions.length) lines.push('Решения автора: ' + state.decisions.length);
    lines.forEach(function (text) {
      notes.append(button('link', text + ' — показать списком', function () { setView('list'); }));
    });
  }

  function commentEntries(api) {
    var doc = logicDocument(api);
    var all = doc && doc.Comments && doc.Comments.GetAllComments ? doc.Comments.GetAllComments() : {};
    return Object.keys(all).map(function (id) { return all[id]; }).filter(function (comment) {
      var data = comment.GetData && comment.GetData();
      if (!data || (comment.IsGlobalComment && comment.IsGlobalComment())) return false;
      return !parseDecision(data.GetUserName(), data.GetText(), true);
    });
  }

  // One balloon per suggestion and per comment thread; anchor() says where its text is.
  function buildBalloons(state) {
    var api = editorApi();
    var cards = window.document.getElementById('cards');
    cards.replaceChildren();
    balloons = [];
    layoutKey = '';
    if (!api) return;
    state.authors.forEach(function (author) {
      var owner = isOwnerStamp(author.stamp);
      author.suggestions.forEach(function (suggestion) {
        var first = suggestion.pieces[0];
        var node = balloonNode(author, (suggestion.pieces.length > 1 ? 'Заменено' : first.label) + (owner ? ' · изменение автора' : ''), suggestion.date);
        suggestion.pieces.forEach(function (piece) {
          if (piece.value) node.append(element('div', 'value' + (piece.type === 'TextAdd' ? ' add' : piece.type === 'TextRem' ? ' del' : ''), '«' + piece.value + '»'));
        });
        if (state.me.canDecide && !owner) {
          var box = element('div', 'decide');
          box.append(
            button('link', 'Принять', function (event) { event.stopPropagation(); openForm(suggestion.key, 'ACCEPTED'); }),
            button('link reject', 'Отклонить', function (event) { event.stopPropagation(); openForm(suggestion.key, 'REJECTED'); }));
          node.append(box);
        }
        node.addEventListener('click', function () { goTo(author.raw, first.index); });
        balloons.push({node: node, color: author.color, anchor: function () {
          var change = (latestRevisions[author.raw] || [])[first.index];
          return change ? changeAnchor(api, change) : null;
        }});
      });
    });
    commentEntries(api).forEach(function (comment) {
      var data = comment.GetData();
      var raw = data.GetUserName();
      var author = parseAuthor(raw);
      var color = userColor(data.GetUserId ? data.GetUserId() : '', raw);
      var utc = parseInt(data.m_sOOTime, 10);
      var node = balloonNode({name: author.name, stage: author.stage, color: color}, 'Комментарий', isNaN(utc) ? data.GetDateTime() : utc);
      node.append(element('div', 'value', data.GetText() || ''));
      for (var i = 0; i < (data.GetRepliesCount ? data.GetRepliesCount() : 0); i++) {
        var reply = data.GetReply(i);
        node.append(element('div', 'reply', parseAuthor(reply.GetUserName()).name + ': ' + (reply.GetText() || '')));
      }
      node.addEventListener('click', function () { selectComment(api, comment.GetId()); });
      balloons.push({node: node, color: color, anchor: function () { return commentAnchor(comment); }});
    });
    if (!balloons.length) {
      cards.append(element('div', 'empty', 'Предложенные правки и комментарии появятся здесь напротив своего места в тексте.'));
      return;
    }
    balloons.forEach(function (item) { cards.append(item.node); });
  }

  function balloonNode(author, what, date) {
    var node = element('div', 'balloon');
    node.style.borderLeftColor = author.color;
    node.append(element('div', 'who', author.name), element('div', 'what', (author.stage ? author.stage + ' · ' : '') + time(date)),
      element('div', 'what', what));
    return node;
  }

  function selectComment(api, id) {
    try {
      if (api.asc_selectComment) api.asc_selectComment(id);
      if (api.asc_showComment) api.asc_showComment(id, false);
    } catch (err) {
      // navigation is a convenience only
    }
  }

  // The line of the change, as the editor positions its own review popup (track-revisions-manager).
  function changeAnchor(api, change) {
    var paragraph = change.GetElement && change.GetElement();
    if (!paragraph || !paragraph.Pages || !paragraph.Lines || !paragraph.Pages.length || !paragraph.Lines.length) return null;
    var place = {Page: 0, Line: 0};
    var start = change.GetStartPos && change.GetStartPos();
    if (start && paragraph.Get_ParaPosByContentPos) {
      var found = paragraph.Get_ParaPosByContentPos(start);
      if (found && paragraph.Pages.length > found.Page && paragraph.Lines.length > found.Line) place = found;
    }
    var page = paragraph.GetAbsolutePage(place.Page);
    var y = paragraph.Pages[place.Page].Y + paragraph.Lines[place.Line].Top;
    var x = logicDocument(api).Get_PageLimits(page).XLimit;
    var transform = paragraph.Get_ParentTextTransform && paragraph.Get_ParentTextTransform();
    if (transform) y = transform.TransformPointY(x, y);
    return {page: page, x: x, y: y};
  }

  function commentAnchor(comment) {
    var info = comment.m_oStartInfo;
    return info && info.PageNum >= 0 ? {page: info.PageNum, x: info.X, y: info.Y} : null;
  }

  // Places the balloons of the visible pages at the height of their text, pushing down the ones that
  // would overlap, and draws a dashed leader from the text side to each balloon.
  function layoutBalloons(force) {
    if (view !== 'margin') return;
    var api = editorApi();
    var doc = api && logicDocument(api);
    var drawing = doc && doc.getDrawingDocument && doc.getDrawingDocument();
    var sdk = window.parent.document.getElementById('editor_sdk');
    var frame = window.frameElement;
    var margin = window.document.getElementById('margin');
    if (!drawing || !sdk || !frame) return;
    var sdkBox = sdk.getBoundingClientRect();
    var frameBox = frame.getBoundingClientRect();
    var marginBox = margin.getBoundingClientRect();
    var control = api.WordControl || {};
    var key = [drawing.m_lDrawingFirst, drawing.m_lDrawingEnd, control.m_dScrollY, control.m_nZoomValue,
      Math.round(sdkBox.top - frameBox.top), Math.round(marginBox.top), margin.clientHeight, margin.clientWidth, balloons.length, stackOffset].join();
    if (!force && key === layoutKey) return;
    layoutKey = key;
    // The panel left of the text (comment-only and view modes) draws its leaders from the right.
    var leftOfText = frameBox.left + frameBox.width / 2 < sdkBox.left + sdkBox.width / 2;
    window.document.body.classList.toggle('docked-left', leftOfText);
    var height = margin.clientHeight;
    var width = margin.clientWidth;
    var above = [];
    var below = [];
    var shown = [];
    balloons.forEach(function (item) {
      var at = null;
      try {
        at = item.anchor();
      } catch (err) {
        at = null; // the document is being rebuilt; the next layout will place it
      }
      item.y = null;
      if (!at) return;
      if (at.page < drawing.m_lDrawingFirst) return above.push(item);
      if (at.page > drawing.m_lDrawingEnd) return below.push(item);
      var point = drawing.ConvertCoordsToCursorWR(at.x, at.y, at.page);
      var y = point.Y + sdkBox.top - frameBox.top - marginBox.top;
      if (y < 0) return above.push(item);
      if (y > height) return below.push(item);
      item.y = y;
      shown.push(item);
    });
    shown.sort(function (a, b) { return a.y - b.y; });
    balloons.forEach(function (item) { item.node.style.display = 'none'; });
    shown.forEach(function (item) {
      item.node.style.display = '';
      item.h = item.node.offsetHeight;
    });
    // As in Word: each balloon at its line, pushed down by the one above; when the stack runs past
    // the bottom, it is pulled up again as far as the top allows.
    var topLimit = above.length ? 30 : 0;
    var bottomLimit = height - (below.length ? 30 : 0);
    var last = topLimit - 6;
    shown.forEach(function (item) {
      item.top = Math.max(item.y - 8, last + 6);
      last = item.top + item.h;
    });
    var ceiling = bottomLimit;
    for (var i = shown.length - 1; i >= 0; i--) {
      shown[i].top = Math.max(Math.min(shown[i].top, ceiling - shown[i].h), topLimit);
      ceiling = shown[i].top - 6;
    }
    // Pulled up to the top and still too long: the rest is reached by moving the stack.
    last = topLimit - 6;
    shown.forEach(function (item) {
      item.top = Math.max(item.top, last + 6);
      last = item.top + item.h;
    });
    stackOverflow = Math.max(0, last - bottomLimit);
    stackOffset = Math.min(Math.max(stackOffset, 0), stackOverflow);
    var hiddenAbove = 0;
    var hiddenBelow = 0;
    var leaders = [];
    var edge = leftOfText ? width : 0;
    var inner = leftOfText ? width - 14 : 14;
    var bend = leftOfText ? width - 7 : 7;
    shown.forEach(function (item) {
      var top = item.top - stackOffset;
      if (top + item.h <= topLimit) {
        item.node.style.display = 'none';
        hiddenAbove++;
        return;
      }
      if (top >= bottomLimit) {
        item.node.style.display = 'none';
        hiddenBelow++;
        return;
      }
      item.node.style.top = top + 'px';
      leaders.push('<path d="M' + edge + ' ' + item.y + ' H' + bend + ' V' + (top + 10) + ' H' + inner + '" fill="none" stroke="' + item.color +
        '" stroke-width="1" stroke-dasharray="3 2"/>');
    });
    window.document.getElementById('links').innerHTML = leaders.join('');
    edgeButton('above', above, hiddenAbove, '▲ Выше: ');
    edgeButton('below', below, hiddenBelow, '▼ Ниже: ');
  }

  // Balloons off screen: those of the text above or below, and those of the stack moved away.
  function edgeButton(id, offText, offStack, text) {
    var node = window.document.getElementById(id);
    var count = offText.length + offStack;
    node.classList.toggle('hidden', !count);
    node.textContent = count ? text + count : '';
    node.onclick = !count ? null : function () {
      if (offStack) {
        moveStack(id === 'above' ? -120 : 120);
      } else {
        offText[id === 'above' ? offText.length - 1 : 0].node.click();
      }
    };
  }

  function moveStack(delta) {
    var next = Math.min(Math.max(stackOffset + delta, 0), stackOverflow);
    if (next === stackOffset) return false;
    stackOffset = next;
    layoutBalloons(true);
    return true;
  }

  // Scrolling over the balloons scrolls the document they follow. Where the document goes no further
  // down (its end), the stack itself moves; up, a moved stack comes back first.
  function scrollDocument(event) {
    event.preventDefault();
    var api = editorApi();
    var control = api && api.WordControl;
    var scroll = control && control.m_oScrollVerApi;
    var delta = event.deltaMode === 1 ? event.deltaY * 40 : event.deltaMode === 2 ? event.deltaY * 400 : event.deltaY;
    if (delta < 0 && moveStack(delta)) return;
    var before = control ? control.m_dScrollY : 0;
    if (scroll && scroll.scrollByY) scroll.scrollByY(delta);
    if (!control || control.m_dScrollY === before) moveStack(delta);
  }

  function followDocument() {
    try {
      layoutBalloons(false);
    } catch (err) {
      // the editor is between states; the next frame retries
    }
    window.requestAnimationFrame(followDocument);
  }

  function refresh() {
    var api = editorApi();
    if (!api) return;
    subscribe(api);
    var state;
    try {
      var me = viewer();
      if (me.trackOwn) {
        keepTracking(api);
        acceptEarlierOwn(api, me);
      }
      var collected = collectAuthors(api);
      state = {authors: collected.authors, decisions: collected.decisions, locks: collectLocks(api), me: me, orphans: []};
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
    Array.prototype.forEach.call(window.document.querySelectorAll('#views button'), function (node) {
      node.addEventListener('click', function () { setView(node.getAttribute('data-view')); });
    });
    window.document.getElementById('margin').addEventListener('wheel', scrollDocument, {passive: false});
    applyView();
    refresh();
    timer = window.setInterval(refresh, REFRESH_MS);
    window.requestAnimationFrame(followDocument);
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
