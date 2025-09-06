const path = require('path');
const fs = require('fs');
const JSZip = require('jszip');

const rootDir = path.join(__dirname, '..');
const distFolder = path.join(rootDir, 'dist');
const zip = new JSZip();

function safeAddFile(zipObj, name, filePath) {
  if (fs.existsSync(filePath)) {
    zipObj.file(name, fs.readFileSync(filePath));
    console.log(`Added: ${name}`);
  } else {
    console.warn(`Missing: ${filePath}`);
  }
}

// tambahin file wajib di root zip
safeAddFile(zip, 'icon.png', path.join(rootDir, 'icon.png'));
safeAddFile(zip, 'plugin.json', path.join(rootDir, 'plugin.json'));

// readme case-insensitive
let readmePath = path.join(rootDir, 'readme.md');
if (!fs.existsSync(readmePath)) {
  readmePath = path.join(rootDir, 'README.md');
}
safeAddFile(zip, 'readme.md', readmePath);

// ambil main.js dari dist langsung di root zip
safeAddFile(zip, 'main.js', path.join(distFolder, 'main.js'));

// copy folder assets (kalau ada)
const assetsFolder = path.join(distFolder, 'assets');
if (fs.existsSync(assetsFolder)) {
  function addFolder(zipObj, folderPath, relativePath = '') {
    const entries = fs.readdirSync(folderPath);
    entries.forEach((file) => {
      const fullPath = path.join(folderPath, file);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        const subFolder = zipObj.folder(path.join(relativePath, file));
        addFolder(subFolder, fullPath, path.join(relativePath, file));
      } else {
        zipObj.file(path.join(relativePath, file), fs.readFileSync(fullPath));
      }
    });
  }
  addFolder(zip.folder('assets'), assetsFolder, '');
}

// generate fresh zip
const outPath = path.join(rootDir, 'AI.zip');
if (fs.existsSync(outPath)) {
  fs.unlinkSync(outPath);
}

zip
  .generateNodeStream({ type: 'nodebuffer', streamFiles: true })
  .pipe(fs.createWriteStream(outPath))
  .on('finish', () => {
    console.log('✅ AI.zip created cleanly');
  });
