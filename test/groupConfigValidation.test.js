const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isValidReadingGroupId,
  DEFAULT_GROUP_CONFIG_FEATURES,
  DEFAULT_GROUP_CONFIG_SCHEDULES,
  validateGroupConfigSchedules
} = require('../db');

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

test('new group pairs preserve the legacy delivery times by default', () => {
  assert.deepEqual(DEFAULT_GROUP_CONFIG_SCHEDULES, {
    poll: { hour: 9, minute: 0 },
    sentence: { weekdays: [2, 4], hour: 22, minute: 30 },
    esmaulhusna: { weekdays: [3, 5], hour: 22, minute: 30 }
  });
});

test('group schedules require valid times and two different weekly days', () => {
  const valid = validateGroupConfigSchedules({
    poll: { hour: 8, minute: 15 },
    sentence: { weekdays: [1, 6], hour: 20, minute: 5 },
    esmaulhusna: { weekdays: [2, 7], hour: 21, minute: 45 }
  });
  assert.equal(valid.success, true);
  assert.deepEqual(valid.schedules.sentence.weekdays, [1, 6]);

  assert.equal(validateGroupConfigSchedules({ poll: { hour: 24, minute: 0 } }).success, false);
  assert.equal(validateGroupConfigSchedules({ sentence: { weekdays: [2, 2] } }).success, false);
  assert.equal(validateGroupConfigSchedules({ esmaulhusna: { weekdays: [0, 8] } }).success, false);
});
