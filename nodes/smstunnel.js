'use strict';

const { createClient, SmsTunnelError } = require('./lib/client');
const { MAX_RECIPIENTS, RecipientError, maskNumber, parseRecipients } = require('./lib/recipients');
const { version } = require('../package.json');

const USER_AGENT = `smstunnel-node-red/${version} Node.js/${process.versions.node}`;

/** How long "Wait until the phone sends it" waits, and how often it asks. */
const WAIT_MS = 60000;
const WAIT_STEPS_MS = [1000, 2000, 3000, 5000, 8000, 10000];
/** The longest a 429 is waited out before the one retry. */
const MAX_RETRY_AFTER_S = 60;

/** The received node: texts per page, pages per check, texts output at start, ids remembered. */
const RECEIVED_PAGE_SIZE = 50;
const RECEIVED_MAX_PAGES = 4;
const RECEIVED_START_COUNT = 20;
const RECEIVED_MEMORY = 500;
/** After a redeploy or a restart within this time, the received node carries on where it stopped. */
const RECEIVED_RESUME_MS = 10 * 60 * 1000;
const RECEIVED_MIN_INTERVAL_S = 10;

module.exports = function (RED) {
  const t = (key, values) => RED._(`smstunnel.${key}`, values);

  function evaluate(node, msg, value, type) {
    return new Promise((resolve, reject) => {
      RED.util.evaluateNodeProperty(value, type, node, msg, (error, result) =>
        error ? reject(error) : resolve(result),
      );
    });
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }

  function text(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  /** "Invalid or expired API key (401)": SMSTunnel's words and the status, for the debug sidebar. */
  function explain(error) {
    if (!(error instanceof SmsTunnelError) || !error.status) return error.message || String(error);
    return `${error.message} (${error.status}${error.code ? ` ${error.code}` : ''})`;
  }

  /** A short status badge for an error (or for the SMSTunnel error that caused it). */
  function badgeFor(error) {
    if (error && error.cause instanceof SmsTunnelError) error = error.cause;
    if (error instanceof SmsTunnelError) {
      if (error.status === 401) return { fill: 'red', shape: 'ring', text: 'smstunnel.status.invalidKey' };
      if (error.status === 403) return { fill: 'red', shape: 'ring', text: 'smstunnel.status.notAllowed' };
      if (error.status === 429) return { fill: 'yellow', shape: 'ring', text: 'smstunnel.status.rateLimited' };
      if (!error.status) return { fill: 'yellow', shape: 'ring', text: 'smstunnel.status.unreachable' };
    }
    const words = String(error.message || error);
    return { fill: 'red', shape: 'ring', text: words.length > 40 ? `${words.slice(0, 39)}…` : words };
  }

  // ─── SMSTunnel account (config node) ──────────────────────────────────────────

  function SmsTunnelAccountNode(config) {
    RED.nodes.createNode(this, config);
    this.name = config.name;
    this.deviceId = text(config.deviceId);
    this.defaultCountryCode = text(config.defaultCountryCode);
    this.client = null;
    this.setupError = null;

    const apiKey = text(this.credentials && this.credentials.apiKey);
    if (!apiKey) {
      this.setupError = t('error.noKey');
    } else {
      try {
        // serverUrl has no field in the editor: it is there for self-hosted servers and tests.
        this.client = createClient({ apiKey, serverUrl: config.serverUrl, userAgent: USER_AGENT });
      } catch (error) {
        this.setupError = error.message;
      }
    }

    // One text at a time for each account: SMSTunnel allows 30 sends a minute, and a 429 that is being waited
    // out holds the texts behind it.
    let queue = Promise.resolve();
    this.schedule = (task) => {
      const run = queue.then(task, task);
      queue = run.catch(() => undefined);
      return run;
    };
  }

  RED.nodes.registerType('smstunnel-account', SmsTunnelAccountNode, {
    credentials: { apiKey: { type: 'password' } },
  });

  // ─── SMSTunnel send / SMSTunnel code ──────────────────────────────────────────

  function setupSender(node, config, kind) {
    const account = RED.nodes.getNode(config.account);
    const ongoing = new Set();
    let closed = false;

    if (!account) node.status({ fill: 'red', shape: 'ring', text: 'smstunnel.status.noAccount' });
    else if (account.setupError) node.status({ fill: 'red', shape: 'ring', text: 'smstunnel.status.noKey' });

    node.on('input', (msg, send, done) => {
      const controller = new AbortController();
      ongoing.add(controller);
      handle(msg, send, controller.signal)
        .then(() => done())
        .catch((error) => {
          if (closed) return done();
          node.status(badgeFor(error));
          done(error instanceof Error ? error : new Error(String(error)));
        })
        .finally(() => ongoing.delete(controller));
    });

    node.on('close', (removed, done) => {
      closed = true;
      for (const controller of ongoing) controller.abort(new Error('The flow stopped.'));
      ongoing.clear();
      done();
    });

    async function handle(msg, send, signal) {
      if (!account) throw new Error(t('error.noAccount'));
      if (!account.client) throw new Error(account.setupError);

      let words = await evaluate(node, msg, config.message, config.messageType || 'msg');
      if (typeof words === 'number') words = String(words);
      if (typeof words !== 'string' || !words.trim()) throw new Error(t('error.noText'));

      let numbers;
      try {
        numbers = parseRecipients(await evaluate(node, msg, config.to, config.toType || 'msg'));
      } catch (error) {
        throw error instanceof RecipientError ? new Error(error.message) : error;
      }
      if (numbers.length === 0) throw new Error(t('error.noRecipient'));
      if (kind === 'code' && numbers.length > 1) throw new Error(t('error.oneNumber'));
      if (numbers.length > MAX_RECIPIENTS) throw new Error(t('error.tooMany', { max: MAX_RECIPIENTS }));

      const extra = {
        deviceId: text(msg.deviceId) || text(config.deviceId) || account.deviceId,
        defaultCountryCode: text(msg.defaultCountryCode) || account.defaultCountryCode,
      };

      node.status({ fill: 'blue', shape: 'dot', text: 'smstunnel.status.sending' });
      let delivered = 0; // handed to the phone, and not reported failed
      let queued = 0;
      let failed = 0;
      for (const [index, number] of numbers.entries()) {
        if (signal.aborted) return;
        const out = numbers.length === 1 ? msg : RED.util.cloneMessage(msg);
        out.to = number;
        try {
          const answer = await account.schedule(() => sendOnce(account.client, number, words, extra, signal));
          const result = resultOf(answer, number, kind === 'send' ? words : undefined);
          if (config.wait && !result.queued) await waitForPhone(account.client, result, signal);
          out.payload = result;
          if (result.queued) queued += 1;
          if (result.status === 'failed' || result.status === 'unconfirmed') failed += 1;
          else delivered += 1;
          send(out);
        } catch (error) {
          if (signal.aborted) return;
          const problem = new Error(
            numbers.length === 1
              ? explain(error)
              : t('error.forNumber', { number: maskNumber(number), reason: explain(error) }),
            { cause: error },
          );
          const stop = error instanceof SmsTunnelError && (error.status === 401 || error.status === 403);
          if (numbers.length === 1) throw problem;
          if (stop) {
            const left = numbers.length - index - 1;
            throw new Error(left > 0 ? `${problem.message} ${t('error.stopped', { count: left })}` : problem.message, {
              cause: error,
            });
          }
          out.smstunnel = { error: errorDetails(error) };
          node.error(problem, out);
          failed += 1;
        }
      }

      if (failed > 0) {
        node.status({
          fill: 'red',
          shape: 'ring',
          text:
            numbers.length === 1
              ? 'smstunnel.status.failed'
              : t('status.sentSome', { sent: delivered, count: numbers.length }),
        });
      } else if (queued > 0) {
        node.status({ fill: 'yellow', shape: 'ring', text: 'smstunnel.status.queued' });
      } else {
        node.status({
          fill: 'green',
          shape: 'dot',
          text:
            numbers.length === 1
              ? t('status.sent', { to: maskNumber(numbers[0]) })
              : t('status.sentMany', { count: delivered }),
        });
      }
    }

    /** One send, and one retry after a 429 (SMSTunnel says how long to wait). */
    async function sendOnce(client, number, words, extra, signal) {
      const call = () =>
        kind === 'code' ? client.sendVerificationCode(number, words, extra) : client.sendSms(number, words, extra);
      try {
        return await call();
      } catch (error) {
        if (!(error instanceof SmsTunnelError) || error.status !== 429) throw error;
        node.status({ fill: 'yellow', shape: 'ring', text: 'smstunnel.status.rateLimited' });
        const seconds = Math.min(MAX_RETRY_AFTER_S, Math.max(1, error.retryAfter ?? 15));
        await sleep(seconds * 1000, signal);
        return call();
      }
    }

    /** Asks for the status until the phone has sent the text (or it failed), for up to a minute. */
    async function waitForPhone(client, result, signal) {
      node.status({ fill: 'blue', shape: 'ring', text: 'smstunnel.status.waiting' });
      const deadline = Date.now() + WAIT_MS;
      for (let step = 0; Date.now() < deadline; step += 1) {
        const pause = WAIT_STEPS_MS[Math.min(step, WAIT_STEPS_MS.length - 1)];
        await sleep(Math.min(pause, Math.max(0, deadline - Date.now())), signal);
        let status;
        try {
          status = (await client.getMessageStatus(result.messageId, signal)).data || {};
        } catch (error) {
          if (signal.aborted) throw error;
          if (error instanceof SmsTunnelError && error.status === 403) {
            node.warn(t('error.noStatus'));
            return;
          }
          if (error instanceof SmsTunnelError && (error.status === 429 || !error.status)) continue;
          throw error;
        }
        result.status = status.deliveryStatus || status.status || result.status;
        if (status.sentAt) result.sentAt = status.sentAt;
        if (status.deliveredAt) result.deliveredAt = status.deliveredAt;
        if (status.errorMessage) result.errorMessage = status.errorMessage;
        if (result.status !== 'pending') return;
      }
    }
  }

  function resultOf(answer, to, words) {
    const data = (answer && answer.data) || {};
    const queued = Boolean(answer.queued ?? data.queued);
    const result = {
      messageId: answer.messageId || data.messageId,
      to,
      status: queued ? 'queued' : 'pending',
      queued,
      branded: Boolean(data.branded),
    };
    if (words !== undefined) result.message = words;
    if (data.remaining) result.remaining = data.remaining;
    return result;
  }

  function errorDetails(error) {
    if (!(error instanceof SmsTunnelError)) return { message: String(error.message || error) };
    const details = { status: error.status, message: error.message };
    if (error.code) details.code = error.code;
    if (error.permission) details.permission = error.permission;
    if (error.retryAfter !== undefined) details.retryAfter = error.retryAfter;
    return details;
  }

  function SmsTunnelSendNode(config) {
    RED.nodes.createNode(this, config);
    setupSender(this, config, 'send');
  }
  RED.nodes.registerType('smstunnel-send', SmsTunnelSendNode);

  function SmsTunnelCodeNode(config) {
    RED.nodes.createNode(this, config);
    setupSender(this, config, 'code');
  }
  RED.nodes.registerType('smstunnel-code', SmsTunnelCodeNode);

  // ─── SMSTunnel received ───────────────────────────────────────────────────────

  function SmsTunnelReceivedNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const account = RED.nodes.getNode(config.account);
    const intervalMs = Math.max(RECEIVED_MIN_INTERVAL_S, Number(config.interval) || 60) * 1000;
    const filters = { limit: RECEIVED_PAGE_SIZE, deviceId: text(config.deviceId), phone: text(config.phone) };
    const startWithLatest = config.startWith === 'latest';
    const context = node.context();

    let seen = null; // ids already output (or there at start), oldest first
    let timer = null;
    let running = null;
    let followUp = null;
    let closed = false;
    let lastProblem = null;
    let nextDelay = intervalMs;
    const controller = new AbortController();

    if (!account) {
      node.status({ fill: 'red', shape: 'ring', text: 'smstunnel.status.noAccount' });
      return;
    }
    if (!account.client) {
      node.status({ fill: 'red', shape: 'ring', text: 'smstunnel.status.noKey' });
      node.on('input', (msg, send, done) => done(new Error(account.setupError)));
      return;
    }

    node.status({ fill: 'grey', shape: 'ring', text: 'smstunnel.status.starting' });
    context.get('state', (error, state) => {
      if (closed) return;
      const fresh = !error && state && Array.isArray(state.seen) && Date.now() - Number(state.at) < RECEIVED_RESUME_MS;
      if (fresh) seen = new Set(state.seen);
      timer = setTimeout(check, 0);
    });

    node.on('input', (msg, send, done) => {
      check().then(() => done(), done);
    });

    node.on('close', (removed, done) => {
      closed = true;
      clearTimeout(timer);
      controller.abort(new Error('The flow stopped.'));
      if (removed) context.set('state', undefined, () => done());
      else done();
    });

    /** Checks now, or right after the check that is running (a message asked while it was under way). */
    function check() {
      if (running) {
        followUp = followUp || running.then(() => {
          followUp = null;
          return check();
        });
        return followUp;
      }
      clearTimeout(timer);
      running = poll().finally(() => {
        running = null;
        if (!closed && !followUp) timer = setTimeout(check, nextDelay);
      });
      return running;
    }

    async function poll() {
      nextDelay = intervalMs;
      try {
        const starting = seen === null;
        const found = [];
        for (let page = 1; page <= (starting ? 1 : RECEIVED_MAX_PAGES); page += 1) {
          const answer = await account.client.getReceivedMessages({ ...filters, page }, controller.signal);
          const data = answer.data || {};
          const texts = Array.isArray(data.messages) ? data.messages : [];
          const known = texts.findIndex((item) => seen && seen.has(item.id));
          found.push(...(known === -1 ? texts : texts.slice(0, known)));
          if (known !== -1 || !data.hasMore) break;
        }
        if (closed) return;

        // Newest first from SMSTunnel; output and remember oldest first.
        const oldestFirst = found.reverse();
        const output = starting ? (startWithLatest ? oldestFirst.slice(-RECEIVED_START_COUNT) : []) : oldestFirst;
        seen = seen || new Set();
        for (const item of oldestFirst) seen.add(item.id);
        while (seen.size > RECEIVED_MEMORY) seen.delete(seen.values().next().value);
        context.set('state', { seen: [...seen], at: Date.now() });

        for (const item of output) node.send(messageOf(item));
        lastProblem = null;
        node.status(
          output.length > 0
            ? { fill: 'green', shape: 'dot', text: t('status.received', { count: output.length }) }
            : { fill: 'green', shape: 'ring', text: 'smstunnel.status.watching' },
        );
      } catch (error) {
        if (closed) return;
        node.status(badgeFor(error));
        const problem =
          error instanceof SmsTunnelError && error.status === 403 && error.code === 'PERMISSION_REQUIRED'
            ? t('error.inbox')
            : explain(error);
        if (problem !== lastProblem) node.warn(problem);
        lastProblem = problem;
        if (error instanceof SmsTunnelError && error.status === 429) {
          nextDelay = Math.max(intervalMs, Math.min(MAX_RETRY_AFTER_S, error.retryAfter ?? 60) * 1000);
        }
      }
    }
  }

  function messageOf(item) {
    const details = {
      id: item.id,
      sender: item.sender,
      message: item.message ?? null,
      receivedAt: item.receivedAt,
      isEncrypted: Boolean(item.isEncrypted),
    };
    for (const name of ['encryptedPayload', 'deviceId', 'deviceName', 'simSlot', 'subscriptionId']) {
      if (item[name] !== undefined && item[name] !== null) details[name] = item[name];
    }
    return { topic: item.sender, payload: item.message ?? null, from: item.sender, smstunnel: details };
  }

  RED.nodes.registerType('smstunnel-received', SmsTunnelReceivedNode);
};
