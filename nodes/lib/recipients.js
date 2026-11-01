'use strict';

/** Sending allows 30 requests a minute, so one message may name at most 30 numbers. */
const MAX_RECIPIENTS = 30;

class RecipientError extends Error {}

/**
 * The numbers to text, from a string ("+14155550123, +14155550124", one per line also works) or an array of
 * strings. Each number appears once, in the order given.
 *
 * A JavaScript number is refused: it has lost its "+" and any leading 0, and SMSTunnel would then put a
 * country code in front of it.
 */
function parseRecipients(value) {
  const items = Array.isArray(value) ? value : [value];
  const numbers = [];
  for (const item of items) {
    if (item === undefined || item === null) continue;
    if (typeof item === 'number' || typeof item === 'bigint') {
      throw new RecipientError(
        `The number ${String(item)} must be text, such as "+14155550123": as a number it has lost its "+" and any leading 0.`,
      );
    }
    if (typeof item !== 'string') {
      throw new RecipientError('The recipient must be a phone number as text, or a list of them.');
    }
    for (const part of item.split(/[,;\r\n]+/)) {
      const number = part.trim();
      if (number && !numbers.includes(number)) numbers.push(number);
    }
  }
  return numbers;
}

/** "…0123": enough to tell numbers apart in a status badge. */
function maskNumber(number) {
  const digits = String(number).replace(/\D/g, '');
  return digits.length > 4 ? `…${digits.slice(-4)}` : String(number);
}

module.exports = { MAX_RECIPIENTS, RecipientError, maskNumber, parseRecipients };
