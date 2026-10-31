const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeVoterLid, voterLidVariants } = require('../whatsappIdentity');

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
