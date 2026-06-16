const { readFileSync } = require('fs');
const babel = require('@babel/core');
try {
  const code = readFileSync('src/App.jsx', 'utf8');
  babel.parseSync(code, { presets: [require.resolve('@babel/preset-react')], filename:'App.jsx', sourceType:'module' });
  console.log('SYNTAX OK');
} catch(e) { console.log('ERROR:', e.message); }
