const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const plugin = require('../plugin.json');

async function createZip() {
  const zip = new JSZip();
  
  const addFile = (filePath, zipPath) => {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath);
      zip.file(zipPath, content);
    }
  };

  addFile('dist/main.js', 'main.js');
  addFile('plugin.json', 'plugin.json');
  addFile('icon.png', 'icon.png');
  addFile('readme.md', 'readme.md');

  if (fs.existsSync('dist/assets')) {
    const assets = fs.readdirSync('dist/assets');
    assets.forEach(asset => {
      addFile(`dist/assets/${asset}`, `assets/${asset}`);
    });
  }

  const content = await zip.generateAsync({ type: 'nodebuffer' });
  fs.writeFileSync(`${plugin.name}.zip`, content);
  
  console.log(`Plugin packed: ${plugin.name}.zip`);
}

createZip().catch(console.error);