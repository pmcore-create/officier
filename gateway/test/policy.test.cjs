const {test} = require('node:test');
const assert = require('node:assert/strict');
const {resolvePolicy, STATUSES, ROLES} = require('../src/policy');

const mode = context => resolvePolicy(context).mode;

test('Owner edits the draft and decides on suggestions after a return', () => {
  const draft = resolvePolicy({status: 'DRAFT', role: 'OWNER'});
  assert.equal(draft.mode, 'EDIT');
  assert.equal(draft.editorMode, 'edit');
  assert.deepEqual([draft.permissions.edit, draft.permissions.review], [true, false]);
  assert.equal(draft.stamp, 'R0.OWNER');

  const returned = resolvePolicy({status: 'RETURNED', role: 'OWNER', round: 2});
  assert.equal(returned.mode, 'DECIDE');
  // The editor's accept/reject buttons are off: decisions with reasons go through the review panel.
  assert.deepEqual([returned.permissions.edit, returned.permissions.review], [true, false]);
  assert.equal(returned.reviewPanel, 'right');
  assert.equal(returned.customization.review.trackChanges, false);
  assert.equal(returned.stamp, 'R2.OWNER');
});

test('Route participant reviews only in track changes, the owner only comments meanwhile', () => {
  const reviewer = resolvePolicy({status: 'ON_REVIEW', role: 'REVIEWER', round: 2, stageNo: 3});
  assert.equal(reviewer.mode, 'REVIEW');
  assert.deepEqual([reviewer.permissions.edit, reviewer.permissions.review, reviewer.permissions.comment], [false, true, true]);
  assert.equal(reviewer.customization.review.trackChanges, true);
  assert.equal(reviewer.stamp, 'R2.S3');

  const owner = resolvePolicy({status: 'ON_REVIEW', role: 'OWNER', round: 2});
  assert.equal(owner.mode, 'COMMENT');
  assert.deepEqual([owner.permissions.edit, owner.permissions.review, owner.permissions.comment], [false, false, true]);
});

test('Signer reviews on the approval stage while the owner answers comments', () => {
  const signer = resolvePolicy({status: 'ON_APPROVAL', role: 'SIGNER', round: 2, stageNo: 4});
  assert.equal(signer.mode, 'REVIEW');
  assert.deepEqual([signer.permissions.edit, signer.permissions.review, signer.permissions.comment], [false, true, true]);
  assert.equal(signer.customization.review.trackChanges, true);
  assert.equal(signer.stamp, 'R2.S4');
  assert.equal(mode({status: 'ON_APPROVAL', role: 'OWNER', round: 2}), 'COMMENT');
  assert.equal(mode({status: 'ON_APPROVAL', role: 'REVIEWER', round: 2, stageNo: 1}), 'VIEW');
  assert.equal(mode({status: 'ON_APPROVAL', role: 'SUPERVISOR'}), 'VIEW');
  assert.throws(() => resolvePolicy({status: 'ON_APPROVAL', role: 'SIGNER', round: 2}), {code: 'GW-422-INVALID'});
});

test('Review panel and comments open with the document for everyone on the route', () => {
  const cases = [
    // status, role, panel side, native comments panel on the left
    ['ON_REVIEW', 'REVIEWER', 'right', true],
    ['ON_APPROVAL', 'SIGNER', 'right', true],
    ['RETURNED', 'OWNER', 'right', true],
    ['ON_REVIEW', 'OWNER', 'left', false],
    ['ON_APPROVAL', 'OWNER', 'left', false],
    ['ON_APPROVAL', 'REVIEWER', 'left', false],
    ['ON_REVIEW', 'SUPERVISOR', 'left', false]
  ];
  for (const [status, role, side, comments] of cases) {
    const policy = resolvePolicy({status, role, round: 1, stageNo: 1});
    assert.deepEqual([policy.reviewPanel, policy.customization.officier.openComments], [side, comments], `${status}/${role}`);
  }
  for (const [status, role] of [['DRAFT', 'OWNER'], ['ACTIVE', 'READER'], ['ACTIVE', 'SUPERVISOR']]) {
    const policy = resolvePolicy({status, role});
    assert.deepEqual([policy.reviewPanel, policy.customization.officier.openComments], [null, false], `${status}/${role}`);
  }
});

