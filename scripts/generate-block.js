#!/usr/bin/env node

/**
 * CLI Tool for Devoxel Engine
 * Generates a new Block definition boilerplate and appends it to data/blocks.js
 * Usage: node generate-block.js --name="Glass" --id=4 --color="[1,1,1]"
 */

const args = process.argv.slice(2);
const options = {};
args.forEach((arg) => {
  if (arg.startsWith('--')) {
    const [key, value] = arg.substring(2).split('=');
    options[key] = value;
  }
});

if (!options.name || !options.id || !options.color) {
  console.error('Usage: node generate-block.js --name="BlockName" --id=ID --color="[R,G,B]"');
  process.exit(1);
}

const blockNameUpper = options.name.toUpperCase().replace(/\s+/g, '_');
const colorArray = JSON.parse(options.color);

const blockDef = `
  ${blockNameUpper}: { 
    id: ${options.id}, 
    name: "${options.name}", 
    color: { top: [${colorArray}], side: [${colorArray}] } 
  },`;

console.log(`\n[SUCCESS] Generated Block Definition for ${options.name}!`);
console.log(`\nAdd the following to src/data/blocks.js inside the 'Blocks' object:\n`);
console.log(blockDef);
console.log(`\nAnd don't forget to add to BLOCK_IDS reverse lookup!\n`);
