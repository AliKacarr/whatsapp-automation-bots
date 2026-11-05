const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
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

function matchesUser(user, filter) {
  if (filter.phone !== undefined) return user.phone === filter.phone;
  if (filter.voterLid?.$in) return filter.voterLid.$in.includes(user.voterLid);
  if (filter.name?.$regex) {
    return new RegExp(filter.name.$regex, filter.name.$options).test(user.name || '');
  }
  if (filter.username?.$regex) {
    return new RegExp(filter.username.$regex, filter.username.$options).test(user.username || '');
  }
  if (filter._id !== undefined) return String(user._id) === String(filter._id);
  return false;
}

function createUsersCollection(users) {
  return {
    async findOne(filter) {
      return users.find(user => matchesUser(user, filter)) || null;
    },
    find(filter) {
      return makeCursor(users.filter(user => matchesUser(user, filter)));
    },
    async updateOne(filter, update) {
      const user = users.find(item => matchesUser(item, filter));
      if (!user) return { matchedCount: 0 };
      Object.assign(user, update.$set || {});
      return { matchedCount: 1 };
    },
    async insertOne(user) {
      users.push(user);
      return { insertedId: user._id };
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
    users_group1: createUsersCollection(users),
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

function createPollFixture({ vote, users }) {
  let readingStatusWrites = 0;
  const collections = {
    poll_votes: {
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
    polls: {
      async findOne() {
        return {
          pollId: vote.pollId,
          readingGroupId: 'group1',
          groupId: vote.groupId,
          configKey: vote.configKey,
          createdAt: new Date('2026-10-18T09:00:00Z')
        };
      }
    },
    users_group1: createUsersCollection(users),
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

const enabledProvisioningConfig = async () => ({
  features: {
    voteTrackingEnabled: true,
    messageReadingEnabled: true,
    pollAutoUserProvisioningEnabled: true,
    messageAutoUserProvisioningEnabled: true
  }
});

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

test('text vote without phone matches a unique users_ voterLid', async () => {
  const vote = baseVote({
    voterJid: '280762146414598',
    voterPhone: undefined,
    voterLid: '280762146414598',
    pushName: undefined
  });
  const fixture = createFixture({
    vote,
    users: [{ _id: 'user1', name: 'Ali', phone: '', voterLid: '280762146414598' }]
  });
  const sync = createReadingSync({ db: fixture.db });

  const result = await sync.processVote('text_votes', { _id: vote._id });

  assert.deepEqual(result, { status: 'synced' });
  assert.equal(vote.syncStatus, 'synced');
  assert.equal(fixture.getReadingStatusWrites(), 1);
});

test('duplicate users_ voterLid values are rejected as ambiguous', async () => {
  const vote = baseVote({
    voterJid: '280762146414598',
    voterPhone: undefined,
    voterLid: '280762146414598',
    pushName: undefined
  });
  const fixture = createFixture({
    vote,
    users: [
      { _id: 'user1', name: 'Ali 1', phone: '', voterLid: '280762146414598' },
      { _id: 'user2', name: 'Ali 2', phone: '', voterLid: '280762146414598@lid' }
    ]
  });
  const sync = createReadingSync({ db: fixture.db });

  const result = await sync.processVote('text_votes', { _id: vote._id });

  assert.deepEqual(result, { status: 'ignored', reason: 'ambiguous_voter_lid' });
  assert.equal(fixture.getReadingStatusWrites(), 0);
});

test('poll vote without phone matches users_ voterLid', async () => {
  const vote = {
    ...baseVote({
      voterJid: '280762146414598',
      voterPhone: undefined,
      voterLid: '280762146414598',
      pushName: undefined
    }),
    pollId: 'poll1'
  };
  const fixture = createPollFixture({
    vote,
    users: [{ _id: 'user1', name: 'Ali', phone: '', voterLid: '280762146414598' }]
  });
  const sync = createReadingSync({ db: fixture.db });

  const result = await sync.processVote('poll_votes', { _id: vote._id });

  assert.deepEqual(result, { status: 'synced' });
  assert.equal(vote.syncStatus, 'synced');
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

test('disabled automation preserves the legacy unique pushName match without changing visibility', async () => {
  const vote = baseVote({ voterJid: '905559999999', voterPhone: '905559999999' });
  const user = {
    _id: 'user1',
    name: 'Ayşe',
    phone: '905551111111',
    visibility: 'pasif'
  };
  const fixture = createFixture({ vote, users: [user] });
  const sync = createReadingSync({ db: fixture.db });

  const result = await sync.processVote('text_votes', { _id: vote._id });

  assert.deepEqual(result, { status: 'synced' });
  assert.equal(user.visibility, 'pasif');
  assert.equal(fixture.getReadingStatusWrites(), 1);
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

test('automatic provisioning creates a complete user from phone and LID and clears unresolved state', async () => {
  const users = [];
  const cleared = [];
  const vote = baseVote({
    voterLid: '280762146414598',
    pushName: 'Yeni Okuyucu'
  });
  const fixture = createFixture({ vote, users });
  const sync = createReadingSync({
    db: fixture.db,
    getGroupConfig: enabledProvisioningConfig,
    clearUnresolvedVoterLid: async data => cleared.push(data)
  });

  const result = await sync.processVote('text_votes', { _id: vote._id });

  assert.deepEqual(result, { status: 'synced' });
  assert.equal(users.length, 1);
  const [user] = users;
  assert.equal(user.name, 'Yeni Okuyucu');
  assert.equal(user.username, 'Yeni Okuyucu');
  assert.equal(user.profileImage, '/images/default.png');
  assert.equal(user.authority, 'member');
  assert.equal(user.visibility, 'aktif');
  assert.equal(user.loginStreak.valueOf(), 0);
  assert.equal(user.lastLoginDate, null);
  assert.equal(user.lastCongratulatedLeague, 'Bronz');
  assert.equal(user.phone, '905551112233');
  assert.equal(user.voterLid, '280762146414598');
  assert.equal(await bcrypt.compare('905551112233', user.userpassword), true);
  assert.equal(fixture.getReadingStatusWrites(), 1);
  assert.deepEqual(cleared, [{
    configKey: 'test',
    readingGroupId: 'group1',
    groupId: '120363000000000000@g.us',
    voterLid: '280762146414598'
  }]);
});

test('automatic provisioning creates a LID-only user with a hashed LID password', async () => {
  const users = [];
  const vote = baseVote({
    voterJid: '280762146414598',
    voterPhone: undefined,
    voterLid: '280762146414598',
    pushName: undefined
  });
  const fixture = createFixture({ vote, users });
  const sync = createReadingSync({ db: fixture.db, getGroupConfig: enabledProvisioningConfig });

  const result = await sync.processVote('text_votes', { _id: vote._id });

  assert.deepEqual(result, { status: 'synced' });
  assert.equal(users.length, 1);
  assert.equal(users[0].name, '280762146414598');
  assert.equal(users[0].username, '280762146414598');
  assert.equal(users[0].phone, null);
  assert.equal(users[0].voterLid, '280762146414598');
  assert.equal(await bcrypt.compare('280762146414598', users[0].userpassword), true);
});

test('a positive reading activates passive or invalid visibility values without replacing profile data', async () => {
  for (const visibility of ['pasif', undefined, 'beklemede']) {
    const user = {
      _id: `user-${visibility || 'missing'}`,
      name: 'Mevcut Üye',
      username: 'mevcut',
      phone: '905551112233',
      userpassword: 'existing-hash',
      visibility
    };
    const vote = baseVote({ _id: `vote-${visibility || 'missing'}` });
    const fixture = createFixture({ vote, users: [user] });
    const sync = createReadingSync({ db: fixture.db, getGroupConfig: enabledProvisioningConfig });

    const result = await sync.processVote('text_votes', { _id: vote._id });

    assert.deepEqual(result, { status: 'synced' });
    assert.equal(user.visibility, 'aktif');
    assert.equal(user.username, 'mevcut');
    assert.equal(user.userpassword, 'existing-hash');
  }
});

test('poll and message provisioning settings activate users independently', async () => {
  const messageUser = {
    _id: 'message-user',
    name: 'Mesaj Üyesi',
    phone: '905551112233',
    visibility: 'pasif'
  };
  const messageVote = baseVote({ _id: 'message-source-vote' });
  const messageFixture = createFixture({ vote: messageVote, users: [messageUser] });
  const messageSync = createReadingSync({
    db: messageFixture.db,
    getGroupConfig: async () => ({
      features: {
        voteTrackingEnabled: false,
        messageReadingEnabled: true,
        pollAutoUserProvisioningEnabled: false,
        messageAutoUserProvisioningEnabled: true
      }
    })
  });
  await messageSync.processVote('text_votes', { _id: messageVote._id });
  assert.equal(messageUser.visibility, 'aktif');

  const pollUser = {
    _id: 'poll-user',
    name: 'Anket Üyesi',
    phone: '905551112233',
    visibility: 'pasif'
  };
  const pollVote = { ...baseVote({ _id: 'poll-source-vote' }), pollId: 'poll-source' };
  const pollFixture = createPollFixture({ vote: pollVote, users: [pollUser] });
  const pollSync = createReadingSync({
    db: pollFixture.db,
    getGroupConfig: async () => ({
      features: {
        voteTrackingEnabled: true,
        messageReadingEnabled: true,
        pollAutoUserProvisioningEnabled: false,
        messageAutoUserProvisioningEnabled: true
      }
    })
  });
  await pollSync.processVote('poll_votes', { _id: pollVote._id });
  assert.equal(pollUser.visibility, 'pasif');

  const enabledPollUser = {
    _id: 'enabled-poll-user',
    name: 'Aktifleşecek Anket Üyesi',
    phone: '905551112233',
    visibility: 'pasif'
  };
  const enabledPollVote = { ...baseVote({ _id: 'enabled-poll-vote' }), pollId: 'enabled-poll' };
  const enabledPollFixture = createPollFixture({ vote: enabledPollVote, users: [enabledPollUser] });
  const pollOnlyConfig = async () => ({
    features: {
      voteTrackingEnabled: true,
      messageReadingEnabled: true,
      pollAutoUserProvisioningEnabled: true,
      messageAutoUserProvisioningEnabled: false
    }
  });
  const enabledPollSync = createReadingSync({ db: enabledPollFixture.db, getGroupConfig: pollOnlyConfig });
  await enabledPollSync.processVote('poll_votes', { _id: enabledPollVote._id });
  assert.equal(enabledPollUser.visibility, 'aktif');

  const disabledMessageUser = {
    _id: 'disabled-message-user',
    name: 'Pasif Kalacak Mesaj Üyesi',
    phone: '905551112233',
    visibility: 'pasif'
  };
  const disabledMessageVote = baseVote({ _id: 'disabled-message-vote' });
  const disabledMessageFixture = createFixture({ vote: disabledMessageVote, users: [disabledMessageUser] });
  const disabledMessageSync = createReadingSync({ db: disabledMessageFixture.db, getGroupConfig: pollOnlyConfig });
  await disabledMessageSync.processVote('text_votes', { _id: disabledMessageVote._id });
  assert.equal(disabledMessageUser.visibility, 'pasif');
});

test('poll provisioning stays disabled when vote tracking parent is disabled', async () => {
  const user = {
    _id: 'parent-disabled-user',
    name: 'Pasif Üye',
    phone: '905551112233',
    visibility: 'pasif'
  };
  const vote = { ...baseVote({ _id: 'parent-disabled-vote' }), pollId: 'parent-disabled-poll' };
  const fixture = createPollFixture({ vote, users: [user] });
  const sync = createReadingSync({
    db: fixture.db,
    getGroupConfig: async () => ({
      features: {
        voteTrackingEnabled: false,
        pollAutoUserProvisioningEnabled: true
      }
    })
  });

  await sync.processVote('poll_votes', { _id: vote._id });

  assert.equal(user.visibility, 'pasif');
});

test('automatic mode does not create or activate users for cancellation', async () => {
  const users = [];
  const vote = baseVote({ selectedOptions: [] });
  const fixture = createFixture({ vote, users });
  const sync = createReadingSync({ db: fixture.db, getGroupConfig: enabledProvisioningConfig });

  const result = await sync.processVote('text_votes', { _id: vote._id });

  assert.deepEqual(result, { status: 'ignored', reason: 'user_not_found' });
  assert.equal(users.length, 0);
  assert.equal(fixture.getReadingStatusWrites(), 0);
});

test('automatic mode leaves a passive existing user passive for cancellation or invalid amount', async () => {
  for (const selectedOptions of [[], [String(DEFAULT_MAX_READING_AMOUNT + 1)]]) {
    const user = {
      _id: `passive-${selectedOptions.length}`,
      name: 'Pasif Üye',
      phone: '905551112233',
      visibility: 'pasif'
    };
    const vote = baseVote({
      _id: `non-positive-${selectedOptions.join('-') || 'cancel'}`,
      selectedOptions
    });
    const fixture = createFixture({ vote, users: [user] });
    const sync = createReadingSync({ db: fixture.db, getGroupConfig: enabledProvisioningConfig });

    await sync.processVote('text_votes', { _id: vote._id });

    assert.equal(user.visibility, 'pasif');
  }
});

test('automatic mode does not bind by pushName and suffixes a colliding username', async () => {
  const users = [{
    _id: 'existing',
    name: 'Yeni Okuyucu',
    username: 'yeni okuyucu',
    phone: '905559999999',
    visibility: 'aktif'
  }];
  const vote = baseVote({ pushName: 'Yeni Okuyucu' });
  const fixture = createFixture({ vote, users });
  const sync = createReadingSync({ db: fixture.db, getGroupConfig: enabledProvisioningConfig });

  const result = await sync.processVote('text_votes', { _id: vote._id });

  assert.deepEqual(result, { status: 'synced' });
  assert.equal(users.length, 2);
  assert.equal(users[1].username, 'Yeni Okuyucu-2');
  assert.equal(users[1].phone, '905551112233');
});

test('automatic mode rejects ambiguous phone identities without creating another user', async () => {
  const users = [
    { _id: 'user1', name: 'Bir', phone: '905551112233' },
    { _id: 'user2', name: 'İki', phone: '905551112233' }
  ];
  const vote = baseVote();
  const fixture = createFixture({ vote, users });
  const sync = createReadingSync({ db: fixture.db, getGroupConfig: enabledProvisioningConfig });

  const result = await sync.processVote('text_votes', { _id: vote._id });

  assert.deepEqual(result, { status: 'ignored', reason: 'ambiguous_phone' });
  assert.equal(users.length, 2);
  assert.equal(fixture.getReadingStatusWrites(), 0);
});

test('poll provisioning is idempotent when the same positive vote is processed again', async () => {
  const users = [];
  const vote = {
    ...baseVote({
      voterJid: '280762146414598',
      voterPhone: undefined,
      voterLid: '280762146414598',
      pushName: 'Yeni Üye'
    }),
    pollId: 'poll-auto'
  };
  const fixture = createPollFixture({ vote, users });
  const sync = createReadingSync({ db: fixture.db, getGroupConfig: enabledProvisioningConfig });

  assert.deepEqual(await sync.processVote('poll_votes', { _id: vote._id }), { status: 'synced' });
  assert.deepEqual(await sync.processVote('poll_votes', { _id: vote._id }), { status: 'synced' });
  assert.equal(users.length, 1);
  assert.equal(fixture.getReadingStatusWrites(), 2);
});