test('Published versions are never editable', () => {
  for (const role of ROLES) {
    for (const status of ['ACTIVE', 'ON_REVISION', 'ARCHIVED', 'CANCELLED']) {
      assert.equal(mode({status, role, round: 1, stageNo: 1}), 'VIEW', `${status}/${role}`);
    }
  }
  assert.equal(mode({status: 'ON_REVIEW', role: 'SIGNER'}), 'VIEW');
  assert.equal(mode({status: 'ON_REVIEW', role: 'SUPERVISOR'}), 'VIEW');
  assert.equal(mode({status: 'DRAFT', role: 'REVIEWER', round: 1, stageNo: 1}), 'VIEW');
});

test('Only the DOCX source is ever editable', () => {
  assert.equal(mode({status: 'DRAFT', role: 'OWNER', fileType: 'pdf'}), 'VIEW');
  assert.equal(mode({status: 'ON_REVIEW', role: 'REVIEWER', round: 1, stageNo: 1, fileType: 'xlsx'}), 'VIEW');
});

test('Only the owner working on the text may change fragment locks in the editor', () => {
  assert.equal(resolvePolicy({status: 'DRAFT', role: 'OWNER'}).permissions.modifyContentControl, true);
  assert.equal(resolvePolicy({status: 'RETURNED', role: 'OWNER', round: 1}).permissions.modifyContentControl, true);
  for (const context of [
    {status: 'ON_REVIEW', role: 'REVIEWER', round: 1, stageNo: 1},
    {status: 'ON_APPROVAL', role: 'SIGNER', round: 1, stageNo: 4},
    {status: 'ON_REVIEW', role: 'OWNER', round: 1},
    {status: 'ON_REVIEW', role: 'SUPERVISOR'},
    {status: 'ACTIVE', role: 'READER'}
  ]) {
    assert.equal(resolvePolicy(context).permissions.modifyContentControl, false, `${context.status}/${context.role}`);
  }
});

test('Comments are immutable and chat is off in every mode', () => {
  for (const status of STATUSES) {
    for (const role of ROLES.filter(item => item !== 'READER')) {
      const {permissions} = resolvePolicy({status, role, round: 1, stageNo: 1});
      assert.deepEqual(permissions.commentGroups, {edit: [], remove: []});
      assert.equal(permissions.chat, false);
      assert.equal(permissions.protect, false);
    }
  }
});

test('Employees see only published versions and no review traces', () => {
  const reader = resolvePolicy({status: 'ACTIVE', role: 'READER'});
  assert.equal(reader.mode, 'VIEW');
  assert.equal(reader.reviewVisible, false);
  assert.equal(reader.customization.comments, false);
  assert.equal(reader.customization.review.reviewDisplay, 'final');
  assert.equal(reader.stamp, null);
  for (const status of ['DRAFT', 'ON_REVIEW', 'ON_APPROVAL', 'RETURNED']) {
    assert.throws(() => resolvePolicy({status, role: 'READER'}), {code: 'GW-403-NOT-VISIBLE'});
  }
  assert.equal(resolvePolicy({status: 'ACTIVE', role: 'SUPERVISOR'}).reviewVisible, true);
});

test('Invalid contexts are rejected with details', () => {
  assert.throws(() => resolvePolicy({status: 'PUBLISHED', role: 'OWNER'}), {code: 'GW-422-INVALID'});
  assert.throws(() => resolvePolicy({status: 'DRAFT', role: 'AUTHOR'}), {code: 'GW-422-INVALID'});
  assert.throws(() => resolvePolicy({status: 'ON_REVIEW', role: 'REVIEWER', round: 1}), {code: 'GW-422-INVALID'});
});
