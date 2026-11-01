'use strict';

const should = require('should');
const helper = require('node-red-node-test-helper');

const smstunnel = require('../nodes/smstunnel.js');
const { collect, delay, sent, startFakeApi } = require('./support');

// NODE_RED_HOME runs the same tests against another Node-RED install (a folder with node-red in node_modules).
helper.init(
  process.env.NODE_RED_HOME
    ? require.resolve('node-red', { paths: [process.env.NODE_RED_HOME] })
    : require.resolve('node-red'),
);

const KEY = 'sk_live_test_0123456789abcdef0123456789abcd';

async function until(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting');
    await delay(10);
  }
}

describe('SMSTunnel nodes', function () {
  let api;

  before(async function () {
    api = await startFakeApi();
  });
  after(async function () {
    await api.close();
  });
  beforeEach(function (done) {
    api.reset();
    helper.startServer(done);
  });
  afterEach(function (done) {
    helper.unload().then(() => helper.stopServer(done));
  });

  function account(props = {}) {
    return { id: 'acc', type: 'smstunnel-account', name: 'Test', deviceId: '', defaultCountryCode: '', serverUrl: api.url, ...props };
  }

  function sender(type, props = {}) {
    return {
      id: 'n1',
      type,
      account: 'acc',
      to: 'to',
      toType: 'msg',
      message: 'payload',
      messageType: 'msg',
      deviceId: '',
      wait: false,
      wires: [['out']],
      ...props,
    };
  }

  async function load(nodes, credentials = { acc: { apiKey: KEY } }) {
    await helper.load(smstunnel, [...nodes, { id: 'out', type: 'helper' }], credentials);
    return { node: helper.getNode(nodes[1].id), out: helper.getNode('out') };
  }

  function nextError(node) {
    return new Promise((resolve) => node.once('call:error', (call) => resolve(call)));
  }

  describe('SMSTunnel send', function () {
    it('texts msg.payload to msg.to and outputs the result', async function () {
      api.handler = () => sent('m1');
      const { node, out } = await load([account(), sender('smstunnel-send')]);
      const output = collect(out, 'input', 1);

      node.receive({ payload: 'Your order has shipped.', to: '+14155550123', topic: 'orders' });
      const [msg] = await output;

      api.requests.length.should.equal(1);
      api.requests[0].path.should.equal('/api/v1/sms/send');
      api.requests[0].headers['x-api-key'].should.equal(KEY);
      api.requests[0].headers['user-agent'].should.match(/^smstunnel-node-red\/\d+\.\d+\.\d+ Node\.js\//);
      api.requests[0].body.should.eql({ to: '+14155550123', message: 'Your order has shipped.' });
      msg.to.should.equal('+14155550123');
      msg.topic.should.equal('orders');
      msg.payload.should.eql({
        messageId: 'm1',
        to: '+14155550123',
        status: 'pending',
        queued: false,
        branded: false,
        message: 'Your order has shipped.',
        remaining: { clean: 95, total: 'unlimited' },
      });
    });

    it("uses the account's phone and country code, the node's phone over it, and msg over both", async function () {
      api.handler = () => sent('m');
      const { node, out } = await load([
        account({ deviceId: 'acc-phone', defaultCountryCode: '+40' }),
        sender('smstunnel-send', { deviceId: 'node-phone' }),
      ]);
      const output = collect(out, 'input', 2);

      node.receive({ payload: 'One', to: '0712345678' });
      await until(() => api.requests.length === 1);
      node.receive({ payload: 'Two', to: '0712345678', deviceId: 'msg-phone', defaultCountryCode: '+49' });
      await output;

      api.requests[0].body.should.eql({ to: '0712345678', message: 'One', deviceId: 'node-phone', defaultCountryCode: '+40' });
      api.requests[1].body.should.eql({ to: '0712345678', message: 'Two', deviceId: 'msg-phone', defaultCountryCode: '+49' });
    });

    it('sends one text per number and outputs one message for each', async function () {
      let count = 0;
      api.handler = () => sent(`m${(count += 1)}`);
      const { node, out } = await load([account(), sender('smstunnel-send')]);
      const output = collect(out, 'input', 3);

      node.receive({ payload: 'Meeting moved to 3 pm', to: '+14155550123, +14155550124\n+14155550125, +14155550123' });
      const messages = await output;

      api.requests.map((request) => request.body.to).should.eql(['+14155550123', '+14155550124', '+14155550125']);
      messages.map((msg) => [msg.to, msg.payload.messageId]).should.eql([
        ['+14155550123', 'm1'],
        ['+14155550124', 'm2'],
        ['+14155550125', 'm3'],
      ]);
    });

    it('takes To and Text from the node: a string and a JSONata expression', async function () {
      api.handler = () => sent('m');
      const { node, out } = await load([
        account(),
        sender('smstunnel-send', { to: '+14155550199', toType: 'str', message: '"Hello " & payload.name', messageType: 'jsonata' }),
      ]);
      const output = collect(out, 'input', 1);

      node.receive({ payload: { name: 'Ana' } });
      await output;

      api.requests[0].body.should.eql({ to: '+14155550199', message: 'Hello Ana' });
    });

    for (const [title, msg, key] of [
      ['an empty text', { payload: '  ', to: '+14155550123' }, 'smstunnel.error.noText'],
      ['no number', { payload: 'Hi' }, 'smstunnel.error.noRecipient'],
      ['too many numbers', { payload: 'Hi', to: Array.from({ length: 31 }, (_, i) => `+1415555${String(i).padStart(4, '0')}`) }, 'smstunnel.error.tooMany'],
      ['a number given as a JavaScript number', { payload: 'Hi', to: 14155550123 }, 'must be text'],
    ]) {
      it(`refuses ${title} before sending`, async function () {
        const { node } = await load([account(), sender('smstunnel-send')]);
        const error = nextError(node);

        node.receive(msg);
        const call = await error;

        String(call.args[0].message || call.args[0]).should.containEql(key);
        api.requests.length.should.equal(0);
      });
    }

    it('reports a wrong key to Catch nodes with the status', async function () {
      api.handler = () => ({ status: 401, body: { message: 'Invalid or expired API key', error: 'Unauthorized', statusCode: 401 } });
      const { node } = await load([account(), sender('smstunnel-send')]);
      const error = nextError(node);
      const status = new Promise((resolve) => node.on('call:status', (call) => call.args[0].fill === 'red' && resolve(call.args[0])));

      node.receive({ payload: 'Hi', to: '+14155550123' });
      const call = await error;

      call.args[0].message.should.equal('Invalid or expired API key (401)');
      call.args[1].to.should.equal('+14155550123');
      (await status).text.should.equal('smstunnel.status.invalidKey');
    });

    it('with several numbers, reports a refused one and still texts the others', async function () {
      api.handler = (request) =>
        request.body.to === '+1415bad'
          ? { status: 400, body: { message: 'Phone number must contain 7-25 characters', statusCode: 400 } }
          : sent(`ok-${request.body.to}`);
      const { node, out } = await load([account(), sender('smstunnel-send')]);
      const output = collect(out, 'input', 2);
      const error = nextError(node);

      node.receive({ payload: 'Hi', to: ['+14155550123', '+1415bad', '+14155550124'] });
      const [messages, call] = await Promise.all([output, error]);

      messages.map((msg) => msg.to).should.eql(['+14155550123', '+14155550124']);
      call.args[0].message.should.containEql('smstunnel.error.forNumber');
      call.args[1].to.should.equal('+1415bad');
      call.args[1].smstunnel.error.should.eql({ status: 400, message: 'Phone number must contain 7-25 characters' });
    });

    it('with several numbers, stops at a 403: the others would be refused too', async function () {
      api.handler = () => ({ status: 403, body: { message: 'Forbidden', statusCode: 403 } });
      const { node } = await load([account(), sender('smstunnel-send')]);
      const error = nextError(node);

      node.receive({ payload: 'Hi', to: '+14155550123, +14155550124, +14155550125' });
      const call = await error;

      api.requests.length.should.equal(1);
      call.args[0].message.should.containEql('smstunnel.error.stopped');
    });

    it('waits out a 429 as SMSTunnel says, then tries once more', async function () {
      let calls = 0;
      api.handler = () =>
        (calls += 1) === 1
          ? { status: 429, body: { statusCode: 429, message: 'ThrottlerException: Too Many Requests' }, headers: { 'Retry-After': '1' } }
          : sent('after-wait');
      const { node, out } = await load([account(), sender('smstunnel-send')]);
      const output = collect(out, 'input', 1, 5000);
      const started = Date.now();

      node.receive({ payload: 'Hi', to: '+14155550123' });
      const [msg] = await output;

      msg.payload.messageId.should.equal('after-wait');
      (Date.now() - started).should.be.aboveOrEqual(950);
      api.requests.length.should.equal(2);
    });

    it('with Wait, asks for the status until the phone has sent it', async function () {
      this.timeout(10000);
      let checks = 0;
      api.handler = (request) => {
        if (request.method === 'POST') return sent('w1');
        checks += 1;
        return {
          status: 200,
          body: {
            success: true,
            data: { id: 'w1', phoneNumber: '+14155550123', status: checks < 2 ? 'pending' : 'sent', deliveryStatus: checks < 2 ? 'pending' : 'sent', sentAt: checks < 2 ? undefined : '2026-11-01T10:00:00.000Z' },
          },
        };
      };
      const { node, out } = await load([account(), sender('smstunnel-send', { wait: true })]);
      const output = collect(out, 'input', 1, 8000);

      node.receive({ payload: 'Hi', to: '+14155550123' });
      const [msg] = await output;

      msg.payload.status.should.equal('sent');
      msg.payload.sentAt.should.equal('2026-11-01T10:00:00.000Z');
      api.requests.filter((request) => request.path === '/api/v1/sms/status/w1').length.should.equal(2);
    });

    it('does not wait for a text that is queued because the phone is offline', async function () {
      api.handler = () => ({ status: 200, body: { success: true, messageId: 'q1', queued: true, data: { messageId: 'q1', queued: true } } });
      const { node, out } = await load([account(), sender('smstunnel-send', { wait: true })]);
      const output = collect(out, 'input', 1);
      const status = new Promise((resolve) => node.on('call:status', (call) => call.args[0].fill === 'yellow' && resolve(call.args[0])));

      node.receive({ payload: 'Hi', to: '+14155550123' });
      const [msg] = await output;

      msg.payload.status.should.equal('queued');
      msg.payload.queued.should.be.true();
      (await status).text.should.equal('smstunnel.status.queued');
      api.requests.length.should.equal(1);
    });

    it('says so when the account has no API key', async function () {
      const { node } = await load([account(), sender('smstunnel-send')], {});
      const error = nextError(node);

      node.receive({ payload: 'Hi', to: '+14155550123' });
      const call = await error;

      call.args[0].message.should.equal('smstunnel.error.noKey');
      api.requests.length.should.equal(0);
    });

    it('sends texts of one account one at a time', async function () {
      let active = 0;
      let most = 0;
      api.handler = async () => {
        active += 1;
        most = Math.max(most, active);
        await delay(30);
        active -= 1;
        return sent('m');
      };
      const { node, out } = await load([account(), sender('smstunnel-send')]);
      const output = collect(out, 'input', 4);

      for (let i = 0; i < 4; i += 1) node.receive({ payload: `Text ${i}`, to: '+14155550123' });
      await output;

      most.should.equal(1);
    });
  });

  describe('SMSTunnel code', function () {
    it('sends to send-2fa and leaves the text out of the output', async function () {
      api.handler = () => sent('c1');
      const { node, out } = await load([account({ defaultCountryCode: '+1' }), sender('smstunnel-code')]);
      const output = collect(out, 'input', 1);

      node.receive({ payload: 'Your sign-in code is 482913', to: '4155550123' });
      const [msg] = await output;

      api.requests[0].path.should.equal('/api/v1/sms/send-2fa');
      api.requests[0].body.should.eql({ to: '4155550123', message: 'Your sign-in code is 482913', defaultCountryCode: '+1' });
      msg.payload.messageId.should.equal('c1');
      should(msg.payload.message).be.undefined();
      JSON.stringify(msg).should.not.containEql('482913');
    });

    it('goes to one number only', async function () {
      const { node } = await load([account(), sender('smstunnel-code')]);
      const error = nextError(node);

      node.receive({ payload: 'Code 482913', to: '+14155550123, +14155550124' });
      const call = await error;

      call.args[0].message.should.equal('smstunnel.error.oneNumber');
      api.requests.length.should.equal(0);
    });

    it('passes on the refusal of a text without a code', async function () {
      api.handler = () => ({ status: 400, body: { message: 'No valid verification code found', error: 'Bad Request', statusCode: 400 } });
      const { node } = await load([account(), sender('smstunnel-code')]);
      const error = nextError(node);

      node.receive({ payload: 'No code here', to: '+14155550123' });

      (await error).args[0].message.should.equal('No valid verification code found (400)');
    });
  });

  describe('SMSTunnel received', function () {
    function text(id, minutesAgo, extra = {}) {
      return {
        id,
        sender: '+40712345678',
        message: `Text ${id}`,
        isEncrypted: false,
        receivedAt: new Date(Date.now() - minutesAgo * 60000).toISOString(),
        deviceId: 'd1',
        deviceName: 'Store phone',
        ...extra,
      };
    }

    function page(messages, hasMore = false, number = 1) {
      return { status: 200, body: { success: true, data: { messages, total: messages.length, page: number, limit: 50, hasMore } } };
    }

    // Each test gets its own node id: the node keeps what it has seen in its context across a redeploy.
    let receivedCount = 0;
    function received(props = {}) {
      receivedCount += 1;
      return { id: `r${receivedCount}`, type: 'smstunnel-received', account: 'acc', interval: 60, deviceId: '', phone: '', startWith: 'new', wires: [['out']], ...props };
    }

    it('starts quietly, then outputs each new text with its sender', async function () {
      let inbox = [text('b', 5), text('a', 10)];
      api.handler = () => page(inbox);
      const { node, out } = await load([account(), received()]);
      const outputs = [];
      out.on('input', (msg) => outputs.push(msg));

      await until(() => api.requests.length === 1);
      await delay(30);
      outputs.length.should.equal(0);

      inbox = [text('d', 0, { sender: '+14155550123', message: 'Are you open today?', simSlot: 1 }), text('c', 1), ...inbox];
      const done = new Promise((resolve) => node.once('call:status', resolve));
      node.receive({});
      await until(() => outputs.length === 2);
      await done;

      outputs.map((msg) => msg.smstunnel.id).should.eql(['c', 'd']);
      const last = outputs[1];
      last.payload.should.equal('Are you open today?');
      last.from.should.equal('+14155550123');
      last.topic.should.equal('+14155550123');
      last.smstunnel.should.containEql({ sender: '+14155550123', deviceName: 'Store phone', simSlot: 1, isEncrypted: false });
    });

    it('with "also the last texts", outputs those already there, oldest first', async function () {
      api.handler = () => page([text('b', 5), text('a', 10)]);
      const { out } = await load([account(), received({ startWith: 'latest' })]);

      const messages = await collect(out, 'input', 2);

      messages.map((msg) => msg.smstunnel.id).should.eql(['a', 'b']);
    });

    it('asks for the next page until it reaches a text it knows', async function () {
      let starting = true;
      const fresh = Array.from({ length: 50 }, (_, i) => text(`n${i}`, 0));
      api.handler = (request) => {
        if (starting) return page([text('old', 60)]);
        return request.query.page === '2' ? page([text('extra', 1), text('old', 60)], false, 2) : page(fresh, true, 1);
      };
      const { node, out } = await load([account(), received()]);
      await until(() => api.requests.length === 1);
      starting = false;
      const output = collect(out, 'input', 51);

      node.receive({});
      const messages = await output;

      api.requests.slice(1).map((request) => request.query.page).should.eql(['1', '2']);
      messages[0].smstunnel.id.should.equal('extra');
      messages[50].smstunnel.id.should.equal('n0');
    });

    it('checks once more right after a check that was under way when asked', async function () {
      api.handler = async () => {
        await delay(100);
        return page([]);
      };
      const { node } = await load([account(), received()]);
      await until(() => api.requests.length === 1);

      node.receive({});
      node.receive({});
      await until(() => api.requests.length === 2);
      await delay(250);

      api.requests.length.should.equal(2);
    });

    it('sends the filters and 50 texts per page', async function () {
      api.handler = () => page([]);
      await load([account(), received({ deviceId: 'phone-1', phone: '+14155550123' })]);

      await until(() => api.requests.length === 1);

      api.requests[0].path.should.equal('/api/v1/sms/received');
      api.requests[0].query.should.eql({ limit: '50', page: '1', deviceId: 'phone-1', phone: '+14155550123' });
    });

    it('warns once when the key may not read received texts', async function () {
      api.handler = () => ({
        status: 403,
        body: { statusCode: 403, message: 'This API key may not read received texts.', code: 'PERMISSION_REQUIRED', permission: 'sms:inbox' },
      });
      const { node } = await load([account(), received()]);
      const warnings = [];
      node.on('call:warn', (call) => warnings.push(call.args[0]));

      await until(() => api.requests.length === 1);
      node.receive({});
      await until(() => api.requests.length === 2);
      await delay(50);

      warnings.should.eql(['smstunnel.error.inbox']);
    });

    // The test helper clears node context between loads, so carrying on after a redeploy is checked against a
    // real Node-RED in test/e2e/run-node-red.js. Here: what it keeps for that.
    it('keeps the texts it has seen in its context, oldest first', async function () {
      api.handler = () => page([text('b', 0), text('a', 10)]);
      const { node } = await load([account(), received()]);
      await until(() => api.requests.length === 1);
      await delay(30);

      const state = await new Promise((resolve, reject) =>
        node.context().get('state', (error, value) => (error ? reject(error) : resolve(value))),
      );

      state.seen.should.eql(['a', 'b']);
      (Date.now() - state.at).should.be.below(5000);
    });

    it('stops checking when the flow stops', async function () {
      api.handler = () => page([]);
      await load([account(), received()]);
      await until(() => api.requests.length === 1);

      await helper.unload();
      await delay(50);

      api.requests.length.should.equal(1);
    });
  });
});
