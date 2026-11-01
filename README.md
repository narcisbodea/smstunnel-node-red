# SMSTunnel for Node-RED

`@narcisbodea/smstunnel-node-red`: [Node-RED](https://nodered.org) nodes for **[SMSTunnel](https://smstunnel.io)**. Send texts and sign-in codes from your own flows through **your own Android phone**, from **your own number**, and get the texts your phone receives.

Your flow hands the text to your SMSTunnel account and your phone sends it from its own SIM, so recipients see a number they know and can reply to. The phone is linked to your account when you sign in to the SMSTunnel app (or scan the QR code from your dashboard), and you can cut Node-RED off at any time by deleting its API key in your dashboard.

Your phone needs the SMSTunnel app from Google Play:

<a href="https://play.google.com/store/apps/details?id=io.smstunnel.app"><img src="https://smstunnel.io/google-play-badge.png" alt="Get it on Google Play" height="56"></a>

SMSTunnel for Node-RED is made by NARBOWEB SRL. It is not affiliated with, endorsed by, or sponsored by the OpenJS Foundation or the Node-RED project.

## Install

In the Node-RED editor: **Menu → Manage palette → Install**, search for `smstunnel`, and install `@narcisbodea/smstunnel-node-red`.

Or from the command line, in your Node-RED user directory (usually `~/.node-red`), then restart Node-RED:

```bash
npm install @narcisbodea/smstunnel-node-red
```

Requirements: Node-RED 3.1 or newer, Node.js 18.17 or newer. No other dependencies.

## Get an API key

1. Install the [SMSTunnel app from Google Play](https://play.google.com/store/apps/details?id=io.smstunnel.app) on your Android phone and sign in. Sign in at [smstunnel.io](https://smstunnel.io) on your computer with the same account: the phone appears under **Phones** (you can also link it with the QR code from **Phones → Add phone**).
2. In your [SMSTunnel dashboard](https://dashboard.smstunnel.io/apps), open **Apps** → **Add an app** and create its key. The key can send texts and look up whether they went out.
3. **SMSTunnel received** only works with a key you have explicitly allowed to read received texts (**Can also read received texts** when you create it, or **Allow reading received texts** later). Syncing received texts is off by default in the app; when you turn it on, only texts that arrive from then on are synced, and the phone's existing messages are never read.

In Node-RED, add an SMSTunnel node, and next to **Account** click the pencil to create the **SMSTunnel account**: paste the key there. Node-RED keeps it with its other credentials, encrypted, and never puts it in the flow's JSON.

| Account field | |
| --- | --- |
| **API key** | The key from **Apps**. |
| **Phone ID** | Optional: the phone to send from, when the account has several (under **Phones**, with a Copy button). Empty: SMSTunnel picks one of yours. |
| **Country code** | Optional, e.g. `+40`: completes numbers written without `+` or `00`. |

## The nodes

### SMSTunnel send

Sends `msg.payload` to `msg.to`, one text per number.

| Input | |
| --- | --- |
| `msg.payload` | The text, up to 1600 characters. |
| `msg.to` | The number in international format, `"+14155550123"`. Several numbers (commas or new lines between them, or an array) get one text each, at most 30 per message. A number must be text: as a JavaScript number it loses its `+`, so the node refuses it. |
| `msg.deviceId` | Optional: send through this phone. |
| `msg.defaultCountryCode` | Optional: overrides the account's country code. |

**To** and **Text** in the node can take the number and the text from elsewhere: a fixed value, flow or global context, an environment variable, or a JSONata expression.

For each text, the node outputs a message with `msg.to` set to its number and `msg.payload`:

```json
{
  "messageId": "6ae7957285431f6150ce52fc",
  "to": "+14155550123",
  "message": "Your order has shipped.",
  "status": "pending",
  "queued": false,
  "branded": false,
  "remaining": { "clean": 95, "total": "unlimited" }
}
```

`status` is `queued` when the phone is offline: the text waits on your account and goes out when the phone is back. With **Wait** ticked, the node waits up to a minute for the phone, and `status` becomes `sent`, `delivered`, `failed` or `unconfirmed` (handed to the SIM, without a confirmation), with `sentAt` and `errorMessage`.

### SMSTunnel code

Sends a sign-in or verification code to one number. The text must contain the code, 4 to 10 digits standing on their own (`Your sign-in code is 482913`, or `123-456`); SMSTunnel refuses a text without one. Up to 320 characters, and codes count against a separate quota. The output is the same as **SMSTunnel send**, without the text, so the code doesn't end up in logs.

Make the code in your flow with a secure random generator (the **Send a sign-in code** example uses `crypto.randomInt` in a function node), keep it on the server with an expiry, and compare what the person types with it there.

### SMSTunnel received

Outputs the texts your phone receives, as they arrive. It checks every 60 seconds (10 at least), and any message sent to its input makes it check right away.

| Output | |
| --- | --- |
| `msg.payload` | The words (`null` when the phone synced the text encrypted). |
| `msg.from`, `msg.topic` | The number that sent it. |
| `msg.smstunnel` | `id`, `sender`, `message`, `receivedAt`, `deviceId`, `deviceName`, `simSlot`, `isEncrypted`. |

**Phone ID** and **From** narrow it to one phone and one sender. **On start** chooses whether the last texts already on the account are output when the flow starts (default: only texts that arrive from then on). After a redeploy, it carries on where it stopped. To answer a text, set `msg.to` to `msg.from` in a **change** node and wire it to **SMSTunnel send**.

## Examples

**Menu → Import → Examples → @narcisbodea/smstunnel-node-red**:

- **Text yourself when something fails**: a Catch node, a change node that writes the text, and SMSTunnel send.
- **Send a sign-in code**: a function node makes a 6-digit code, keeps it for 10 minutes, and SMSTunnel code texts it.
- **Answer a text about opening hours**: SMSTunnel received, a switch node, and an answer from your own number.

## Errors

A text that does not go out raises an error that a **Catch** node can handle, and the node's status shows why (*invalid API key*, *not allowed for this key*, *can't reach SMSTunnel*...):

| Status | Meaning |
| --- | --- |
| 401 | The API key is wrong, was deleted, or its account is suspended. |
| 403 | The key may not do this (`code: PERMISSION_REQUIRED`, for example reading received texts without the opt-in), or the plan does not include it. |
| 429 | Too many requests: the node waits as long as SMSTunnel asks and tries once more. |
| 400 | SMSTunnel refused a field: a number it cannot read, a code text without a code. |

When one message names several numbers, each failure is reported on its own with its `msg.to` and `msg.smstunnel.error` (`status`, `code`, `message`), and the other numbers still get their text. A 401 or 403 stops the rest, since they would be refused too.

Keep **SMSTunnel send** out of the scope of a Catch node that feeds it, or one failing text would trigger another.

## Notes and limits

- **Rate limit**: SMSTunnel allows 30 sends a minute. The nodes send one text at a time for each account.
- **Length**: up to 1600 characters (10 joined SMS); codes up to 320.
- **Numbers**: use the international format (`+14155550123`). For local numbers, set the account's country code: it always takes precedence over the phone's.
- **Offline phone**: the text waits on your account (`status: "queued"`) and goes out when the phone is back online.

## Build it with an AI assistant

Paste this into Claude, ChatGPT, Cursor or Copilot, and replace the part in brackets. Never paste your real API key into a prompt.

```text
Build a Node-RED flow (JSON I can import) that sends texts with SMSTunnel. SMSTunnel sends each text from my own Android phone, from my own number: the phone runs the SMSTunnel app and is linked to my SMSTunnel account.

I installed the palette module @narcisbodea/smstunnel-node-red. Its nodes:
- smstunnel-account (config node): name, deviceId (optional phone), defaultCountryCode (e.g. "+40", completes numbers written without + or 00). The API key is a credential I paste in the editor; leave it out of the JSON.
- smstunnel-send: account, to/toType (default msg.to), message/messageType (default msg.payload), deviceId, wait (true waits up to 60 s for the phone). One text per number; several numbers in msg.to (comma separated or an array, at most 30) get one text each. Output per text: msg.payload = { messageId, to, status: "queued" | "pending" | "sent" | "delivered" | "failed", queued, ... }.
- smstunnel-code: like send, for sign-in codes only, to one number. The text must contain a code of 4 to 10 digits standing on its own (e.g. 482913 or 123-456), at most 320 characters.
- smstunnel-received: account, interval (seconds, at least 10), deviceId, phone, startWith ("new" or "latest"). Outputs msg.payload (the words), msg.from (the sender), msg.smstunnel. The key needs the "Can also read received texts" opt-in.
Behind them is the SMSTunnel API: POST https://smstunnel.io/api/v1/sms/send with the header X-API-Key and {"to", "message", "deviceId"?, "defaultCountryCode"?}, one recipient per call, 30 send requests a minute, 1600 characters a text. Errors reach Catch nodes: 401 bad key, 403 missing permission or plan (code such as PERMISSION_REQUIRED), 429 too many requests, 5xx SMSTunnel problem. If the phone is offline, the text waits on the account (status "queued") and goes out when the phone is back.

What I want: [describe what should send a text, to whom, and when]

Rules:
- Keep the API key in the SMSTunnel account's credentials (or an environment variable), never in a function node, a flow's JSON, or anything a browser can see.
- Phone numbers are strings in international format (+14155550123), never JavaScript numbers. Validate them before sending.
- Handle errors with a Catch node scoped to the nodes it watches (not the SMSTunnel send node it feeds), and don't retry 401/403.
- Only send texts people expect (alerts to myself, reminders, sign-in codes, order updates).
```

## Responsible use

Send only texts that people expect from you: alerts to yourself, appointment reminders, sign-in codes, order updates. Unsolicited messages from a personal SIM break most carriers' terms of service. Please make sure your usage complies with your carrier's terms and with local regulations (in the EU, that includes GDPR and ePrivacy rules on electronic communications).

## Development

```bash
npm install
npm test                 # unit tests: node-red-node-test-helper against a fake SMSTunnel API
```

The end-to-end tests run only against a test server, never production. They read `{ "serverUrl", "apiKey", "deviceId" }` from a JSON file and, with `SMSTUNNEL_E2E_MONGO_URL`, check each text in the server's database (the `mongodb` driver is resolved from `SMSTUNNEL_E2E_MONGODB_FROM`):

```bash
export SMSTUNNEL_E2E_KEY_FILE=/path/to/test-key.json
npm run test:e2e         # the nodes in the test helper, against the test server
npm run test:runtime     # npm pack, install in a fresh Node-RED, deploy flows through the Admin API, press their buttons
```

`NODE_RED_HOME=/path/with/another/node-red` runs `npm test` and `npm run test:runtime` against another Node-RED version.

## License

MIT, © NARBOWEB SRL. See [LICENSE](LICENSE).
