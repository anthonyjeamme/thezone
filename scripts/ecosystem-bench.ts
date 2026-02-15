#!/usr/bin/env tsx
// =============================================================
//  ECOSYSTEM BENCHMARK — Headless simulation runner
//  Runs the flora/weather/soil simulation without any rendering
//  and produces statistics to evaluate ecosystem stability.
//
//  Usage:
//    npm run bench:eco
//    npm run bench:eco -- --days 60
//    npm run bench:eco -- --seed 42
//    npm run bench:eco -- --csv
// =============================================================

import { createSoilGrid, processSoilCycles, SOIL_PROPERTIES, type SoilGrid } from '../src/components/World/fertility';
import { createHeightMap, createBasinMap, createDepressionMap } from '../src/components/World/heightmap';
import { createWeatherState, processWeather, WEATHER_LABELS } from '../src/components/World/weather';
import { processFlora, getAllSpecies } from '../src/components/World/flora';
import { SECONDS_PER_DAY, SECONDS_PER_HOUR, type Scene, type PlantEntity, type FruitEntity, type PlantGrowthStage } from '../src/components/World/types';
import { generateEntityId } from '../src/components/Shared/ids';
import * as fs from 'fs';
import * as path from 'path';

// =============================================================
//  CLI ARGS
// =============================================================

const args = process.argv.slice(2);

function getArg(name: string, defaultVal: string): string {
    const idx = args.indexOf(`--${name}`);
    if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
    return defaultVal;
}

function hasFlag(name: string): boolean {
    return args.includes(`--${name}`);
}

const SIM_DAYS = parseInt(getArg('days', '30'), 10);
const SEED = parseInt(getArg('seed', String(Math.floor(Math.random() * 100000))), 10);
const CSV_MODE = hasFlag('csv');

// =============================================================
//  WORLD INIT (mirrors Game.tsx createInitialScene)
// =============================================================

const WORLD_HALF = 1200;
const CELL_SIZE = 32;

console.log(`\n=== Ecosystem Benchmark: ${SIM_DAYS} days ===`);
console.log(`Seed: ${SEED}`);

const soilGrid = createSoilGrid(-WORLD_HALF, -WORLD_HALF, WORLD_HALF * 2, WORLD_HALF * 2, CELL_SIZE, SEED);
const heightMap = createHeightMap(-WORLD_HALF, -WORLD_HALF, WORLD_HALF * 2, WORLD_HALF * 2, CELL_SIZE, 150, SEED + 35);
const basinMap = createBasinMap(heightMap);
const depressionMap = createDepressionMap(heightMap);
const weather = createWeatherState();

const entities: Scene['entities'] = [];

// --- Plant initial species (same as Game.tsx generateTestPlants) ---

type SpeciesSetup = { id: string; count: number; humRange: [number, number]; growthRange: [number, number] };

const speciesSetups: SpeciesSetup[] = [
    // Forest
    { id: 'oak',        count: 20, humRange: [0.35, 0.80], growthRange: [0.0, 1.0] },
    { id: 'pine',       count: 18, humRange: [0.20, 0.60], growthRange: [0.0, 1.0] },
    { id: 'birch',      count: 15, humRange: [0.30, 0.70], growthRange: [0.0, 1.0] },
    { id: 'mushroom',   count: 12, humRange: [0.50, 0.85], growthRange: [0.0, 0.9] },
    // Meadow
    { id: 'wheat',      count: 25, humRange: [0.35, 0.65], growthRange: [0.0, 0.9] },
    { id: 'wildflower', count: 18, humRange: [0.25, 0.70], growthRange: [0.0, 0.8] },
    { id: 'thyme',      count: 12, humRange: [0.10, 0.40], growthRange: [0.0, 0.9] },
    { id: 'sage',       count: 10, humRange: [0.15, 0.45], growthRange: [0.0, 0.9] },
    // Wetland
    { id: 'willow',     count: 8,  humRange: [0.65, 1.00], growthRange: [0.0, 1.0] },
    { id: 'reed',       count: 15, humRange: [0.75, 1.00], growthRange: [0.0, 0.8] },
    // Fruit trees
    { id: 'raspberry',  count: 15, humRange: [0.40, 0.75], growthRange: [0.0, 1.0] },
    { id: 'apple',      count: 10, humRange: [0.40, 0.70], growthRange: [0.0, 1.0] },
    { id: 'cherry',     count: 10, humRange: [0.35, 0.65], growthRange: [0.0, 1.0] },
];

