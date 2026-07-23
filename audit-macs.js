/**
 * audit-macs.js
 *
 * Read-only. Scans every account and reports which MAC entries look like they
 * lost data — specifically MACs that have real content in other fields but an
 * empty `description`, which is the signature of the old destructive save.
 *
 * Writes nothing. Safe to run against production at any time.
 *
 * Usage:
 *   node audit-macs.js
 *   node audit-macs.js --csv > missing-descriptions.csv
 */

require('dotenv').config();
const { connectDB } = require('./db');

const isEmpty = v => v === undefined || v === null || String(v).trim() === '';

// Fields that indicate "this MAC entry was really in use"
const CONTENT_FIELDS = [
  'address', 'city', 'notes', 'purchaseDate', 'startDate',
  'technicianName', 'technicianPhone', 'supplierName',
  'committeeName', 'committeePhone', 'annualFee', 'licensesPurchased',
];

async function main() {
  const asCsv = process.argv.includes('--csv');
  const database = await connectDB();
  const adminUser = process.env.ADMIN_USER || 'admin';

  const installers = await database.collection('installers')
    .find({ phoneNumber: { $ne: adminUser } })
    .sort({ createdAt: 1 })
    .toArray();

  const suspects = [];
  let totalMacs = 0;
  let withDescription = 0;

  for (const inst of installers) {
    for (const m of (inst.macAddresses || [])) {
      totalMacs++;
      if (!isEmpty(m.description)) { withDescription++; continue; }

      const filled = CONTENT_FIELDS.filter(f => !isEmpty(m[f]));
      if (filled.length >= 2) {
        suspects.push({
          phoneNumber: inst.phoneNumber,
          name: inst.installerName || '',
          accountType: inst.accountType || 'installer',
          mac: m.mac,
          address: m.address || '',
          city: m.city || '',
        });
      }
    }
  }

  if (asCsv) {
    console.log('\uFEFFphone,name,accountType,mac,address,city');
    const esc = v => '"' + String(v || '').replace(/"/g, '""') + '"';
    for (const s of suspects) {
      console.log([s.phoneNumber, s.name, s.accountType, s.mac, s.address, s.city].map(esc).join(','));
    }
    process.exit(0);
  }

  console.log('');
  console.log('MACs in use but missing a description:');
  console.log('--------------------------------------------');
  if (!suspects.length) {
    console.log('  none - every active MAC has a description');
  } else {
    let lastPhone = null;
    for (const s of suspects) {
      if (s.phoneNumber !== lastPhone) {
        console.log('');
        console.log(`  ${s.name || '(no name)'}  [${s.phoneNumber}]  ${s.accountType}`);
        lastPhone = s.phoneNumber;
      }
      const where = [s.address, s.city].filter(Boolean).join(', ');
      console.log(`     ${s.mac}${where ? '  - ' + where : ''}`);
    }
  }

  console.log('');
  console.log('--------------------------------------------');
  console.log(`Accounts scanned        : ${installers.length}`);
  console.log(`MAC entries total       : ${totalMacs}`);
  console.log(`With a description      : ${withDescription}`);
  console.log(`Missing (in active use) : ${suspects.length}`);
  console.log('');
  console.log('Tip: node audit-macs.js --csv > missing-descriptions.csv');
  process.exit(0);
}

main().catch(err => {
  console.error('Audit failed:', err.message);
  process.exit(1);
});
