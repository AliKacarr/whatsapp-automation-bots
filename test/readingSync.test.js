const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadingSync } = require('../readingSync');
const { DEFAULT_MAX_READING_AMOUNT } = require('../readingVoteValidation');

function makeCursor(rows) {
  let selected = [...rows];
  return {
    limit(count) {
      selected = selected.slice(0, count);
      return this;
    },
    async toArray() {
      return selected;
    }
  };
}

function createFixture({ vote, users }) {
  let readingStatusWrites = 0;
  const collections = {
    text_votes: {
      async findOne(filter) {
        return filter._id === vote._id ? vote : null;
      },
      async updateOne(filter, update) {
        if (filter._id !== vote._id || (filter.syncVersion && filter.syncVersion !== vote.syncVersion)) {
          return { matchedCount: 0 };
        }
        Object.assign(vote, update.$set || {});
        for (const key of Object.keys(update.$unset || {})) delete vote[key];
        return { matchedCount: 1 };
      }
    },
    users_group1: {
      async findOne(filter) {
        return users.find(user => filter.phone && user.phone === filter.phone) || null;
      },
      find(filter) {
        const regex = new RegExp(filter.name.$regex, filter.name.$options);
        return makeCursor(users.filter(user => regex.test(user.name)));
      }
    },
    readingstatuses_group1: {
      async findOneAndUpdate() {
        readingStatusWrites += 1;
        return {};
      },
      async findOneAndDelete() {
        readingStatusWrites += 1;
        return {};
      },
      async countDocuments() {
        return 1;
      }
    },
    usergroups: {
      async findOne() {
        return { groupId: 'group1', groupName: 'Test Grubu' };
      },
      find() {
        return makeCursor([{ groupId: 'group1', groupName: 'Test Grubu' }]);
      }
    },
    pending_league_congratulations: {
      async findOneAndUpdate() {
        return {};
      }
    }
  };

  return {
    db: {
      collection(name) {
        if (!collections[name]) throw new Error(`Beklenmeyen koleksiyon: ${name}`);
        return collections[name];
      }
    },
    getReadingStatusWrites: () => readingStatusWrites
  };
}

function baseVote(overrides = {}) {
  return {
    _id: 'vote1',
    voterJid: '905551112233',
    voterPhone: '905551112233',
    pushName: 'Ayşe',
    selectedOptions: ['20'],
    readingGroupId: 'group1',
    groupId: '120363000000000000@g.us',
    configKey: 'test',
    date: '2026-10-18',
    updatedAt: '2026-10-18 12:00:00',
    syncVersion: 'version1',
    syncStatus: 'pending',
    ...overrides
  };
}

test('successful text vote remains stored as synced', async () => {
  const vote = baseVote();
  const fixture = createFixture({
    vote,
    users: [{ _id: 'user1', name: 'Ayşe', phone: '905551112233' }]
  });
  const sync = createReadingSync({ db: fixture.db });

  const result = await sync.processVote('text_votes', { _id: vote._id });

  assert.deepEqual(result, { status: 'synced' });
  assert.equal(vote.syncStatus, 'synced');
  assert.equal(vote.syncedVersion, 'version1');
  assert.equal(fixture.getReadingStatusWrites(), 1);
});

test('amount above limit is retained with a precise reason', async () => {
  const vote = baseVote({ selectedOptions: [String(DEFAULT_MAX_READING_AMOUNT + 1)] });
  const fixture = createFixture({
    vote,
    users: [{ _id: 'user1', name: 'Ayşe', phone: '905551112233' }]
  });
  const sync = createReadingSync({ db: fixture.db });

  const result = await sync.processVote('text_votes', { _id: vote._id });

  assert.deepEqual(result, { status: 'ignored', reason: 'amount_exceeds_limit' });
  assert.equal(vote.syncReason, 'amount_exceeds_limit');
  assert.equal(fixture.getReadingStatusWrites(), 0);
});

test('duplicate pushName matches are rejected as ambiguous', async () => {
  const vote = baseVote({ voterJid: '905559999999', voterPhone: '905559999999' });
  const fixture = createFixture({
    vote,
    users: [
      { _id: 'user1', name: 'Ayşe', phone: '905551111111' },
      { _id: 'user2', name: 'Ayşe', phone: '905552222222' }
    ]
  });
  const sync = createReadingSync({ db: fixture.db });

  const result = await sync.processVote('text_votes', { _id: vote._id });

  assert.deepEqual(result, { status: 'ignored', reason: 'ambiguous_push_name' });
  assert.equal(vote.syncReason, 'ambiguous_push_name');
  assert.equal(fixture.getReadingStatusWrites(), 0);
});

test('retry scan accepts a multi-group Mongo scope without collapsing it', async () => {
  const seenFilters = [];
  const db = {
    collection(name) {
      assert.ok(['poll_votes', 'text_votes'].includes(name));
      return {
        find(filter) {
          seenFilters.push({ name, filter });
          return makeCursor([]);
        }
      };
    }
  };
  const scope = {
    configKey: 'test',
    $or: [
      { readingGroupId: 'group1', groupId: '11111@g.us' },
      { readingGroupId: 'group2', groupId: '22222@g.us' }
    ]
  };
  const sync = createReadingSync({ db, getScope: async () => scope });

  await sync.retryPending();

  assert.equal(seenFilters.length, 2);
  for (const { filter } of seenFilters) {
    assert.deepEqual(filter.$and[0], scope);
    assert.equal(Array.isArray(filter.$and[1].$or), true);
  }
});