const MARGIN = 100;
for (const setup of speciesSetups) {
    let placed = 0;
    let attempts = 0;
    const maxAttempts = setup.count * 10;

    while (placed < setup.count && attempts < maxAttempts) {
        attempts++;
        const x = (Math.random() * 2 - 1) * (WORLD_HALF - MARGIN);
        const y = (Math.random() * 2 - 1) * (WORLD_HALF - MARGIN);

        const col = Math.floor((x - soilGrid.originX) / soilGrid.cellSize);
        const row = Math.floor((y - soilGrid.originY) / soilGrid.cellSize);
        if (col < 0 || col >= soilGrid.cols || row < 0 || row >= soilGrid.rows) continue;
        const hum = soilGrid.layers.humidity[row * soilGrid.cols + col];
        if (hum < setup.humRange[0] || hum > setup.humRange[1]) continue;

        const [gMin, gMax] = setup.growthRange;
        const growth = gMin + Math.random() * (gMax - gMin);
        const stage: PlantGrowthStage = growth < 0.02 ? 'seed'
            : growth < 0.15 ? 'sprout'
            : growth < 0.85 ? 'growing'
            : 'mature';

        const plant: PlantEntity = {
            id: `plant-${generateEntityId()}`,
            type: 'plant',
            speciesId: setup.id,
            position: { x, y },
            growth,
            health: 100,
            age: growth * SECONDS_PER_DAY * 5,
            stage,
            seedTimer: Math.random() * SECONDS_PER_DAY * 2,
            fruitTimer: Math.random() * SECONDS_PER_DAY * 2,
            dormancyTimer: 0,
        };
        entities.push(plant);
        placed++;
    }
}

const scene: Scene = {
    entities,
    time: 8 * SECONDS_PER_HOUR,
    soilGrid,
    heightMap,
    basinMap,
    depressionMap,
    weather,
    lakesEnabled: true,
};

// =============================================================
//  STATISTICS HELPERS
// =============================================================

type Snapshot = {
    day: number;
    hour: number;
    totalPlants: number;
    totalFruits: number;
    speciesBreakdown: Map<string, { seed: number; sprout: number; growing: number; mature: number; dead: number }>;
    fruitsBySpecies: Map<string, number>;
    soilAvg: Record<string, number>;
    weather: string;
};

function takeSoilAverage(grid: SoilGrid): Record<string, number> {
    const result: Record<string, number> = {};
    const count = grid.cols * grid.rows;
    for (const prop of SOIL_PROPERTIES) {
        let sum = 0;
        const layer = grid.layers[prop];
        for (let i = 0; i < count; i++) sum += layer[i];
        result[prop] = sum / count;
    }
    return result;
}

function takeSnapshot(scene: Scene, simTime: number): Snapshot {
    const day = Math.floor(simTime / SECONDS_PER_DAY);
    const hour = Math.floor((simTime % SECONDS_PER_DAY) / SECONDS_PER_HOUR);

    const speciesBreakdown = new Map<string, { seed: number; sprout: number; growing: number; mature: number; dead: number }>();
    const fruitsBySpecies = new Map<string, number>();
    let totalPlants = 0;
    let totalFruits = 0;

    for (const entity of scene.entities) {
        if (entity.type === 'plant') {
            const p = entity as PlantEntity;
            totalPlants++;
            let entry = speciesBreakdown.get(p.speciesId);
            if (!entry) { entry = { seed: 0, sprout: 0, growing: 0, mature: 0, dead: 0 }; speciesBreakdown.set(p.speciesId, entry); }
            entry[p.stage as keyof typeof entry]++;
        } else if (entity.type === 'fruit') {
            const f = entity as FruitEntity;
            totalFruits++;
            fruitsBySpecies.set(f.speciesId, (fruitsBySpecies.get(f.speciesId) || 0) + 1);
        }
    }

    const soilAvg = scene.soilGrid ? takeSoilAverage(scene.soilGrid) : {};

    return {
        day,
        hour,
        totalPlants,
        totalFruits,
        speciesBreakdown,
        fruitsBySpecies,
        soilAvg,
        weather: scene.weather ? WEATHER_LABELS[scene.weather.current] : '?',
    };
}

