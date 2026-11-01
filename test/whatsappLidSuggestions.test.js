const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractParticipantIdentity,
  buildLidSuggestions
} = require('../whatsappLidSuggestions');

test('extractParticipantIdentity supports Baileys 6.x participant fields', () => {
  assert.deepEqual(
    extractParticipantIdentity({
      id: '39007513772153@lid',
      jid: '905511403704@s.whatsapp.net',
      lid: '39007513772153@lid',
      admin: 'admin'
    }),
    {
      lid: '39007513772153',
      phone: '905511403704',
      username: '',
      name: '',
      admin: 'admin'
    }
  );
});

test('suggestions exclude registered phones and assigned lids but keep other group lids', () => {
  const participants = [
    { id: '111111111111111@lid', jid: '905111111111@s.whatsapp.net', lid: '111111111111111@lid' },
    { id: '222222222222222@lid', lid: '222222222222222@lid' },
    {
      id: '333333333333333@lid',
      jid: '905333333333@s.whatsapp.net',
      lid: '333333333333333@lid'
    }
  ];

  const suggestions = buildLidSuggestions(participants, {
    registeredPhones: ['905111111111'],
    assignedLids: ['222222222222222']
  });

  assert.deepEqual(suggestions, [{
    voterLid: '333333333333333',
    phone: '905333333333',
    username: '',
    name: '',
    admin: null
  }]);
});

test('suggestions use config-scoped stored phone mappings and contact details', () => {
  const details = new Map([
    ['444444444444444', { name: 'Ayşe', username: 'ayse' }]
  ]);
  const phoneByLid = new Map([
    ['444444444444444', '905444444444']
  ]);

  const suggestions = buildLidSuggestions(
    [{ id: '444444444444444@lid', lid: '444444444444444@lid' }],
    { detailsByIdentity: details, phoneByLid }
  );

  assert.deepEqual(suggestions, [{
    voterLid: '444444444444444',
    phone: '905444444444',
    username: 'ayse',
    name: 'Ayşe',
    admin: null
  }]);
});

test('an unresolved event record does not suppress an information-rich live group suggestion', () => {
  const suggestions = buildLidSuggestions(
    [{
      id: '555555555555555@lid',
      jid: '905555555555@s.whatsapp.net',
      lid: '555555555555555@lid'
    }],
    {
      registeredPhones: [],
      assignedLids: [],
      // unresolved voter LIDs are intentionally not an input/filter for suggestions.
      unresolvedLids: ['555555555555555']
    }
  );

  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].voterLid, '555555555555555');
});

test('a bare LID without phone, name, or username is not suggested', () => {
  const suggestions = buildLidSuggestions([
    { id: '666666666666666@lid', lid: '666666666666666@lid' }
  ]);

  assert.deepEqual(suggestions, []);
});
