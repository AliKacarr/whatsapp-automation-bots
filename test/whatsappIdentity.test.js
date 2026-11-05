const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeVoterLid,
  voterLidVariants,
  extractParticipantIdentity
} = require('../whatsappIdentity');

test('normalizeVoterLid accepts bare and device-qualified LID values', () => {
  assert.equal(normalizeVoterLid('280762146414598'), '280762146414598');
  assert.equal(normalizeVoterLid('280762146414598:3@lid'), '280762146414598');
  assert.equal(normalizeVoterLid('280762146414598@hosted.lid'), '280762146414598');
});

test('normalizeVoterLid rejects phone and group JID domains', () => {
  assert.equal(normalizeVoterLid('905352776948@s.whatsapp.net'), '');
  assert.equal(normalizeVoterLid('120363000000000000@g.us'), '');
  assert.equal(normalizeVoterLid('not-a-lid'), '');
});

test('voterLidVariants supports manual bare and full users_ values', () => {
  assert.deepEqual(voterLidVariants('280762146414598@lid'), [
    '280762146414598',
    '280762146414598@lid',
    '280762146414598:0@lid',
    '280762146414598@hosted.lid',
    '280762146414598:0@hosted.lid'
  ]);
});

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
