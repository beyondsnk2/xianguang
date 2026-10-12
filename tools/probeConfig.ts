import { loadConfig } from './pickConfig';

const { config, picked } = loadConfig();
const meta = config.meta as any;
console.log('FILE:', picked.file, 'set', picked.setName, 'V', picked.version);
console.log('META:', JSON.stringify({ width: meta?.width, height: meta?.height, file: meta?.file }));

// cities (gameplay cities sheet)
const cities = (config.cities as any[]) ?? [];
console.log('CITIES(sheet):', cities.length);
if (cities[0]) console.log('  sample city:', JSON.stringify(cities[0]).slice(0, 300));

// nodes: city blocks (name==='city') vs facilities
const nodes = (config.nodes as any[]) ?? [];
const cityBlocks = nodes.filter((n) => n.name === 'city');
const facNodes = nodes.filter((n) => n.name !== 'city');
console.log('NODES total:', nodes.length, '| cityBlocks:', cityBlocks.length, '| facilities:', facNodes.length);
if (cityBlocks[0]) console.log('  sample cityBlock:', JSON.stringify(cityBlocks[0]).slice(0, 300));

// distinct states
const states = (config.states as any[]) ?? [];
console.log('STATES:', states.length, states.map((s: any) => s.id ?? s.name).slice(0, 30).join(','));

// links
const links = (config.links as any[]) ?? [];
console.log('LINKS(cityLink):', links.length);
if (links[0]) console.log('  sample link:', JSON.stringify(links[0]));

// roads
const roads = (config.roads as any[]) ?? [];
console.log('ROADS:', roads.length);
if (roads[0]) console.log('  sample road:', JSON.stringify(roads[0]).slice(0, 200));

// show a few city blocks with their cells to derive centers
console.log('--- first 5 city blocks (tag,belong,cells) ---');
for (const b of cityBlocks.slice(0, 5)) {
  console.log('  tag', b.tag, 'belong', b.belong, 'cells', JSON.stringify(b.cells));
}