// =============================================================
//  SIMULATION LOOP
// =============================================================

const DT = 1; // 1 sim-second per tick
const SNAPSHOT_INTERVAL = 6 * SECONDS_PER_HOUR; // every 6 game hours
const TOTAL_SIM_TIME = SIM_DAYS * SECONDS_PER_DAY;

const snapshots: Snapshot[] = [];
const initialSoilAvg = takeSoilAverage(soilGrid);

// Take initial snapshot
snapshots.push(takeSnapshot(scene, scene.time));

const startReal = Date.now();
let lastSnapshotTime = scene.time;
let tickCount = 0;

// Suppress flora console.log during bench (too noisy)
const origLog = console.log;
console.log = () => {};

while (scene.time < 8 * SECONDS_PER_HOUR + TOTAL_SIM_TIME) {
    processWeather(scene, DT);
    processSoilCycles(soilGrid, DT, heightMap);
    processFlora(scene, DT);
    scene.time += DT;
    tickCount++;

    // Progress indicator every day
    if (tickCount % SECONDS_PER_DAY === 0) {
        const dayNow = Math.floor((scene.time - 8 * SECONDS_PER_HOUR) / SECONDS_PER_DAY);
        const elapsed = ((Date.now() - startReal) / 1000).toFixed(1);
        const perDay = (Date.now() - startReal) / dayNow / 1000;
        const plants = scene.entities.filter(e => e.type === 'plant' && (e as PlantEntity).stage !== 'dead').length;
        const fruits = scene.entities.filter(e => e.type === 'fruit').length;
        origLog(`  jour ${String(dayNow).padStart(3)}/${SIM_DAYS} | ${elapsed}s (${perDay.toFixed(1)}s/jour) | ${plants} plantes, ${fruits} fruits`);
    }

    // Snapshot
    if (scene.time - lastSnapshotTime >= SNAPSHOT_INTERVAL) {
        lastSnapshotTime = scene.time;
        snapshots.push(takeSnapshot(scene, scene.time - 8 * SECONDS_PER_HOUR));
    }
}

// Restore console.log
console.log = origLog;

const elapsedMs = Date.now() - startReal;

// =============================================================
//  REPORT
// =============================================================

const finalSnap = snapshots[snapshots.length - 1];
const finalSoilAvg = takeSoilAverage(soilGrid);

console.log(`Ticks: ${tickCount} | Real time: ${(elapsedMs / 1000).toFixed(1)}s\n`);

// --- Population table ---
console.log(`--- Population par espece (jour ${finalSnap.day}) ---`);
const header = '  Espece'.padEnd(18) + '| Seeds | Sprout | Growing | Mature | Dead  | Fruits';
console.log(header);
console.log('  ' + '-'.repeat(header.length - 2));

const allSpecies = getAllSpecies();
for (const sp of allSpecies) {
    const b = finalSnap.speciesBreakdown.get(sp.id) || { seed: 0, sprout: 0, growing: 0, mature: 0, dead: 0 };
    const fruits = finalSnap.fruitsBySpecies.get(sp.id) || 0;
    const row = `  ${sp.displayName.padEnd(16)}| ${String(b.seed).padStart(5)} | ${String(b.sprout).padStart(6)} | ${String(b.growing).padStart(7)} | ${String(b.mature).padStart(6)} | ${String(b.dead).padStart(5)} | ${String(fruits).padStart(6)}`;
    // Only show species that have any entities
    if (b.seed + b.sprout + b.growing + b.mature + b.dead + fruits > 0) {
        console.log(row);
    }
}

