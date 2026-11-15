'use strict';

const should = require('should');

const vm = require('node:vm');

const { SmsTunnelError, createClient, normalizeServerUrl } = require('../nodes/lib/client');
const { MAX_RECIPIENTS, RecipientError, maskNumber, parseRecipients } = require('../nodes/lib/recipients');
const { SendAtError, isSet, sendAtOf } = require('../nodes/lib/send-at');
const { sent, startFakeApi } = require('./support');

const KEY = 'sk_live_test_0123456789abcdef0123456789abcd';

describe('lib/client', function () {
  let api;

  before(async function () {
    api = await startFakeApi();
  });
  after(async function () {
    await api.close();
  });
  beforeEach(function () {
    api.reset();
  });

  it('sends one text with the key and the optional fields', async function () {
    api.handler = () => sent('m1');
    const client = createClient({ apiKey: ` ${KEY} `, serverUrl: `${api.url}/`, userAgent: 'test-agent/1' });

    const answer = await client.sendSms(' +14155550123 ', 'Hi there', { deviceId: 'd1', defaultCountryCode: '+1' });

    answer.messageId.should.equal('m1');
    const request = api.requests[0];
    request.method.should.equal('POST');
    request.path.should.equal('/api/v1/sms/send');
    request.headers['x-api-key'].should.equal(KEY);
    request.headers['content-type'].should.equal('application/json');
    request.headers['user-agent'].should.equal('test-agent/1');
    request.body.should.eql({ to: '+14155550123', message: 'Hi there', deviceId: 'd1', defaultCountryCode: '+1' });
  });

  it('leaves out empty optional fields and sends codes to send-2fa', async function () {
    api.handler = () => sent('m2');
    const client = createClient({ apiKey: KEY, serverUrl: api.url });

    await client.sendVerificationCode('+14155550123', 'Code 482913', { deviceId: '', defaultCountryCode: '' });

    api.requests[0].path.should.equal('/api/v1/sms/send-2fa');
    api.requests[0].body.should.eql({ to: '+14155550123', message: 'Code 482913' });
  });

  it('reads statuses, received texts and phones with GET and no body', async function () {
    api.handler = (request) => ({ status: 200, body: { success: true, data: { path: request.path } } });
    const client = createClient({ apiKey: KEY, serverUrl: api.url });

    await client.getMessageStatus('a/b?c');
    await client.getReceivedMessages({ limit: 50, page: 2, phone: '+1 415', deviceId: '', since: undefined });
    await client.getDevices();

    api.requests.map((request) => request.path).should.eql([
      '/api/v1/sms/status/a%2Fb%3Fc',
      '/api/v1/sms/received',
      '/api/v1/devices',
    ]);
    api.requests[1].query.should.eql({ limit: '50', page: '2', phone: '+1 415' });
    api.requests.forEach((request) => {
      request.method.should.equal('GET');
      should(request.headers['content-type']).be.undefined();
    });
  });

  it('turns an error answer into an SmsTunnelError with the status, code and permission', async function () {
    api.handler = () => ({
      status: 403,
      body: { statusCode: 403, message: 'This API key may not read received texts.', code: 'PERMISSION_REQUIRED', permission: 'sms:inbox' },
    });
    const client = createClient({ apiKey: KEY, serverUrl: api.url });

    const error = await client.getReceivedMessages().should.be.rejectedWith(SmsTunnelError);

    error.status.should.equal(403);
    error.code.should.equal('PERMISSION_REQUIRED');
    error.permission.should.equal('sms:inbox');
    error.message.should.equal('This API key may not read received texts.');
  });

  it('reads Retry-After on a 429', async function () {
    api.handler = () => ({ status: 429, body: { statusCode: 429, message: 'ThrottlerException: Too Many Requests' }, headers: { 'Retry-After': '7' } });
    const client = createClient({ apiKey: KEY, serverUrl: api.url });

    const error = await client.sendSms('+14155550123', 'Hi').should.be.rejectedWith(SmsTunnelError);

    error.status.should.equal(429);
    error.retryAfter.should.equal(7);
  });

  it('joins a list of messages and falls back to the label or the status', async function () {
    const client = createClient({ apiKey: KEY, serverUrl: api.url });
    api.handler = () => ({ status: 400, body: { message: ['to is wrong', 'message is empty'] } });
    await client.sendSms('x', 'y').should.be.rejectedWith('to is wrong; message is empty');
    api.handler = () => ({ status: 401, body: { error: 'Unauthorized' } });
    await client.getDevices().should.be.rejectedWith('Unauthorized');
    api.handler = () => ({ status: 503, body: '<html><h1>Service Unavailable</h1></html>' });
    await client.getDevices().should.be.rejectedWith('Service Unavailable');
    api.handler = () => ({ status: 500 });
    await client.getDevices().should.be.rejectedWith('SMSTunnel returned error: 500');
  });

  it('refuses success:false, an answer that is not JSON, and redirects', async function () {
    const client = createClient({ apiKey: KEY, serverUrl: api.url });
    api.handler = () => ({ status: 200, body: { success: false, error: 'Device offline' } });
    await client.sendSms('+14155550123', 'Hi').should.be.rejectedWith('Device offline');
    api.handler = () => ({ status: 200, body: '<html>hello</html>' });
    await client.getDevices().should.be.rejectedWith(/not JSON/);
    api.handler = () => ({ status: 302, headers: { Location: 'https://elsewhere.example/' } });
    const error = await client.getDevices().should.be.rejectedWith(/redirect to https:\/\/elsewhere\.example\//);
    error.status.should.equal(302);
    api.requests.length.should.equal(3, 'the redirect was not followed');
  });

  it('says when SMSTunnel cannot be reached, with status 0', async function () {
    const client = createClient({ apiKey: KEY, serverUrl: 'http://127.0.0.1:9' });

    const error = await client.getDevices().should.be.rejectedWith(SmsTunnelError);

    error.status.should.equal(0);
    error.message.should.startWith('Could not reach SMSTunnel at http://127.0.0.1:9');
  });

  it('times out', async function () {
    api.handler = () => new Promise((resolve) => setTimeout(() => resolve(sent('late')), 1500));
    const client = createClient({ apiKey: KEY, serverUrl: api.url, timeoutMs: 300 });

    await client.getDevices().should.be.rejectedWith(/no answer within 0.3 s/);
  });

  it('sends sendAt as toISOString(), from a Date or a time with its offset, and never with a code', async function () {
    api.handler = (request) => ({
      status: 200,
      body: { success: true, scheduled: true, scheduledId: 's1', sendAt: request.body.sendAt, data: { id: 's1' } },
    });
    const client = createClient({ apiKey: KEY, serverUrl: api.url });

    const answer = await client.sendSms('+14155550123', 'Later', { deviceId: 'd1', sendAt: '2026-11-16T09:00:00+02:00' });
    await client.sendSms('+14155550123', 'Later', { sendAt: new Date('2026-11-16T07:00:00Z') });
    await client.sendSms('+14155550123', 'Now', { sendAt: '' });
    await client.sendVerificationCode('+14155550123', 'Code 482913', { sendAt: '2026-11-16T09:00:00Z' });

    answer.should.containEql({ scheduled: true, scheduledId: 's1', sendAt: '2026-11-16T07:00:00.000Z' });
    api.requests[0].body.should.eql({ to: '+14155550123', message: 'Later', deviceId: 'd1', sendAt: '2026-11-16T07:00:00.000Z' });
    api.requests[1].body.sendAt.should.equal('2026-11-16T07:00:00.000Z');
    api.requests[2].body.should.eql({ to: '+14155550123', message: 'Now' });
    api.requests[3].body.should.eql({ to: '+14155550123', message: 'Code 482913' });
  });

  it('refuses a sendAt without its offset, or that is not a real time, before calling SMSTunnel', async function () {
    const client = createClient({ apiKey: KEY, serverUrl: api.url });

    for (const sendAt of ['2026-11-16T09:00:00', '2026-02-30T09:00:00Z', 'tomorrow', new Date('nope'), 1794812400000]) {
      await client.sendSms('+14155550123', 'x', { sendAt }).should.be.rejectedWith(SendAtError);
    }
    await client.sendSms('+14155550123', 'x', { sendAt: '2026-11-16T09:00:00' }).should.be.rejectedWith(/has no offset/);
    api.requests.length.should.equal(0);
  });

  it('lists, gets and cancels scheduled texts', async function () {
    api.handler = (request) => ({ status: 200, body: { success: true, data: { method: request.method } } });
    const client = createClient({ apiKey: KEY, serverUrl: api.url });

    await client.listScheduled();
    await client.listScheduled({ scope: 'done', page: 2, limit: 20 });
    await client.getScheduled('a/b');
    const canceled = await client.cancelScheduled(' s1 ');

    api.requests.map((request) => `${request.method} ${request.path}`).should.eql([
      'GET /api/v1/sms/scheduled',
      'GET /api/v1/sms/scheduled',
      'GET /api/v1/sms/scheduled/a%2Fb',
      'DELETE /api/v1/sms/scheduled/s1',
    ]);
    api.requests[0].query.should.eql({});
    api.requests[1].query.should.eql({ scope: 'done', page: '2', limit: '20' });
    canceled.data.method.should.equal('DELETE');
    api.requests.forEach((request) => should(request.headers['content-type']).be.undefined());

    await client.cancelScheduled('  ').should.be.rejectedWith(/scheduled text ID is required/);
    await client.getScheduled(undefined).should.be.rejectedWith(/scheduled text ID is required/);
    api.requests.length.should.equal(4);
  });

  it('keeps the code of a refused scheduled text', async function () {
    const client = createClient({ apiKey: KEY, serverUrl: api.url });
    api.handler = () => ({
      status: 409,
      body: { statusCode: 409, error: 'Conflict', code: 'SCHEDULE_NOT_EDITABLE', message: 'This text has already gone out or was canceled.' },
    });
    const late = await client.cancelScheduled('s1').should.be.rejectedWith(SmsTunnelError);
    late.status.should.equal(409);
    late.code.should.equal('SCHEDULE_NOT_EDITABLE');

    api.handler = () => ({
      status: 403,
      body: { statusCode: 403, error: 'Forbidden', code: 'SCHEDULE_LIMIT_REACHED', message: 'You have as many scheduled texts as your plan allows.', max: 10 },
    });
    const full = await client.sendSms('+14155550123', 'x', { sendAt: '2026-11-16T09:00:00Z' }).should.be.rejectedWith(SmsTunnelError);
    full.code.should.equal('SCHEDULE_LIMIT_REACHED');
    full.body.max.should.equal(10);

    // The server before scheduled texts refuses the field: an error like any 400.
    api.handler = () => ({ status: 400, body: { statusCode: 400, error: 'Bad Request', message: ['property sendAt should not exist'] } });
    const old = await client.sendSms('+14155550123', 'x', { sendAt: '2026-11-16T09:00:00Z' }).should.be.rejectedWith(SmsTunnelError);
    old.status.should.equal(400);
    old.message.should.equal('property sendAt should not exist');
  });

  it('needs a key and a server URL that is http(s)', function () {
    (() => createClient({ apiKey: '  ' })).should.throw(/API key is required/);
    (() => createClient({ apiKey: KEY, serverUrl: 'ftp://smstunnel.io' })).should.throw(/must look like/);
    normalizeServerUrl('').should.equal('https://smstunnel.io');
    normalizeServerUrl(' http://127.0.0.1:3101/ ').should.equal('http://127.0.0.1:3101');
  });
});

describe('lib/send-at', function () {
  it('gives the time in UTC, as toISOString()', function () {
    sendAtOf('2026-11-16T09:00:00+02:00').should.equal('2026-11-16T07:00:00.000Z');
    sendAtOf(' 2026-11-16 09:00:00.123456-0500 ').should.equal('2026-11-16T14:00:00.123Z');
    sendAtOf('2026-11-16T09:00Z').should.equal('2026-11-16T09:00:00.000Z');
    sendAtOf('2026-11-16T09:00:00+05').should.equal('2026-11-16T04:00:00.000Z');
    sendAtOf(new Date('2026-11-16T07:00:00Z')).should.equal('2026-11-16T07:00:00.000Z');
  });

  it('takes a Date made in another context, as a function node makes it', function () {
    const foreign = vm.runInNewContext('new Date("2026-11-16T07:00:00Z")');
    (foreign instanceof Date).should.be.false();
    sendAtOf(foreign).should.equal('2026-11-16T07:00:00.000Z');
  });

  it('refuses a time without its offset, a date that does not exist, and numbers', function () {
    (() => sendAtOf('2026-11-16T09:00:00')).should.throw(SendAtError, /has no offset: add Z for UTC/);
    (() => sendAtOf('2026-02-30T09:00:00Z')).should.throw(SendAtError, /not a real date and time/);
    (() => sendAtOf(1794812400000)).should.throw(SendAtError, /new Date\(ms\)/);
    (() => sendAtOf(new Date('x'))).should.throw(SendAtError, /invalid Date/);
    for (const bad of ['2026-11-16', ' ', 'soon', '2026-11-16T24:00:00Z', '2026-11-16T09:00:00+24:00', {}, null, undefined]) {
      (() => sendAtOf(bad)).should.throw(SendAtError);
    }
  });

  it('tells a set msg property from an unset one', function () {
    [undefined, null, ''].forEach((value) => isSet(value).should.be.false());
    [' ', 0, false, 's1'].forEach((value) => isSet(value).should.be.true());
  });
});

describe('lib/recipients', function () {
  it('splits on commas, semicolons and new lines, and drops repeats', function () {
    parseRecipients('+14155550123, +14155550124;+14155550125\n+14155550123\r\n').should.eql([
      '+14155550123',
      '+14155550124',
      '+14155550125',
    ]);
  });

  it('keeps the spaces inside a number', function () {
    parseRecipients('+40 712 345 678').should.eql(['+40 712 345 678']);
  });

  it('takes an array, and nothing at all', function () {
    parseRecipients(['+14155550123', ' +14155550124 ', '']).should.eql(['+14155550123', '+14155550124']);
    parseRecipients(undefined).should.eql([]);
    parseRecipients('  ').should.eql([]);
  });

  it('refuses JavaScript numbers and objects', function () {
    (() => parseRecipients(14155550123)).should.throw(RecipientError, /must be text/);
    (() => parseRecipients(['+14155550123', 40712345678])).should.throw(RecipientError);
    (() => parseRecipients({ phone: '+1' })).should.throw(RecipientError);
  });

  it('masks a number for a status badge', function () {
    maskNumber('+14155550123').should.equal('…0123');
    maskNumber('123').should.equal('123');
    MAX_RECIPIENTS.should.equal(30);
  });
});
