const fs = require('fs');
const path = require('path');

const SRC_DIR = '/tmp/claude-1000/-home-phantom-orchestrator/f163742c-699d-498d-92c5-d8fd15cdc698/scratchpad/sectest-data';
const DEST_DIR = path.join(__dirname, 'data');
const BACKUP_PATH = '/home/phantom-orchestrator/tv-time-export-SAFE/showtrack-backup.json';

// Helper to recursively copy directories
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// 1. Copy everything from SRC_DIR to DEST_DIR
console.log(`Copying files from ${SRC_DIR} to ${DEST_DIR}...`);
if (fs.existsSync(SRC_DIR)) {
  copyDir(SRC_DIR, DEST_DIR);
  console.log('Copy complete.');
} else {
  console.log(`Source directory ${SRC_DIR} does not exist. Initializing empty DEST_DIR.`);
  fs.mkdirSync(DEST_DIR, { recursive: true });
}

// 2. Read backup file
console.log(`Reading backup file from ${BACKUP_PATH}...`);
const backup = JSON.parse(fs.readFileSync(BACKUP_PATH, 'utf8'));
console.log('Backup read successfully.');

const STORES = ['shows', 'episodes', 'watched', 'movies', 'watchlist', 'lists', 'kv'];
const KEY_FIELD = { shows: 'id', episodes: 'id', watched: 'epId', movies: 'id', watchlist: 'id', lists: 'id', kv: 'k' };

const finalDir = path.join(DEST_DIR, 'u_final');
fs.mkdirSync(finalDir, { recursive: true });

// Read existing meta
const metaPath = path.join(finalDir, 'meta.json');
let meta = { seq: 0, tombstones: {}, lastCheck: {} };
if (fs.existsSync(metaPath)) {
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch (e) {
    console.error('Error reading existing meta.json:', e);
  }
}
meta.tombstones = meta.tombstones || {};
for (const s of STORES) {
  meta.tombstones[s] = meta.tombstones[s] || {};
}

let seq = meta.seq || 0;

for (const store of STORES) {
  const kf = KEY_FIELD[store];
  const filePath = path.join(finalDir, `${store}.json`);
  let records = {};
  if (fs.existsSync(filePath)) {
    try {
      records = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      console.error(`Error reading existing ${store}.json:`, e);
    }
  }

  const backupArray = backup[store] || [];
  console.log(`Merging ${backupArray.length} items into ${store}...`);
  for (const item of backupArray) {
    const id = item[kf];
    if (id == null) continue;
    
    // Check if we already have it
    if (records[id]) {
      // Merge properties, keeping existing _t and _seq
      records[id] = { ...item, ...records[id] };
    } else {
      // New item
      // Determine timestamp: convert date fields if available
      let t = Date.now();
      if (item.followedAt) t = new Date(item.followedAt).getTime();
      else if (item.watchedAt) t = new Date(item.watchedAt).getTime();
      else if (item.addedAt) t = new Date(item.addedAt).getTime();
      else if (item.createdAt) t = new Date(item.createdAt).getTime();
      if (isNaN(t)) t = Date.now();

      records[id] = {
        ...item,
        _t: t,
        _seq: ++seq
      };
    }
  }

  // Save back
  fs.writeFileSync(filePath, JSON.stringify(records));
  console.log(`Saved ${Object.keys(records).length} total records to ${store}.json`);
}

// Write updated meta.json
meta.seq = seq;
fs.writeFileSync(metaPath, JSON.stringify(meta));
console.log(`Updated meta.json with seq=${seq}`);
console.log('Import successful.');
