'use strict';

const should = require('should');

const { SmsTunnelError, createClient, normalizeServerUrl } = require('../nodes/lib/client');
const { MAX_RECIPIENTS, RecipientError, maskNumber, parseRecipients } = require('../nodes/lib/recipients');
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

  it('needs a key and a server URL that is http(s)', function () {
    (() => createClient({ apiKey: '  ' })).should.throw(/API key is required/);
    (() => createClient({ apiKey: KEY, serverUrl: 'ftp://smstunnel.io' })).should.throw(/must look like/);
    normalizeServerUrl('').should.equal('https://smstunnel.io');
    normalizeServerUrl(' http://127.0.0.1:3101/ ').should.equal('http://127.0.0.1:3101');
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
