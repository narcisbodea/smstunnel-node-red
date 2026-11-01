'use strict';

/**
 * End to end in a real Node-RED: packs this module with `npm pack`, installs the tarball in a fresh user directory,
 * starts Node-RED on a free port, deploys flows through the Admin API, presses their inject buttons, and checks
 * - the editor gets the nodes, their help, their messages and their icon,
 * - a text and a sign-in code reach the test server and are stored as sent (with SMSTUNNEL_E2E_MONGO_URL),
 * - the API key is kept encrypted in flows_cred.json and never comes back from GET /flows,
 * - SMSTunnel received carries on after a full redeploy (against a fake API, which can be given new texts).
 *
 * Needs SMSTUNNEL_E2E_KEY_FILE (see mongo.js); never runs against production. Run: npm run test:runtime
 */

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { startFakeApi } = require('../support');
const { expectSentSoon, openMessages, readKeyFile } = require('./mongo');

const ROOT = path.resolve(__dirname, '..', '..');
const PACKAGE = require(path.join(ROOT, 'package.json'));
const TO = process.env.SMSTUNNEL_E2E_TO || '+14155550123';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** npm through the same Node.js (`npm run` sets npm_execpath), so no shell is needed. */
function npm(args, options) {
  if (process.env.npm_execpath) return execFileSync(process.execPath, [process.env.npm_execpath, ...args], options);
  const windows = process.platform === 'win32';
  return execFileSync(windows ? 'npm.cmd' : 'npm', args, { ...options, shell: windows });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what, check, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(250);
  }
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function main() {
  const key = readKeyFile();
  if (!key) {
    console.log('Skipped: set SMSTUNNEL_E2E_KEY_FILE to run against a test server.');
    return;
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'smstunnel-node-red-'));
  const userDir = path.join(work, 'user');
  fs.mkdirSync(userDir);
  const port = await freePort();
  const admin = `http://127.0.0.1:${port}`;
  const fake = await startFakeApi();
  const messages = openMessages();
  let red;
  let log = '';

  try {
    // 1. Install the packed module, as `npm install` from the registry would.
    const tarball = npm(['pack', '--silent', '--pack-destination', work], { cwd: ROOT, encoding: 'utf8' })
      .trim()
      .split(/\r?\n/)
      .pop();
    fs.writeFileSync(path.join(userDir, 'package.json'), JSON.stringify({ name: 'node-red-project', private: true }));
    npm(['install', '--no-audit', '--no-fund', '--silent', path.join(work, tarball)], { cwd: userDir, stdio: 'inherit' });
    console.log(`Installed ${tarball} in ${userDir}`);

    // 2. Start Node-RED.
    fs.writeFileSync(
      path.join(userDir, 'settings.js'),
      `module.exports = ${JSON.stringify({
        uiHost: '127.0.0.1',
        uiPort: port,
        flowFile: 'flows.json',
        credentialSecret: 'smstunnel-e2e-secret',
        contextStorage: { default: { module: 'memory' } },
        logging: { console: { level: 'info', metrics: false, audit: false } },
        externalModules: { autoInstall: false, palette: { allowInstall: false } },
      })};`,
    );
    // NODE_RED_HOME: a folder with another Node-RED version in its node_modules.
    const redHome = process.env.NODE_RED_HOME ? { paths: [process.env.NODE_RED_HOME] } : undefined;
    const redJs = path.join(path.dirname(require.resolve('node-red/package.json', redHome)), 'red.js');
    red = spawn(process.execPath, [redJs, '--userDir', userDir, '--settings', path.join(userDir, 'settings.js')], {
      cwd: userDir,
      env: { ...process.env, NODE_RED_ENABLE_PROJECTS: 'false' },
    });
    red.stdout.on('data', (chunk) => (log += chunk));
    red.stderr.on('data', (chunk) => (log += chunk));
    await waitFor('Node-RED to start', async () => (await fetch(`${admin}/settings`)).ok);
    console.log(`Node-RED ${(await (await fetch(`${admin}/settings`)).json()).version} is up on ${admin}`);

    // 3. The editor gets the nodes, their help, messages and icon.
    const modules = await (await fetch(`${admin}/nodes`, { headers: { Accept: 'application/json' } })).json();
    const set = modules.find((entry) => entry.module === PACKAGE.name);
    assert.ok(set, `${PACKAGE.name} is not in the palette`);
    assert.equal(set.enabled, true);
    assert.equal(set.err, undefined, `The node set failed to load: ${set.err}`);
    assert.deepEqual(set.types.sort(), ['smstunnel-account', 'smstunnel-code', 'smstunnel-received', 'smstunnel-send']);
    const html = await (await fetch(`${admin}/nodes`, { headers: { Accept: 'text/html' } })).text();
    for (const type of set.types) {
      assert.ok(html.includes(`data-template-name="${type}"`), `no edit dialog for ${type}`);
      assert.ok(html.includes(`data-help-name="${type}"`), `no help for ${type}`);
    }
    const catalog = await (await fetch(`${admin}/locales/${PACKAGE.name}/smstunnel?lng=en-US`)).json();
    assert.equal(catalog.smstunnel.status.sending, 'sending…');
    const icon = await fetch(`${admin}/icons/${PACKAGE.name}/smstunnel.svg`);
    assert.equal(icon.status, 200);
    assert.match(icon.headers.get('content-type'), /svg/);
    const listing = JSON.stringify(await (await fetch(`${admin}/library/examples/flows/${PACKAGE.name}`)).json());
    const examples = fs.readdirSync(path.join(ROOT, 'examples')).map((name) => name.replace(/\.json$/, ''));
    for (const name of examples) assert.ok(listing.includes(name), `the example "${name}" is not offered: ${listing}`);
    const example = await (
      await fetch(`${admin}/library/examples/flows/${PACKAGE.name}/${encodeURIComponent(examples[0])}`)
    ).json();
    assert.ok(example.some((node) => node.type.startsWith('smstunnel-')), 'the example has no SMSTunnel node');
    console.log(`The editor gets the 4 nodes with their help, messages and icon, and the ${examples.length} examples.`);

    // 4. Deploy: a text (waiting for the phone), a sign-in code, and SMSTunnel received on a fake API.
    const words = `SMSTunnel Node-RED runtime test ${crypto.randomBytes(4).toString('hex')}`;
    const codeWords = `Your SMSTunnel Node-RED runtime code is ${crypto.randomInt(100000, 1000000)}`;
    const out = (name) => path.join(work, `${name}.jsonl`);
    const file = (id, name) => ({
      id,
      type: 'file',
      z: 'tab',
      name,
      filename: out(name),
      filenameType: 'str',
      appendNewline: true,
      createDir: true,
      overwriteFile: 'false',
      encoding: 'none',
      wires: [],
    });
    let inbox = [{ id: 'fake-a', sender: '+14155550177', message: 'Already there', receivedAt: new Date().toISOString() }];
    fake.handler = () => ({
      status: 200,
      body: { success: true, data: { messages: inbox, total: inbox.length, page: 1, limit: 50, hasMore: false } },
    });
    // The file node writes msg.payload only: these put what the checks need there, as JSON.
    const keep = (id, expression, next) => ({
      id,
      type: 'change',
      z: 'tab',
      name: '',
      rules: [{ t: 'set', p: 'payload', pt: 'msg', to: expression, tot: 'jsonata' }],
      wires: [[next]],
    });
    const flows = [
      { id: 'tab', type: 'tab', label: 'SMSTunnel e2e' },
      { id: 'acc', type: 'smstunnel-account', name: 'Test server', deviceId: key.deviceId, defaultCountryCode: '', serverUrl: key.serverUrl, credentials: { apiKey: key.apiKey } },
      { id: 'acc-fake', type: 'smstunnel-account', name: 'Fake API', deviceId: '', defaultCountryCode: '', serverUrl: fake.url, credentials: { apiKey: 'sk_live_fake_0000000000000000000000000000' } },
      { id: 'inj-send', type: 'inject', z: 'tab', name: '', props: [{ p: 'payload' }], payload: words, payloadType: 'str', repeat: '', once: false, wires: [['send']] },
      { id: 'send', type: 'smstunnel-send', z: 'tab', account: 'acc', to: TO, toType: 'str', message: 'payload', messageType: 'msg', deviceId: '', wait: true, wires: [['out-send']] },
      file('out-send', 'sent'),
      { id: 'inj-code', type: 'inject', z: 'tab', name: '', props: [{ p: 'payload' }], payload: codeWords, payloadType: 'str', repeat: '', once: false, wires: [['code']] },
      { id: 'code', type: 'smstunnel-code', z: 'tab', account: 'acc', to: TO, toType: 'str', message: 'payload', messageType: 'msg', deviceId: '', wait: false, wires: [['out-code']] },
      file('out-code', 'code'),
      { id: 'inj-received', type: 'inject', z: 'tab', name: '', props: [{ p: 'payload' }], payload: '', payloadType: 'date', repeat: '', once: false, wires: [['received']] },
      { id: 'received', type: 'smstunnel-received', z: 'tab', account: 'acc-fake', interval: 600, deviceId: '', phone: '', startWith: 'new', wires: [['keep-received']] },
      keep('keep-received', '{"payload": payload, "from": from, "id": smstunnel.id}', 'out-received'),
      file('out-received', 'received'),
      { id: 'catch', type: 'catch', z: 'tab', name: '', scope: null, uncaught: false, wires: [['keep-error']] },
      keep('keep-error', '{"message": error.message, "node": error.source.type}', 'out-errors'),
      file('out-errors', 'errors'),
    ];
    const deploy = async () => {
      const answer = await fetch(`${admin}/flows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Node-RED-Deployment-Type': 'full' },
        body: JSON.stringify(flows),
      });
      assert.equal(answer.status, 204, `deploy answered ${answer.status}: ${await answer.text()}`);
    };
    await deploy();
    await waitFor('the first check of SMSTunnel received', async () => fake.requests.length >= 1);

    // 5. Press the buttons; the outputs land in files.
    for (const id of ['inj-send', 'inj-code']) {
      const answer = await fetch(`${admin}/inject/${id}`, { method: 'POST' });
      assert.equal(answer.status, 200, `inject ${id} answered ${answer.status}`);
    }
    const [sentMsg] = await waitFor('the text to be sent', async () => readLines(out('sent')).length > 0 && readLines(out('sent')), 90000);
    const [codeMsg] = await waitFor('the code to be sent', async () => readLines(out('code')).length > 0 && readLines(out('code')));
    assert.deepEqual(readLines(out('errors')), [], 'a node reported an error');
    assert.equal(sentMsg.to, TO);
    assert.ok(['sent', 'delivered'].includes(sentMsg.status), `the text is ${sentMsg.status}`);
    assert.equal(codeMsg.message, undefined, 'the code text came out of the code node');
    await expectSentSoon(messages, sentMsg.messageId, TO, words, key.deviceId);
    await expectSentSoon(messages, codeMsg.messageId, TO, codeWords, key.deviceId);
    console.log(
      `The text (${sentMsg.messageId}, ${sentMsg.status}) and the code (${codeMsg.messageId}) went out` +
        (messages ? ' and are stored as sent.' : '.'),
    );

    // 6. The key is encrypted at rest and never returned to the editor.
    const credFile = fs.readFileSync(path.join(userDir, 'flows_cred.json'), 'utf8');
    assert.ok(!credFile.includes(key.apiKey), 'the API key is in flows_cred.json in clear text');
    assert.ok(/"\$":/.test(credFile), 'flows_cred.json is not encrypted');
    const deployed = await (await fetch(`${admin}/flows`)).text();
    assert.ok(!deployed.includes(key.apiKey), 'GET /flows returned the API key');
    const creds = await (await fetch(`${admin}/credentials/smstunnel-account/acc`)).json();
    assert.deepEqual(creds, { has_apiKey: true });
    console.log('The API key is encrypted in flows_cred.json, and the editor only learns that there is one.');

    // 7. SMSTunnel received: nothing at start, then the text that arrived during a full redeploy.
    assert.deepEqual(readLines(out('received')), []);
    await deploy();
    inbox = [{ id: 'fake-b', sender: '+14155550178', message: 'Arrived during the redeploy', receivedAt: new Date().toISOString() }, ...inbox];
    const [arrived] = await waitFor('the received text after the redeploy', async () => readLines(out('received')).length > 0 && readLines(out('received')), 20000);
    assert.equal(arrived.payload, 'Arrived during the redeploy');
    assert.equal(arrived.from, '+14155550178');
    assert.equal(readLines(out('received')).length, 1);
    console.log('SMSTunnel received output nothing at start, and after a full redeploy only the new text.');

    console.log('\nAll runtime checks passed.');
  } catch (error) {
    console.error(`\nNode-RED log:\n${log.split('\n').slice(-40).join('\n')}`);
    throw error;
  } finally {
    if (red) {
      red.kill();
      await new Promise((resolve) => (red.exitCode === null ? red.once('exit', resolve) : resolve()));
    }
    await fake.close();
    if (messages) await messages.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