const totalAlive = Array.from(finalSnap.speciesBreakdown.values()).reduce((s, b) => s + b.seed + b.sprout + b.growing + b.mature, 0);
const totalDead = Array.from(finalSnap.speciesBreakdown.values()).reduce((s, b) => s + b.dead, 0);
console.log(`\n  Total: ${totalAlive} alive, ${totalDead} dying, ${finalSnap.totalFruits} fruits\n`);

// --- Soil comparison ---
console.log('--- Sol moyen ---');
console.log('  Propriete'.padEnd(20) + '| Debut  | Fin    | Delta');
console.log('  ' + '-'.repeat(50));
for (const prop of SOIL_PROPERTIES) {
    const start = initialSoilAvg[prop];
    const end = finalSoilAvg[prop];
    const delta = end - start;
    const sign = delta >= 0 ? '+' : '';
    console.log(`  ${prop.padEnd(18)}| ${start.toFixed(4)} | ${end.toFixed(4)} | ${sign}${delta.toFixed(4)}`);
}

// --- Timeline ---
console.log('\n--- Timeline (snapshot / 6h) ---');
// Show every 4th snapshot (= every game day) to keep it readable
for (let i = 0; i < snapshots.length; i += 4) {
    const s = snapshots[i];
    const hum = s.soilAvg['humidity']?.toFixed(3) ?? '?';
    const org = s.soilAvg['organicMatter']?.toFixed(3) ?? '?';
    console.log(`  Jour ${String(s.day).padStart(3)}: ${String(s.totalPlants).padStart(5)} plantes, ${String(s.totalFruits).padStart(4)} fruits | hum=${hum} org=${org} | ${s.weather}`);
}

// --- Species evolution (start vs end) ---
console.log('\n--- Evolution par espece (debut -> fin) ---');
const initialSnap = snapshots[0];
for (const sp of allSpecies) {
    const bStart = initialSnap.speciesBreakdown.get(sp.id);
    const bEnd = finalSnap.speciesBreakdown.get(sp.id);
    const startTotal = bStart ? (bStart.seed + bStart.sprout + bStart.growing + bStart.mature) : 0;
    const endTotal = bEnd ? (bEnd.seed + bEnd.sprout + bEnd.growing + bEnd.mature) : 0;
    if (startTotal === 0 && endTotal === 0) continue;
    const delta = endTotal - startTotal;
    const sign = delta >= 0 ? '+' : '';
    const pct = startTotal > 0 ? `(${sign}${((delta / startTotal) * 100).toFixed(0)}%)` : '(new)';
    console.log(`  ${sp.displayName.padEnd(16)}: ${startTotal} -> ${endTotal}  ${pct}`);
}

// =============================================================
//  STABILIZATION ANALYSIS
// =============================================================

console.log('\n--- Analyse de stabilisation ---');
// Look at population growth rate over windows of 5 days
const dailySnapshots: { day: number; plants: number; fruits: number }[] = [];
for (let i = 0; i < snapshots.length; i += 4) { // every 4th = 1 day
    const s = snapshots[i];
    dailySnapshots.push({ day: s.day, plants: s.totalPlants, fruits: s.totalFruits });
}

const WINDOW = 5;
console.log('  Periode (jours) | Plantes debut | Plantes fin | Croissance/jour | Taux (%)');
console.log('  ' + '-'.repeat(78));
for (let i = WINDOW; i < dailySnapshots.length; i += WINDOW) {
    const start = dailySnapshots[i - WINDOW];
    const end = dailySnapshots[i];
    const days = end.day - start.day;
    if (days === 0) continue;
    const growthPerDay = (end.plants - start.plants) / days;
    const rate = start.plants > 0 ? ((end.plants - start.plants) / start.plants * 100) : 0;
    console.log(`  ${String(start.day).padStart(3)}-${String(end.day).padStart(3)}           | ${String(start.plants).padStart(13)} | ${String(end.plants).padStart(11)} | ${growthPerDay.toFixed(1).padStart(15)} | ${rate.toFixed(1).padStart(7)}`);
}

