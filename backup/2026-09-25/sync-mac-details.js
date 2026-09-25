/**
 * sync-mac-details.js
 *
 * The same MAC can sit on several accounts (installer + committee for the same
 * building). Each account stores its OWN copy of the details, so a MAC assigned
 * to a second account starts blank.
 *
 * This fills ONLY empty fields, using the richest copy of that MAC found on any
 * other account. It never overwrites a field that already has content, and it
 * never deletes anything.
 *
 * Usage:
 *   node sync-mac-details.js                  # dry run - shows what it would do
 *   node sync-mac-details.js --apply          # write the changes
 *   node sync-mac-details.js --apply 0522096617   # limit to one account
 */

require('dotenv').config();
const { connectDB } = require('./db');

const FIELDS = [
  'address', 'city', 'notes', 'purchaseDate', 'startDate',
  'technicianName', 'technicianPhone', 'supplierName',
  'committeeName', 'committeePhone', 'description',
  'annualFee', 'licensesPurchased', 'panelType', 'voipbellAccount',
];

const isEmpty = v => v === undefined || v === null || String(v).trim() === '';

// How "rich" a MAC entry is - used to pick the best source copy
const score = m => FIELDS.filter(f => !isEmpty(m[f])).length;

async function main() {
  const apply = process.argv.includes('--apply');
  const onlyPhone = process.argv.slice(2).find(a => !a.startsWith('--')) || null;

  const database = await connectDB();
  const col = database.collection('installers');
  const adminUser = process.env.ADMIN_USER || 'admin';

  const all = await col.find({ phoneNumber: { $ne: adminUser } }).toArray();

  // Build the best-known copy of every MAC across all accounts
  const best = new Map(); // mac -> { entry, phoneNumber }
  for (const inst of all) {
    for (const m of (inst.macAddresses || [])) {
      if (!m.mac) continue;
      const cur = best.get(m.mac);
      if (!cur || score(m) > score(cur.entry)) {
        best.set(m.mac, { entry: m, phoneNumber: inst.phoneNumber });
      }
    }
  }

  let accountsChanged = 0;
  let macsChanged = 0;
  let fieldsFilled = 0;

  for (const inst of all) {
    if (onlyPhone && inst.phoneNumber !== onlyPhone) continue;

    const macs = inst.macAddresses || [];
    let changed = false;

    for (const m of macs) {
      const src = best.get(m.mac);
      if (!src || src.phoneNumber === inst.phoneNumber) continue;

      const filled = [];
      for (const f of FIELDS) {
        if (isEmpty(m[f]) && !isEmpty(src.entry[f])) {
          m[f] = src.entry[f];
          filled.push(f);
          fieldsFilled++;
        }
      }

      if (filled.length) {
        macsChanged++;
        changed = true;
        console.log(`  ${inst.phoneNumber} / ${m.mac}  <- ${src.phoneNumber}`);
        console.log(`      ${filled.join(', ')}`);
      }
    }

    if (changed) {
      accountsChanged++;
      if (apply) {
        await col.updateOne({ phoneNumber: inst.phoneNumber }, { $set: { macAddresses: macs } });
      }
    }
  }

  console.log('');
  console.log('--------------------------------------------');
  console.log(`Accounts updated : ${accountsChanged}`);
  console.log(`MAC entries      : ${macsChanged}`);
  console.log(`Fields filled    : ${fieldsFilled}`);
  console.log(apply ? 'CHANGES WRITTEN' : 'DRY RUN - nothing written. Re-run with --apply');
  process.exit(0);
}

main().catch(err => {
  console.error('Sync failed:', err.message);
  process.exit(1);
});
