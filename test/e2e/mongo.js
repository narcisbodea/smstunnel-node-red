'use strict';

/**
 * Reads texts from the test server's database, to check what the API stored. Optional: without
 * SMSTUNNEL_E2E_MONGO_URL the checks are skipped. The `mongodb` driver is not a dependency of this package; it is
 * resolved from SMSTUNNEL_E2E_MONGODB_FROM (a folder that has it, such as the SMSTunnel server's) or from here.
 */
function openMessages() {
  const url = process.env.SMSTUNNEL_E2E_MONGO_URL;
  if (!url) return null;
  const from = process.env.SMSTUNNEL_E2E_MONGODB_FROM || process.cwd();
  const { MongoClient, ObjectId } = require(require.resolve('mongodb', { paths: [from] }));
  const client = new MongoClient(url, { serverSelectionTimeoutMS: 5000 });
  return {
    async find(messageId) {
      await client.connect();
      return client.db().collection('messages').findOne({ _id: new ObjectId(messageId) });
    },
    close: () => client.close(),
  };
}

/** Checks one stored text: outgoing, to that number, with those words, and sent by the phone. */
async function expectStored(messages, messageId, to, words, deviceId) {
  if (!messages) return;
  const document = await messages.find(messageId);
  if (!document) throw new Error(`Text ${messageId} is not in the database.`);
  const problems = [];
  if (document.type !== 'outgoing') problems.push(`type ${document.type}`);
  if (document.phoneNumber !== to) problems.push(`phoneNumber ${document.phoneNumber}`);
  if (document.message !== words) problems.push(`message ${JSON.stringify(document.message)}`);
  if (!['sent', 'delivered'].includes(document.status)) problems.push(`status ${document.status}`);
  if (deviceId && String(document.deviceId) !== deviceId) problems.push(`deviceId ${document.deviceId}`);
  if (problems.length) throw new Error(`Text ${messageId} is stored with ${problems.join(', ')}.`);
}

/** Waits for the phone to send it: the API accepts a text before the phone has sent it. */
async function expectSentSoon(messages, messageId, to, words, deviceId, timeoutMs = 30000) {
  if (!messages) return;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await expectStored(messages, messageId, to, words, deviceId);
    } catch (error) {
      if (Date.now() > deadline || !/status pending/.test(error.message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

function readKeyFile() {
  const file = process.env.SMSTUNNEL_E2E_KEY_FILE;
  if (!file) return null;
  const key = JSON.parse(require('node:fs').readFileSync(file, 'utf8'));
  const host = new URL(key.serverUrl).hostname;
  if (host === 'smstunnel.io' || host.endsWith('.smstunnel.io')) {
    throw new Error('The end-to-end tests never run against production. Point the key file at a test server.');
  }
  return key;
}

module.exports = { expectSentSoon, expectStored, openMessages, readKeyFile };
