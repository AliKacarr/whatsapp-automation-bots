const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LOCAL_ID_MAPPINGS_COLLECTION,
  normalizeLocalIdMappingValues
} = require('../db');

test('Local ID mappings use the requested collection and scoped identity fields', () => {
  assert.equal(LOCAL_ID_MAPPINGS_COLLECTION, 'local_id_mappings');
  assert.deepEqual(
    normalizeLocalIdMappingValues(
      '999999999999999@lid',
      '905550000000@s.whatsapp.net',
      'test-config',
      '120363000000000000@g.us'
    ),
    {
      lid: '999999999999999',
      phone: '905550000000',
      configKey: 'test-config',
      groupId: '120363000000000000@g.us'
    }
  );
});

test('Local ID mappings require configKey and WhatsApp group scope', () => {
  assert.equal(normalizeLocalIdMappingValues('999999999999999', '905550000000', '', 'group@g.us'), null);
  assert.equal(normalizeLocalIdMappingValues('999999999999999', '905550000000', 'test-config', ''), null);
});
