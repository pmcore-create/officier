'use strict';
// Editor access policy of the QMS module: document status x role in the document -> editor mode.
// The portal has already checked row-level visibility; this is the editor-side enforcement
// (permissions travel in the signed config, so the browser cannot widen them).
const {GatewayError} = require('./errors');

const STATUSES = ['DRAFT', 'ON_REVIEW', 'ON_APPROVAL', 'RETURNED', 'ACTIVE', 'ON_REVISION', 'ARCHIVED', 'CANCELLED'];
const ROLES = ['OWNER', 'REVIEWER', 'SIGNER', 'SUPERVISOR', 'READER'];
// Employees outside the route only ever see published versions (QMS logic, section 2).
const READER_STATUSES = ['ACTIVE', 'ON_REVISION', 'ARCHIVED', 'CANCELLED'];
// The owner, reviewers and signers follow the discussion while the route is in progress.
const ROUTE_STATUSES = ['ON_REVIEW', 'ON_APPROVAL', 'RETURNED'];
const ROUTE_ROLES = ['OWNER', 'REVIEWER', 'SIGNER'];

// Writable modes; every other status/role pair is read-only.
// Reviewers and signers both work in review mode on their stage; the owner answers comments
// while the document is on the route (review and approval stages).
const WRITABLE = {
  DRAFT: {OWNER: 'EDIT'},
  RETURNED: {OWNER: 'DECIDE'},
  ON_REVIEW: {OWNER: 'COMMENT', REVIEWER: 'REVIEW'},
  ON_APPROVAL: {OWNER: 'COMMENT', SIGNER: 'REVIEW'}
};

const MODES = {
  // Owner prepares the draft; no route yet, nothing to track.
  EDIT: {editorMode: 'edit', permissions: {edit: true, review: false, comment: true}, trackChanges: false},
  // Owner reworks a returned document and accepts or rejects reviewers' suggestions. The editor's own
  // accept/reject buttons stay off (review: false): decisions go through the review panel, which
  // demands a reason for every rejection and records each decision in the document (QMS logic 5.4).
  DECIDE: {editorMode: 'edit', permissions: {edit: true, review: false, comment: true}, trackChanges: false},
  // Route participant: every change becomes a tracked suggestion, accept/reject is unavailable.
  REVIEW: {editorMode: 'edit', permissions: {edit: false, review: true, comment: true}, trackChanges: true},
  // Owner while the document is on the route: answers comments, text stays unchanged.
  COMMENT: {editorMode: 'edit', permissions: {edit: false, review: false, comment: true}},
  VIEW: {editorMode: 'view', permissions: {edit: false, review: false, comment: false}}
};

// Comments and replies are immutable for everyone: a wrong comment is closed by a new reply.
// Empty group lists make UserInfoParser.canEditComment/canDeleteComment false for all authors.
const COMMON_PERMISSIONS = {
  chat: false,
  protect: false,
  editCommentAuthorOnly: true,
  deleteCommentAuthorOnly: true,
  commentGroups: {edit: [], remove: []}
};

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

// The stamp is stored in DOCX as the author prefix of every suggestion and comment ("R2.S1<NBSP>Name").
function stampFor(role, round, stageNo) {
  if (role === 'REVIEWER' || role === 'SIGNER') return `R${round}.S${stageNo}`;
  if (role === 'OWNER') return `R${round}.OWNER`;
  return null;
}

function resolvePolicy({status, role, round = 0, stageNo, fileType = 'docx'}) {
  const errors = [];
  if (!STATUSES.includes(status)) errors.push(`access.status must be one of ${STATUSES.join(', ')}`);
  if (!ROLES.includes(role)) errors.push(`access.role must be one of ${ROLES.join(', ')}`);
  if (!Number.isInteger(round) || round < 0) errors.push('access.round must be a non-negative integer');
  if (errors.length) throw new GatewayError(422, 'GW-422-INVALID', 'Invalid access context', errors);

  if (role === 'READER' && !READER_STATUSES.includes(status)) {
    throw new GatewayError(403, 'GW-403-NOT-VISIBLE', `Document in status ${status} is not visible to readers`);
  }

  // Only the DOCX source is edited; PDF and attachments are always viewed.
  let mode = fileType === 'docx' && WRITABLE[status] && WRITABLE[status][role] || 'VIEW';
  if (mode === 'REVIEW' && (!positiveInteger(round) || !positiveInteger(stageNo))) {
    throw new GatewayError(422, 'GW-422-INVALID', 'Invalid access context', ['access.round and access.stageNo are required for a route participant in review mode']);
  }

  const definition = MODES[mode];
  const reviewVisible = role !== 'READER';
  // Officier review panel (docker/plugins/qms-review*): every change and comment with its author.
  // The editor has a right side panel only where the text can be changed; elsewhere it goes left.
  let reviewPanel = null;
  if (reviewVisible && ROUTE_STATUSES.includes(status)) {
    reviewPanel = definition.permissions.edit || definition.permissions.review ? 'right' : 'left';
  }
  const customization = {
    review: {
      trackChanges: definition.trackChanges,
      reviewDisplay: reviewVisible ? 'markup' : 'final',
      hideReviewDisplay: !reviewVisible
    },
    comments: reviewVisible,
    // Officier extension (docker/branding/apply.js): the native comments panel opens on the left
    // when the review panel takes the right side.
    officier: {openComments: reviewPanel === 'right' && ROUTE_ROLES.includes(role)}
  };
  return {
    mode,
    editorMode: definition.editorMode,
    reviewPanel,
    permissions: {
      ...definition.permissions,
      ...COMMON_PERMISSIONS,
      commentGroups: {edit: [], remove: []},
      // Fragment locks are content controls: only the owner working on the text may change or remove
      // them in the editor UI; reviewers and signers lock fragments through the review panel.
      modifyContentControl: mode === 'EDIT' || mode === 'DECIDE'
    },
    customization,
    stamp: mode === 'VIEW' ? null : stampFor(role, round, stageNo),
    reviewVisible
  };
}

module.exports = {STATUSES, ROLES, resolvePolicy};
