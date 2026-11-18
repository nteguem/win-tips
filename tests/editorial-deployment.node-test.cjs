'use strict';
// Real isolated Git checkouts; no application bootstrap, network or database.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const repository = path.resolve(__dirname, '..');
const guard = 'tools/wintips-editorial-worker/verify-deployment.cjs';
const pins = [
  'tools/wintips-editorial-worker/validate-api-payload.cjs',
  'src/api/services/common/editorialValidation.js',
  'src/api/services/common/editorialNumericFacts.js',
  'src/api/services/common/editorialSources.js',
  'src/api/services/common/editorialCalendar.js',
  'src/api/services/common/petitJournalClockProof.js',
  'src/api/services/common/editorialCopy.js',
  'src/api/services/common/couponTeaser.js',
  'src/api/services/common/dailyVipValidation.js',
];

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wintips-deployment-test-'));
  const root = fs.realpathSync(temporary);
  t.after(() => {
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('wintips-deployment-test-'));
    assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const emptyHooks = path.join(root, 'empty-hooks');
  fs.mkdirSync(emptyHooks);
  const emptyGlobalConfig = path.join(root, 'empty-global.gitconfig');
  fs.writeFileSync(emptyGlobalConfig, '');
  const environment = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyGlobalConfig,
    GIT_TERMINAL_PROMPT: '0',
  };
  delete environment.NODE_PATH;
  // Ignore inherited Git overrides from the caller: all mutations stay here.
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG']) delete environment[key];
  for (const key of Object.keys(environment)) {
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) delete environment[key];
  }
  function git(...args) {
    return cp.execFileSync('git', ['-c', `core.hooksPath=${emptyHooks}`, ...args], {
      cwd: root, env: environment, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
    }).trim();
  }
  git('init', '--template=' + emptyHooks);
  git('config', '--local', 'core.autocrlf', 'false');
  git('config', '--local', 'user.name', 'WinTips deployment test');
  git('config', '--local', 'user.email', 'deployment-test@example.invalid');
  git('config', '--local', 'commit.gpgsign', 'false');
  for (const relative of [guard, ...pins]) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(repository, relative), target);
  }
  fs.writeFileSync(path.join(root, 'unrelated.txt'), 'unrelated original\n');
  git('add', '--', guard, ...pins, 'unrelated.txt');
  git('commit', '--no-verify', '-m', 'Isolated reviewed deployment fixture');
  const head = git('rev-parse', 'HEAD');
  function run(...args) {
    const result = cp.spawnSync(process.execPath, [path.join(root, guard), ...args], {
      cwd: root, env: environment, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.stderr, '', 'guard must not expose child stderr or exceptions');
    return { ...result, report: JSON.parse(result.stdout) };
  }
  return { root, git, head, run };
}

test('a clean committed checkout verifies all nine import pins without npm dependencies', t => {
  const { head, run } = fixture(t);
  for (const args of [[], ['--expected-commit', head]]) {
    const { status, report } = run(...args);
    assert.equal(status, 0);
    assert.equal(report.passed, true);
    assert.equal(report.code, 'deployment_verified');
    assert.equal(report.checkout.head, head);
    assert.deepEqual(Object.keys(report.checkout.sourceSha256).sort(), [...pins].sort());
    for (const hash of Object.values(report.checkout.sourceSha256)) assert.match(hash, /^[a-f0-9]{64}$/);
  }
});

test('any uncommitted change in a pinned file blocks deployment without printing its contents', t => {
  const { root, head, run } = fixture(t);
  for (const relative of pins) {
    const target = path.join(root, relative), original = fs.readFileSync(target);
    fs.appendFileSync(target, '\n// PRIVATE_FIXTURE_MARKER_MUST_NOT_LEAK\n');
    try {
      const { status, report, stdout } = run('--expected-commit', head);
      assert.equal(status, 1, relative);
      assert.equal(report.passed, false, relative);
      assert.equal(report.code, 'api_validator_checkout_unavailable', relative);
      assert.equal(stdout.includes('PRIVATE_FIXTURE_MARKER'), false);
    } finally {
      fs.writeFileSync(target, original);
    }
  }
  assert.equal(run('--expected-commit', head).status, 0);
});

test('a reviewed source commit restores attestation and still rejects an outdated expected commit', t => {
  const { root, git, head, run } = fixture(t);
  const relative = 'src/api/services/common/editorialSources.js';
  fs.appendFileSync(path.join(root, relative), '\n// Reviewed fixture-only change.\n');
  assert.equal(run('--expected-commit', head).status, 1);
  git('add', '--', relative);
  git('commit', '--no-verify', '-m', 'Reviewed fixture source update');
  const next = git('rev-parse', 'HEAD');
  assert.notEqual(next, head);
  const outdated = run('--expected-commit', head);
  assert.equal(outdated.status, 1);
  assert.equal(outdated.report.code, 'deployed_commit_mismatch');
  assert.equal(outdated.report.deployedCommit, next);
  assert.equal(run('--expected-commit', next).status, 0);
});

test('unrelated tracked changes and untracked files do not weaken or block the exact-pin check', t => {
  const { root, git, head, run } = fixture(t);
  fs.writeFileSync(path.join(root, 'unrelated.txt'), 'PRIVATE_UNRELATED_MARKER\n');
  fs.writeFileSync(path.join(root, 'private-runtime.txt'), 'PRIVATE_RUNTIME_MARKER\n');
  assert.notEqual(git('status', '--porcelain'), '');
  const { status, stdout, report } = run('--expected-commit', head);
  assert.equal(status, 0);
  assert.equal(report.checkout.head, head);
  assert.equal(stdout.includes('PRIVATE_UNRELATED_MARKER'), false);
  assert.equal(stdout.includes('PRIVATE_RUNTIME_MARKER'), false);
  assert.equal(fs.readFileSync(path.join(root, 'private-runtime.txt'), 'utf8'), 'PRIVATE_RUNTIME_MARKER\n');
});

test('wrong commits and invalid command arguments fail without echoing untrusted values', t => {
  const { head, run } = fixture(t);
  const wrong = head === 'a'.repeat(40) ? 'b'.repeat(40) : 'a'.repeat(40);
  assert.equal(run('--expected-commit', wrong).report.code, 'deployed_commit_mismatch');
  for (const args of [
    ['--expected-commit'], ['--unknown', 'PRIVATE_ARGUMENT_MARKER'],
    ['--expected-commit', head, '--expected-commit', head],
    ['--expected-commit', 'PRIVATE_ARGUMENT_MARKER'],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 1);
    assert.equal(result.report.passed, false);
    assert.equal(result.stdout.includes('PRIVATE_ARGUMENT_MARKER'), false);
    assert.ok(['invalid_deployment_arguments', 'expected_commit_invalid'].includes(result.report.code));
  }
});
