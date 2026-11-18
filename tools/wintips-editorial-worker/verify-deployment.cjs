'use strict';
// Read-only deployment gate. No payload, API/bootstrap, credentials or provider.
const VERSION = 'wintips-editorial-deployment-v1';

function rejected(code, extra = {}) {
  return { version: VERSION, passed: false, code, ...extra };
}

function verifyDeployment(expectedCommit) {
  if (expectedCommit !== undefined &&
      (typeof expectedCommit !== 'string' || !/^[a-f0-9]{40}$/.test(expectedCommit))) {
    return rejected('expected_commit_invalid');
  }
  let proof;
  try {
    // Keep the import preflight's existing strict, byte-for-byte Git attestation.
    // It verifies all nine pinned files and rechecks HEAD after reading them.
    proof = require('./validate-api-payload.cjs').checkout();
  } catch (_) {
    // Never print Git stderr, process environment, exception prose or file data.
    return rejected('api_validator_checkout_unavailable');
  }
  if (expectedCommit !== undefined && proof.head !== expectedCommit) {
    return rejected('deployed_commit_mismatch', {
      expectedCommit,
      deployedCommit: proof.head,
    });
  }
  return {
    version: VERSION,
    passed: true,
    code: 'deployment_verified',
    ...(expectedCommit === undefined ? {} : { expectedCommit }),
    checkout: proof,
  };
}

function main(argv = process.argv.slice(2)) {
  let report;
  if (argv.length === 0) {
    report = verifyDeployment();
  } else if (argv.length === 2 && argv[0] === '--expected-commit') {
    report = verifyDeployment(argv[1]);
  } else {
    report = rejected('invalid_deployment_arguments');
  }
  process.stdout.write(JSON.stringify(report) + '\n');
  return report.passed ? 0 : 1;
}

if (require.main === module) process.exitCode = main();
module.exports = { verifyDeployment, main, VERSION };
