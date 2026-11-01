'use strict';

/**
 * The nodes against a real SMSTunnel test server, never production. Skipped unless SMSTUNNEL_E2E_KEY_FILE points
 * to a JSON file { serverUrl, apiKey, deviceId } with a test key (sms:send, sms:read, sms:inbox).
 * With SMSTUNNEL_E2E_MONGO_URL, each text is also checked in the server's database (see mongo.js).
 */

require('should');
const crypto = require('node:crypto');
const helper = require('node-red-node-test-helper');

const smstunnel = require('../../nodes/smstunnel.js');
const { collect } = require('../support');
const { expectSentSoon, openMessages, readKeyFile } = require('./mongo');

helper.init(require.resolve('node-red'));

const key = readKeyFile();
const TO = process.env.SMSTUNNEL_E2E_TO || '+14155550123';

(key ? describe : describe.skip)('SMSTunnel nodes against a test server', function () {
  this.timeout(90000);
  let messages;

  before(function () {
    messages = openMessages();
  });
  after(async function () {
    if (messages) await messages.close();
  });
  beforeEach(function (done) {
    helper.startServer(done);
  });
  afterEach(function (done) {
    helper.unload().then(() => helper.stopServer(done));
  });

  function flow(node, accountProps = {}) {
    return [
      { id: 'acc', type: 'smstunnel-account', name: 'Test', deviceId: key.deviceId, defaultCountryCode: '', serverUrl: key.serverUrl, ...accountProps },
      { id: 'n1', account: 'acc', wires: [['out']], ...node },
      { id: 'out', type: 'helper' },
    ];
  }

  const sender = (type, props = {}) => ({ type, to: 'to', toType: 'msg', message: 'payload', messageType: 'msg', deviceId: '', wait: false, ...props });

  async function load(nodes, apiKey = key.apiKey) {
    await helper.load(smstunnel, nodes, { acc: { apiKey } });
    return { node: helper.getNode('n1'), out: helper.getNode('out') };
  }

  it('sends a text, waits until the phone has sent it, and it is stored as sent', async function () {
    const words = `SMSTunnel Node-RED end-to-end test ${crypto.randomBytes(4).toString('hex')}`;
    const { node, out } = await load(flow(sender('smstunnel-send', { wait: true })));
    const output = collect(out, 'input', 1, 80000);

    node.receive({ payload: words, to: TO });
    const [msg] = await output;

    msg.payload.messageId.should.match(/^[a-f0-9]{24}$/);
    msg.payload.status.should.be.oneOf('sent', 'delivered');
    msg.payload.queued.should.be.false();
    msg.payload.should.have.property('sentAt');
    await expectSentSoon(messages, msg.payload.messageId, TO, words, key.deviceId);
  });

  it('sends one text to each of two numbers', async function () {
    const words = `SMSTunnel Node-RED two numbers ${crypto.randomBytes(4).toString('hex')}`;
    const numbers = ['+14155550131', '+14155550132'];
    const { node, out } = await load(flow(sender('smstunnel-send')));
    const output = collect(out, 'input', 2, 80000);

    node.receive({ payload: words, to: numbers.join(', ') });
    const sent = await output;

    sent.map((msg) => msg.to).should.eql(numbers);
    for (const msg of sent) await expectSentSoon(messages, msg.payload.messageId, msg.to, words, key.deviceId);
  });

  it('completes a local number with the country code of the account', async function () {
    const words = `SMSTunnel Node-RED country code ${crypto.randomBytes(4).toString('hex')}`;
    const { node, out } = await load(flow(sender('smstunnel-send'), { defaultCountryCode: '+1' }));
    const output = collect(out, 'input', 1, 80000);

    node.receive({ payload: words, to: '4155550133' });
    const [msg] = await output;

    await expectSentSoon(messages, msg.payload.messageId, '+14155550133', words, key.deviceId);
  });

  it('sends a sign-in code', async function () {
    const words = `Your SMSTunnel Node-RED test code is ${crypto.randomInt(100000, 1000000)}`;
    const { node, out } = await load(flow(sender('smstunnel-code')));
    const output = collect(out, 'input', 1, 80000);

    node.receive({ payload: words, to: TO });
    const [msg] = await output;

    msg.payload.should.not.have.property('message');
    await expectSentSoon(messages, msg.payload.messageId, TO, words, key.deviceId);
  });

  it('passes on the refusal of a code text without a code', async function () {
    const { node } = await load(flow(sender('smstunnel-code')));
    const error = new Promise((resolve) => node.once('call:error', resolve));

    node.receive({ payload: 'There is no code in this text', to: TO });

    (await error).args[0].message.should.match(/No valid verification code found.*\(400\)$/);
  });

  it('reports a wrong key', async function () {
    const { node } = await load(flow(sender('smstunnel-send')), 'sk_live_this_key_does_not_exist_0000000000');
    const error = new Promise((resolve) => node.once('call:error', resolve));

    node.receive({ payload: 'Hi', to: TO });

    (await error).args[0].message.should.equal('Invalid or expired API key (401)');
  });

  it('outputs the texts already received, with "also the last texts"', async function () {
    const { out } = await load(
      flow({ type: 'smstunnel-received', interval: 60, deviceId: '', phone: '', startWith: 'latest' }),
    );

    const [msg] = await collect(out, 'input', 1, 20000);

    msg.from.should.match(/^\+\d+$/);
    msg.topic.should.equal(msg.from);
    msg.smstunnel.should.have.properties('id', 'sender', 'receivedAt', 'isEncrypted');
  });
});
