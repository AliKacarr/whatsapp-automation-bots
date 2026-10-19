const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_MAX_READING_AMOUNT,
  validateReadingAmount,
  validateTextVoteSelectedOptions,
  isValidIsoDate
} = require('../readingVoteValidation');

test('zero variants are normalized as cancellation', () => {
  for (const value of ['0', '00', '000']) {
    assert.deepEqual(validateTextVoteSelectedOptions([value]), {
      valid: true,
      clear: true,
      selectedOptions: []
    });
  }
});

test('positive amount is normalized and retained', () => {
  assert.deepEqual(validateTextVoteSelectedOptions(['0020']), {
    valid: true,
    clear: false,
    amount: 20,
    selectedOptions: ['20']
  });
});

test('amount above configured maximum is rejected', () => {
  assert.deepEqual(validateReadingAmount('101', 100), {
    valid: false,
    reason: 'amount_exceeds_limit',
    maxAmount: 100
  });
});

test('amount above the default maximum is rejected', () => {
  assert.deepEqual(
    validateReadingAmount(String(DEFAULT_MAX_READING_AMOUNT + 1), DEFAULT_MAX_READING_AMOUNT),
    {
      valid: false,
      reason: 'amount_exceeds_limit',
      maxAmount: DEFAULT_MAX_READING_AMOUNT
    }
  );
});

test('multiple values and non-numeric values are rejected', () => {
  assert.equal(validateTextVoteSelectedOptions(['10', '20']).reason, 'multiple_amounts_not_allowed');
  assert.equal(validateTextVoteSelectedOptions(['on sayfa']).reason, 'invalid_amount_format');
});

test('ISO date validation rejects impossible calendar dates', () => {
  assert.equal(isValidIsoDate('2026-02-28'), true);
  assert.equal(isValidIsoDate('2026-02-31'), false);
  assert.equal(isValidIsoDate('2026-13-01'), false);
});
