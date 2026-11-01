'use strict';

require('should');
const fs = require('node:fs');
const path = require('node:path');

const NODES = path.join(__dirname, '..', 'nodes');
const read = (file) => fs.readFileSync(path.join(NODES, file), 'utf8');
const catalog = JSON.parse(read('locales/en-US/smstunnel.json'));
const editor = read('smstunnel.html');
const runtime = read('smstunnel.js');
const help = read('locales/en-US/smstunnel.html');

function lookup(key) {
  return key.split('.').reduce((value, part) => (value && typeof value === 'object' ? value[part] : undefined), catalog);
}

describe('messages and help (en-US)', function () {
  it('has every key the edit dialogs use', function () {
    const keys = [...editor.matchAll(/data-i18n="([^"]+)"/g)].flatMap((match) =>
      match[1].split(';').map((entry) => entry.replace(/^\[[^\]]+\]/, '')),
    );
    keys.length.should.be.above(20);
    keys.filter((key) => typeof lookup(key) !== 'string').should.eql([]);
  });

  it('has every key the runtime uses', function () {
    const keys = [
      ...[...runtime.matchAll(/\bt\('([a-zA-Z.]+)'/g)].map((match) => `smstunnel.${match[1]}`),
      ...[...runtime.matchAll(/'(smstunnel\.[a-zA-Z.]+)'/g)].map((match) => match[1]),
    ];
    keys.length.should.be.above(20);
    keys.filter((key) => typeof lookup(key) !== 'string').should.eql([]);
  });

  it('has a palette label and help for every node type', function () {
    const types = [...editor.matchAll(/registerType\('([a-z-]+)'/g)].map((match) => match[1]);
    types.should.eql(['smstunnel-account', 'smstunnel-send', 'smstunnel-code', 'smstunnel-received']);
    for (const type of types) {
      help.should.containEql(`data-help-name="${type}"`);
      lookup(`smstunnel.paletteLabel.${type.replace('smstunnel-', '')}`).should.be.a.String();
    }
  });
});
