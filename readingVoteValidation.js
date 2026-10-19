const DEFAULT_MAX_READING_AMOUNT = 99999;

function getMaxReadingAmount(rawValue = process.env.MAX_READING_AMOUNT) {
  const parsed = Number(rawValue);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return DEFAULT_MAX_READING_AMOUNT;
  }
  return parsed;
}

function validateReadingAmount(value, maxAmount = getMaxReadingAmount()) {
  const raw = value == null ? '' : String(value).trim();
  if (!/^\d+$/.test(raw)) {
    return { valid: false, reason: 'invalid_amount_format' };
  }

  const amount = Number(raw);
  if (!Number.isSafeInteger(amount) || amount < 0) {
    return { valid: false, reason: 'invalid_amount' };
  }
  if (amount > maxAmount) {
    return {
      valid: false,
      reason: 'amount_exceeds_limit',
      maxAmount
    };
  }

  return {
    valid: true,
    amount,
    normalized: String(amount)
  };
}

function validateTextVoteSelectedOptions(selectedOptions, options = {}) {
  const maxAmount = options.maxAmount || getMaxReadingAmount();
  if (!Array.isArray(selectedOptions)) {
    return { valid: false, reason: 'selected_options_not_array' };
  }
  if (selectedOptions.length === 0) {
    return { valid: true, clear: true, selectedOptions: [] };
  }
  if (selectedOptions.length !== 1) {
    return { valid: false, reason: 'multiple_amounts_not_allowed' };
  }

  const amountResult = validateReadingAmount(selectedOptions[0], maxAmount);
  if (!amountResult.valid) return amountResult;
  if (amountResult.amount === 0) {
    return { valid: true, clear: true, selectedOptions: [] };
  }

  return {
    valid: true,
    clear: false,
    amount: amountResult.amount,
    selectedOptions: [amountResult.normalized]
  };
}

function isValidIsoDate(value) {
  const raw = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const parsed = new Date(`${raw}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === raw;
}

module.exports = {
  DEFAULT_MAX_READING_AMOUNT,
  getMaxReadingAmount,
  validateReadingAmount,
  validateTextVoteSelectedOptions,
  isValidIsoDate
};
