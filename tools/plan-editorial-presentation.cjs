#!/usr/bin/env node
// OFFLINE only: input snapshots -> reviewable compare-and-swap operations.
// This intentionally has no Mongo client, credentials or --apply mode.
const fs = require('node:fs');
const { planPresentationBackfill } = require('../src/api/services/common/editorialPresentationBackfill');
const [rowsPath, factsPath, outputPath] = process.argv.slice(2);
if (!rowsPath || !factsPath || !outputPath || process.argv.length !== 5) {
  console.error('Usage: node tools/plan-editorial-presentation.cjs rows.json facts.json plan.json');
  process.exit(2);
}
const rows = JSON.parse(fs.readFileSync(rowsPath, 'utf8'));
const facts = JSON.parse(fs.readFileSync(factsPath, 'utf8'));
const operations = planPresentationBackfill(rows, facts);
fs.writeFileSync(outputPath, JSON.stringify(operations, null, 2) + '\n');
console.log(JSON.stringify({ planned: operations.length, applied: 0,
  fields: [...new Set(operations.flatMap(operation => operation.changed))] }));
