import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../bootstrap.js', import.meta.url), 'utf8');
for (const protocol of ['file:', 'http:', 'https:']) {
  test(`${protocol} loads the correct application entry point`, () => {
    let appended;
    const context = {
      location: { protocol },
      document: { createElement: () => ({}), body: { appendChild: script => { appended = script; } } },
    };
    vm.runInNewContext(source, context);
    assert.equal(appended.type, protocol === 'http:' ? 'module' : undefined);
    assert.match(appended.src, protocol === 'http:' ? /app\.js\?v=1\.1\.27$/ : /app\.bundle\.js\?v=1\.1\.27$/);
  });
}