// ASCII sparkline of population
console.log('\n  Population (ASCII graph):');
const maxPop = Math.max(...dailySnapshots.map(d => d.plants), 1);
const GRAPH_WIDTH = 50;
for (const d of dailySnapshots) {
    const barLen = Math.round((d.plants / maxPop) * GRAPH_WIDTH);
    const bar = '█'.repeat(barLen) + '░'.repeat(GRAPH_WIDTH - barLen);
    console.log(`  J${String(d.day).padStart(3)} |${bar}| ${d.plants}`);
}

// =============================================================
//  BIOME ANALYSIS (spatial clustering)
// =============================================================

console.log('\n--- Analyse des biomes (regions 200x200) ---');

// Divide the world into a grid of cells and see what dominant species exist
const BIOME_CELL = 200; // biome analysis cell size
const biomeGridSize = Math.ceil((WORLD_HALF * 2) / BIOME_CELL);
type BiomeCellData = Map<string, number>; // speciesId -> count
const biomeGrid: BiomeCellData[][] = [];
for (let r = 0; r < biomeGridSize; r++) {
    biomeGrid[r] = [];
    for (let c = 0; c < biomeGridSize; c++) {
        biomeGrid[r][c] = new Map();
    }
}

// Fill biome grid
for (const entity of scene.entities) {
    if (entity.type !== 'plant') continue;
    const p = entity as PlantEntity;
    if (p.stage === 'dead') continue;
    const col = Math.floor((p.position.x + WORLD_HALF) / BIOME_CELL);
    const row = Math.floor((p.position.y + WORLD_HALF) / BIOME_CELL);
    if (col < 0 || col >= biomeGridSize || row < 0 || row >= biomeGridSize) continue;
    const cell = biomeGrid[row][col];
    cell.set(p.speciesId, (cell.get(p.speciesId) || 0) + 1);
}

// Determine dominant species per cell and classify biome type
type BiomeType = 'foret' | 'prairie' | 'marais' | 'verger' | 'vide' | 'mixte';

const forestSpecies = new Set(['oak', 'pine', 'birch', 'mushroom']);
const meadowSpecies = new Set(['wheat', 'wildflower', 'thyme', 'sage']);
const wetlandSpecies = new Set(['willow', 'reed']);
const orchardSpecies = new Set(['raspberry', 'apple', 'cherry']);

function classifyBiome(cell: BiomeCellData): { biome: BiomeType; dominant: string; count: number } {
    let total = 0;
    let dominant = '';
    let maxCount = 0;
    const groupCounts: Record<string, number> = { foret: 0, prairie: 0, marais: 0, verger: 0 };

    for (const [sp, cnt] of cell) {
        total += cnt;
        if (cnt > maxCount) { maxCount = cnt; dominant = sp; }
        if (forestSpecies.has(sp)) groupCounts['foret'] += cnt;
        else if (meadowSpecies.has(sp)) groupCounts['prairie'] += cnt;
        else if (wetlandSpecies.has(sp)) groupCounts['marais'] += cnt;
        else if (orchardSpecies.has(sp)) groupCounts['verger'] += cnt;
    }

    if (total === 0) return { biome: 'vide', dominant: '-', count: 0 };

    // Dominant group must be > 50% of total to be a biome
    let bestGroup: BiomeType = 'mixte';
    let bestGroupCount = 0;
    for (const [group, cnt] of Object.entries(groupCounts)) {
        if (cnt > bestGroupCount) { bestGroupCount = cnt; bestGroup = group as BiomeType; }
    }

    if (bestGroupCount / total < 0.5) bestGroup = 'mixte';

    return { biome: bestGroup, dominant, count: total };
}

