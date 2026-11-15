'use strict';

/** A send-at time that can't be one; the node passes its words on, as with RecipientError. */
class SendAtError extends Error {}

// YYYY-MM-DD, T (or a space), hh:mm, optional :ss and a fraction, then the offset: Z, ±hh:mm, ±hhmm or ±hh.
const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?(?:([Zz])|([+-])(\d{2})(?::?(\d{2}))?)?$/;
const EXAMPLE = '"2026-11-16T09:00:00+02:00"';

/**
 * The time to send a scheduled text at, as SMSTunnel takes it: always toISOString() (UTC). From a Date (also one made
 * in a function node, in its own context) or an ISO 8601 date and time with its offset, such as
 * "2026-11-16T09:00:00+02:00" or "2026-11-16T07:00:00Z".
 *
 * Refused with a SendAtError: a string without its offset (it would be read in whatever time zone Node-RED runs in),
 * a date that doesn't exist such as 30 February (new Date() would quietly make it 2 March), and anything else,
 * numbers included (seconds or milliseconds?). Whether it is 1 minute to 30 days ahead is left to SMSTunnel, whose
 * clock decides.
 */
function sendAtOf(value) {
  if (value instanceof Date || Object.prototype.toString.call(value) === '[object Date]') {
    const time = Date.prototype.getTime.call(value);
    if (Number.isNaN(time)) throw new SendAtError('msg.sendAt is an invalid Date.');
    return new Date(time).toISOString();
  }
  if (typeof value !== 'string') {
    throw new SendAtError(
      `msg.sendAt must be a Date or an ISO 8601 date and time with its offset, such as ${EXAMPLE}` +
        (typeof value === 'number' ? ': for milliseconds, set it to new Date(ms) in a function node.' : '.'),
    );
  }
  const parts = ISO_DATE_TIME.exec(value.trim());
  const shown = JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);
  if (!parts) {
    throw new SendAtError(`msg.sendAt ${shown} is not an ISO 8601 date and time, such as ${EXAMPLE}.`);
  }
  const [, year, month, day, hour, minute, second = '00', fraction = '', zulu, sign, offsetHours = '00', offsetMinutes = '00'] =
    parts;
  if (!zulu && !sign) {
    throw new SendAtError(`msg.sendAt ${shown} has no offset: add Z for UTC, or the offset of its time zone, such as ${EXAMPLE}.`);
  }
  const wall = `${year}-${month}-${day}T${hour}:${minute}:${second}.${(fraction + '000').slice(0, 3)}Z`;
  const at = Date.parse(wall);
  if (Number.isNaN(at) || new Date(at).toISOString() !== wall || Number(offsetHours) > 23 || Number(offsetMinutes) > 59) {
    throw new SendAtError(`msg.sendAt ${shown} is not a real date and time, such as ${EXAMPLE}.`);
  }
  const offset = sign ? (sign === '-' ? -1 : 1) * (Number(offsetHours) * 60 + Number(offsetMinutes)) : 0;
  return new Date(at - offset * 60000).toISOString();
}

/** msg.sendAt, msg.cancel: set unless undefined, null or an empty string. */
function isSet(value) {
  return value !== undefined && value !== null && value !== '';
}

module.exports = { SendAtError, isSet, sendAtOf };
