const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const platform = process.platform === 'win32' ? 'win64-bin' : process.platform === 'darwin' ? 'osx-bin' : 'linux64-bin';
const fileName = process.platform === 'win32' ? 'hermesc.exe' : 'hermesc';
const destination = path.join(root, 'node_modules', 'react-native', 'sdks', 'hermesc', platform, fileName);
const directDestination = path.join(root, 'node_modules', 'hermes-compiler', 'hermesc', platform, fileName);

function find(start, depth = 0) {
  if (depth > 5 || !fs.existsSync(start)) return null;
  for (const entry of fs.readdirSync(start, {withFileTypes: true})) {
    const full = path.join(start, entry.name);
    if (entry.isFile() && entry.name === fileName && full.includes(`hermesc${path.sep}${platform}`)) return full;
    if (entry.isDirectory()) { const found = find(full, depth + 1); if (found) return found; }
  }
  return null;
}

const source = find(path.join(root, 'node_modules', '.pnpm')) || find(path.join(root, 'node_modules'));
if (source && !fs.existsSync(destination)) {
  fs.mkdirSync(path.dirname(destination), {recursive: true});
  fs.copyFileSync(source, destination);
  console.log(`Hermes compiler restored at ${destination}`);
}
if (source && !fs.existsSync(directDestination)) {
  fs.mkdirSync(path.dirname(directDestination), {recursive: true});
  fs.copyFileSync(source, directDestination);
}