const biomeCounts: Record<BiomeType, number> = { foret: 0, prairie: 0, marais: 0, verger: 0, vide: 0, mixte: 0 };
const biomeSymbols: Record<BiomeType, string> = { foret: 'F', prairie: 'P', marais: 'M', verger: 'V', vide: '.', mixte: '~' };

console.log('  Carte des biomes (F=foret P=prairie M=marais V=verger ~=mixte .=vide):');
console.log('');
for (let r = 0; r < biomeGridSize; r++) {
    let line = '  ';
    for (let c = 0; c < biomeGridSize; c++) {
        const { biome } = classifyBiome(biomeGrid[r][c]);
        biomeCounts[biome]++;
        line += biomeSymbols[biome];
    }
    console.log(line);
}

console.log('');
console.log('  Distribution des biomes:');
const totalCells = biomeGridSize * biomeGridSize;
for (const [biome, count] of Object.entries(biomeCounts)) {
    if (count === 0) continue;
    const pct = (count / totalCells * 100).toFixed(1);
    console.log(`    ${biome.padEnd(10)}: ${String(count).padStart(4)} cells (${pct}%)`);
}

// Show species co-occurrence (which species tend to appear together)
console.log('\n  Co-occurrence (especes souvent ensemble dans meme zone):');
const coOccurrence: Map<string, Map<string, number>> = new Map();
for (let r = 0; r < biomeGridSize; r++) {
    for (let c = 0; c < biomeGridSize; c++) {
        const cell = biomeGrid[r][c];
        const speciesInCell = [...cell.keys()];
        for (let i = 0; i < speciesInCell.length; i++) {
            for (let j = i + 1; j < speciesInCell.length; j++) {
                const [a, b] = [speciesInCell[i], speciesInCell[j]].sort();
                if (!coOccurrence.has(a)) coOccurrence.set(a, new Map());
                const map = coOccurrence.get(a)!;
                map.set(b, (map.get(b) || 0) + 1);
            }
        }
    }
}

// Show top 10 co-occurrences
const pairs: { a: string; b: string; count: number }[] = [];
for (const [a, map] of coOccurrence) {
    for (const [b, count] of map) {
        pairs.push({ a, b, count });
    }
}
pairs.sort((x, y) => y.count - x.count);
for (const p of pairs.slice(0, 12)) {
    console.log(`    ${p.a.padEnd(14)} + ${p.b.padEnd(14)} : ${p.count} zones`);
}

// =============================================================
//  CSV EXPORT (optional)
// =============================================================

if (CSV_MODE) {
    const outDir = path.join(__dirname, 'output');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    // Timeline CSV
    const timelinePath = path.join(outDir, `bench-${SEED}-timeline.csv`);
    const csvLines = ['day,hour,totalPlants,totalFruits,humidity,minerals,organicMatter,weather'];
    for (const s of snapshots) {
        csvLines.push([
            s.day, s.hour, s.totalPlants, s.totalFruits,
            (s.soilAvg['humidity'] ?? 0).toFixed(4),
            (s.soilAvg['minerals'] ?? 0).toFixed(4),
            (s.soilAvg['organicMatter'] ?? 0).toFixed(4),
            s.weather,
        ].join(','));
    }
    fs.writeFileSync(timelinePath, csvLines.join('\n'));
    console.log(`\nCSV exported: ${timelinePath}`);

    // Species CSV
    const speciesPath = path.join(outDir, `bench-${SEED}-species.csv`);
    const spCsvLines = ['day,species,seed,sprout,growing,mature,dead,fruits'];
    for (const s of snapshots) {
        for (const sp of allSpecies) {
            const b = s.speciesBreakdown.get(sp.id) || { seed: 0, sprout: 0, growing: 0, mature: 0, dead: 0 };
            const fruits = s.fruitsBySpecies.get(sp.id) || 0;
            spCsvLines.push([s.day, sp.id, b.seed, b.sprout, b.growing, b.mature, b.dead, fruits].join(','));
        }
    }
    fs.writeFileSync(speciesPath, spCsvLines.join('\n'));
    console.log(`CSV exported: ${speciesPath}`);
}

console.log('\nDone.\n');
