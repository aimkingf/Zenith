const fs = require('fs');
const path = require('path');

// Defensive Linux container check:
// If an archive was extracted with Windows-style backslashes in filenames (e.g. "src\index.js"),
// automatically convert them into proper directory hierarchies.
try {
  const properSrcIndex = path.join(__dirname, 'src', 'index.js');
  if (!fs.existsSync(properSrcIndex)) {
    const rootFiles = fs.readdirSync(__dirname);
    for (const file of rootFiles) {
      if (file.includes('\\')) {
        const normalizedRel = file.replace(/\\+/g, '/');
        const targetFullPath = path.join(__dirname, normalizedRel);
        const targetDir = path.dirname(targetFullPath);
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }
        fs.renameSync(path.join(__dirname, file), targetFullPath);
        console.log(`[Zenith] Normalized file path: "${file}" -> "${normalizedRel}"`);
      }
    }
  }
} catch (err) {
  console.warn('[Zenith] Path normalization notice:', err.message);
}

require('./src/index.js');
