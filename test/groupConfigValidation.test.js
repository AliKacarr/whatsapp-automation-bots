const test = require('node:test');
const assert = require('node:assert/strict');
const { isValidReadingGroupId, DEFAULT_GROUP_CONFIG_FEATURES } = require('../db');

test('RoTaKip group ids accept Turkish and other Unicode letters', () => {
  assert.equal(isValidReadingGroupId('catıkatı23'), true);
  assert.equal(isValidReadingGroupId('hisarkapisi16'), true);
  assert.equal(isValidReadingGroupId('okuma_grubu-şube2'), true);
});

test('RoTaKip group ids reject unsafe collection-name characters', () => {
  for (const value of ['', 'iki grup', 'users.group', '$group', 'group/name', 'a'.repeat(101)]) {
    assert.equal(isValidReadingGroupId(value), false, value);
  }
});

test('new group pairs use the agreed automation defaults', () => {
  assert.deepEqual(DEFAULT_GROUP_CONFIG_FEATURES, {
    pollEnabled: false,
    voteTrackingEnabled: false,
    messageReadingEnabled: false,
    sentenceEnabled: true,
    weeklyReportEnabled: true,
    weeklyReportQuoteEnabled: true,
    weeklyTableEnabled: true,
    leagueCongratulationEnabled: true,
    esmaulhusnaEnabled: false
  });
});
