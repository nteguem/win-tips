# API and editorial deployment

Implement and test source changes locally. Commit only the intended files and
preserve unrelated work. Push the reviewed release to `main`, then update the
production checkout with `git pull --ff-only origin main`.

The production API and worker source checkout is `/var/www/wintips/api`. Do not
copy API or worker source files into that checkout without their reviewed Git
commit. The editorial preflight intentionally attests validation files against
`HEAD`; copied changes can otherwise block publication even when unit tests pass.
Do not disable or weaken that attestation to make an import succeed.

Before reloading the API, and before declaring any API deployment successful,
run from the production checkout:

    node tools/wintips-editorial-worker/verify-deployment.cjs --expected-commit <reviewed-full-commit-sha>

Require a successful result and the expected commit. Reload only the WinTips
PM2 process, then verify the API response and the relevant worker outcome. A
pure preflight check is safe; importing or resending existing editions or push
notifications merely to test a deployment is not.

Keep environment files, credentials, runtime state, edition payloads, uploads,
dependency caches and operational backups outside commits. Never use a blanket
`git add` or reset to reconcile an existing production checkout.
