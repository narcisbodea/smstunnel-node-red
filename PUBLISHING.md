# Publishing `@narcisbodea/smstunnel-node-red`

## The name

Since 31 January 2022, Node-RED asks new modules to use a **scoped** npm name (`@scope/...`); the Flow Library's
scorecard flags new unscoped `node-red-contrib-*` names. So the package is `@narcisbodea/smstunnel-node-red`:
the `@narcisbodea` scope already holds `@narcisbodea/smstunnel-sdk`, and the name puts SMSTunnel first. The node
types are `smstunnel-account`, `smstunnel-send`, `smstunnel-code` and `smstunnel-received`.

Both `@narcisbodea/smstunnel-node-red` and `node-red-contrib-smstunnel` were free on npm on 1 November 2026.

## 1. GitHub

Create the public repository `narcisbodea/smstunnel-node-red` (the `repository`, `homepage` and `bugs` fields in
`package.json` point there) and push this folder to `main`. The Flow Library shows the README from npm and links to it.

## 2. npm

Check what goes into the package (`nodes/`, `examples/`, `README.md`, `CHANGELOG.md`, `LICENSE`, `package.json`):

```bash
npm pack --dry-run
```

Publish from this folder (the account `narcisbodea` confirms with Windows Hello; `publishConfig.access` is already
`public`, which a scoped package needs on its first publish):

```bash
npm publish
```

Check it: <https://www.npmjs.com/package/@narcisbodea/smstunnel-node-red>.

## 3. The Node-RED Flow Library

The library does not pick up new modules by itself (it stopped indexing npm automatically in April 2020).

1. Open <https://flows.nodered.org> and **Sign in with GitHub** (top right).
2. Click **+** at the top, choose **Node** (or open <https://flows.nodered.org/add/node> directly).
3. Enter `@narcisbodea/smstunnel-node-red` and submit.
4. When it is listed, open its page and look at the **scorecard**; the checks this module was built for: the scoped
   name, `node-red` in `keywords`, `node-red.version` (`>=3.1.0`), `engines.node`, a `LICENSE`, a `repository`,
   the `examples` folder, no clashing node types.

After that, the module shows up in **Manage palette → Install** in every Node-RED (its catalogue refreshes
periodically, so allow some time).

## Later versions

1. Raise `version` in `package.json`, add the entry to `CHANGELOG.md`, commit.
2. `npm publish`.
3. On the module's page in the Flow Library, while signed in, click **request refresh** (or submit the name again on
   the add page).
