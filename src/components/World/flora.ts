// =============================================================
//  FLORA — Plant species definitions and growth logic
// =============================================================

import { computePlantFertility, getSoilAt, getSoilTypeAt, setSoilPropertyAt, SOIL_PROPERTIES, type PlantSoilNeeds, type SoilGrid } from './fertility';
import { SECONDS_PER_DAY, isInWorldBounds, type FruitEntity, type PlantEntity, type PlantGrowthStage, type Scene } from './types';
import { generateEntityId } from '../Shared/ids';

// =============================================================
//  TIME HELPERS — express durations in game days
// =============================================================

/** Convert game days to sim-seconds */
const DAYS = (d: number) => d * SECONDS_PER_DAY;

// =============================================================
//  PLANT SPECIES DEFINITION
// =============================================================

export type PlantSpecies = {
    id: string;
    displayName: string;
    /** Soil requirements — determines where this plant thrives */
    soilNeeds: PlantSoilNeeds;
    /** Visual */
    color: string;           // base color for rendering
    matureColor: string;     // color when fully grown
    maxSize: number;         // max visual radius (px) when mature
    /** Growth */
    growthDays: number;      // days to reach full maturity under ideal conditions
    /**
     * Resilience: how well the plant resists poor soil conditions.
     * Higher = survives longer on bad soil before dying. [0..1]
     */
    resilience: number;
    /** Seed dispersal */
    seedSpread: {
        /** Min growth to start producing seeds (0..1). Must be mature enough. */
        minGrowth: number;
        /** How many seeds per dispersal event */
        seedCount: number;
        /** Interval between dispersal events (in game days) */
        intervalDays: number;
        /** Max distance seeds can land from parent (px) */
        radius: number;
    };
    /** Fruit production (optional — not all plants produce fruits) */
    fruitProduction?: {
        /** Display name of the fruit (e.g. "Gland", "Grain") */
        fruitName: string;
        /** Color for rendering */
        fruitColor: string;
        /** Nutrition value when consumed (0..1) */
        nutritionValue: number;
        /** Min plant growth to start producing (0..1) */
        minGrowth: number;
        /** How many fruits per production event */
        fruitsPerCycle: number;
        /** Days between fruit production events */
        intervalDays: number;
        /** Radius (px) around the plant where fruits drop */
        dropRadius: number;
        /** Days before a dropped fruit rots and disappears */
        lifetimeDays: number;
    };
};

// =============================================================
//  SPECIES REGISTRY
// =============================================================

const speciesRegistry = new Map<string, PlantSpecies>();

export function registerSpecies(species: PlantSpecies) {
    speciesRegistry.set(species.id, species);
}

export function getSpecies(id: string): PlantSpecies | undefined {
    return speciesRegistry.get(id);
}

export function getAllSpecies(): PlantSpecies[] {
    return Array.from(speciesRegistry.values());
}

// =============================================================
//  BUILT-IN SPECIES
// =============================================================

registerSpecies({
    id: 'oak',
    displayName: 'Chêne',
    soilNeeds: {
        humidity: { ideal: 0.55, tolerance: 0.35, weight: 1.0 },
        minerals: { ideal: 0.50, tolerance: 0.40, weight: 0.6 },
        organicMatter: { ideal: 0.50, tolerance: 0.45, weight: 0.4 },
        sunExposure: { ideal: 0.70, tolerance: 0.30, weight: 0.8 },
    },
    color: '#4a7a3a',
    matureColor: '#2d5a1e',
    maxSize: 18,
    growthDays: 10,        // was 2 — more realistic, still fast for a tree
    resilience: 0.8,
    seedSpread: {
        minGrowth: 0.75,
        seedCount: 4,
        intervalDays: 4,
        radius: 120,
    },
    fruitProduction: {
        fruitName: 'Gland',
        fruitColor: '#8B6914',
        nutritionValue: 0.15,  // pas très nutritif seul
        minGrowth: 0.9,        // doit être bien mature
        fruitsPerCycle: 4,
        intervalDays: 4,
        dropRadius: 60,        // tombent autour du tronc
        lifetimeDays: 8,       // pourrissent lentement
    },
});

registerSpecies({
    id: 'wheat',
    displayName: 'Blé',
    soilNeeds: {
        humidity: { ideal: 0.50, tolerance: 0.25, weight: 1.2 },
        minerals: { ideal: 0.55, tolerance: 0.30, weight: 0.8 },
        sunExposure: { ideal: 0.80, tolerance: 0.20, weight: 1.0 },
    },
    color: '#c8b84d',
    matureColor: '#d4a017',
    maxSize: 6,
    growthDays: 8,         // was 12 — faster crop cycle for gameplay
    resilience: 0.3,
    seedSpread: {
        minGrowth: 0.7,
        seedCount: 2,          // grains
        intervalDays: 4,
        radius: 40,            // tombe au pied
    },
    fruitProduction: {
        fruitName: 'Grain',
        fruitColor: '#D4A017',
        nutritionValue: 0.3,   // bon aliment de base
        minGrowth: 0.75,
        fruitsPerCycle: 6,
        intervalDays: 2,       // production rapide
        dropRadius: 15,        // tombe au pied
        lifetimeDays: 5,       // pourrit assez vite
    },
});

registerSpecies({
    id: 'wildflower',
    displayName: 'Fleur sauvage',
    soilNeeds: {
        humidity: { ideal: 0.45, tolerance: 0.40, weight: 0.8 },
        sunExposure: { ideal: 0.65, tolerance: 0.35, weight: 0.6 },
    },
    color: '#d462a6',
    matureColor: '#e8448a',
    maxSize: 5,
    growthDays: 8,
    resilience: 0.5,
    seedSpread: {
        minGrowth: 0.6,
        seedCount: 2,
        intervalDays: 4,       // se reproduit
        radius: 80,            // vent, insectes
    },
});

registerSpecies({
    id: 'raspberry',
    displayName: 'Framboisier',
    soilNeeds: {
        humidity: { ideal: 0.55, tolerance: 0.30, weight: 1.0 },
        minerals: { ideal: 0.45, tolerance: 0.35, weight: 0.5 },
        organicMatter: { ideal: 0.55, tolerance: 0.35, weight: 0.7 },
        sunExposure: { ideal: 0.60, tolerance: 0.30, weight: 0.7 },
    },
    color: '#5a8a4a',
    matureColor: '#3d6b2e',
    maxSize: 7,
    growthDays: 6,             // pousse assez vite
    resilience: 0.55,
    seedSpread: {
        minGrowth: 0.7,
        seedCount: 2,
        intervalDays: 5,
        radius: 60,            // oiseaux dispersent les graines
    },
    fruitProduction: {
        fruitName: 'Framboise',
        fruitColor: '#C2185B',
        nutritionValue: 0.25,  // bon petit fruit
        minGrowth: 0.75,
        fruitsPerCycle: 5,     // production généreuse
        intervalDays: 2,       // cycle rapide
        dropRadius: 5,
        lifetimeDays: 3,       // fruit fragile, pourrit vite
    },
});

registerSpecies({
    id: 'pine',
    displayName: 'Pin',
    soilNeeds: {
        humidity: { ideal: 0.40, tolerance: 0.35, weight: 0.8 },
        minerals: { ideal: 0.35, tolerance: 0.40, weight: 0.5 },
        sunExposure: { ideal: 0.75, tolerance: 0.25, weight: 0.9 },
    },
    color: '#3a6e3a',
    matureColor: '#1e4d2b',
    maxSize: 15,
    growthDays: 20,
    resilience: 0.7,
    seedSpread: {
        minGrowth: 0.70,
        seedCount: 5,
        intervalDays: 3,
        radius: 100,
    },
    fruitProduction: {
        fruitName: 'Pomme de pin',
        fruitColor: '#5C4033',
        nutritionValue: 0.1,   // pas très nutritif (pignons)
        minGrowth: 0.9,
        fruitsPerCycle: 3,
        intervalDays: 5,
        dropRadius: 50,
        lifetimeDays: 12,      // résistant, sèche lentement
    },
});

// --- Forêt: Bouleau ---
registerSpecies({
    id: 'birch',
    displayName: 'Bouleau',
    soilNeeds: {
        humidity: { ideal: 0.50, tolerance: 0.35, weight: 0.9 },
        minerals: { ideal: 0.40, tolerance: 0.35, weight: 0.5 },
        organicMatter: { ideal: 0.45, tolerance: 0.40, weight: 0.6 },
        sunExposure: { ideal: 0.70, tolerance: 0.30, weight: 0.7 },
    },
    color: '#8fba7a',
    matureColor: '#5a9a3e',
    maxSize: 14,
    growthDays: 20,
    resilience: 0.65,
    seedSpread: {
        minGrowth: 0.65,
        seedCount: 4,
        intervalDays: 3,
        radius: 140,
    },
});

// --- Forêt: Champignon ---
registerSpecies({
    id: 'mushroom',
    displayName: 'Champignon',
    soilNeeds: {
        humidity: { ideal: 0.60, tolerance: 0.25, weight: 1.0 },
        minerals: { ideal: 0.30, tolerance: 0.40, weight: 0.3 },
        organicMatter: { ideal: 0.70, tolerance: 0.25, weight: 1.2 },
        sunExposure: { ideal: 0.20, tolerance: 0.25, weight: 1.0 }, // needs shade!
    },
    color: '#c4a882',
    matureColor: '#a08060',
    maxSize: 3,
    growthDays: 3,             // very fast
    resilience: 0.3,           // fragile
    seedSpread: {
        minGrowth: 0.6,
        seedCount: 3,          // spores
        intervalDays: 2,       // frequent
        radius: 25,            // short range (spore drop)
    },
    fruitProduction: {
        fruitName: 'Champignon',
        fruitColor: '#D2B48C',
        nutritionValue: 0.20,
        minGrowth: 0.7,
        fruitsPerCycle: 3,
        intervalDays: 1.5,
        dropRadius: 10,
        lifetimeDays: 2,       // rots fast
    },
});

// --- Prairie: Thym ---
registerSpecies({
    id: 'thyme',
    displayName: 'Thym',
    soilNeeds: {
        humidity: { ideal: 0.25, tolerance: 0.30, weight: 0.8 },
        minerals: { ideal: 0.50, tolerance: 0.35, weight: 0.7 },
        sunExposure: { ideal: 0.90, tolerance: 0.15, weight: 1.0 },
    },
    color: '#7a9a6a',
    matureColor: '#5c7c4e',
    maxSize: 4,
    growthDays: 8,
    resilience: 0.7,           // drought-resistant
    seedSpread: {
        minGrowth: 0.65,
        seedCount: 3,
        intervalDays: 3,
        radius: 50,
    },
    fruitProduction: {
        fruitName: 'Thym séché',
        fruitColor: '#8B7D6B',
        nutritionValue: 0.05,  // spice, not food
        minGrowth: 0.8,
        fruitsPerCycle: 2,
        intervalDays: 4,
        dropRadius: 15,
        lifetimeDays: 15,      // dried herb lasts long
    },
});

// --- Prairie: Sauge ---
registerSpecies({
    id: 'sage',
    displayName: 'Sauge',
    soilNeeds: {
        humidity: { ideal: 0.30, tolerance: 0.25, weight: 0.8 },
        minerals: { ideal: 0.55, tolerance: 0.30, weight: 0.8 },
        sunExposure: { ideal: 0.85, tolerance: 0.20, weight: 0.9 },
    },
    color: '#8aaa7a',
    matureColor: '#6b8b5e',
    maxSize: 4,
    growthDays: 10,
    resilience: 0.65,
    seedSpread: {
        minGrowth: 0.7,
        seedCount: 3,
        intervalDays: 4,
        radius: 45,
    },
    fruitProduction: {
        fruitName: 'Feuille de sauge',
        fruitColor: '#7B8B6F',
        nutritionValue: 0.05,  // herb
        minGrowth: 0.8,
        fruitsPerCycle: 2,
        intervalDays: 5,
        dropRadius: 12,
        lifetimeDays: 10,
    },
});

// --- Zone humide: Saule ---
registerSpecies({
    id: 'willow',
    displayName: 'Saule',
    soilNeeds: {
        humidity: { ideal: 0.80, tolerance: 0.20, weight: 1.2 },
        minerals: { ideal: 0.30, tolerance: 0.40, weight: 0.3 },
        organicMatter: { ideal: 0.40, tolerance: 0.40, weight: 0.4 },
        sunExposure: { ideal: 0.70, tolerance: 0.30, weight: 0.6 },
    },
    color: '#6aaa5a',
    matureColor: '#4a8a3a',
    maxSize: 16,
    growthDays: 20,
    resilience: 0.75,
    seedSpread: {
        minGrowth: 0.65,
        seedCount: 5,
        intervalDays: 3,
        radius: 90,
    },
});

// --- Zone humide: Roseau ---
registerSpecies({
    id: 'reed',
    displayName: 'Roseau',
    soilNeeds: {
        humidity: { ideal: 0.90, tolerance: 0.15, weight: 1.3 },
        minerals: { ideal: 0.20, tolerance: 0.40, weight: 0.2 },
        organicMatter: { ideal: 0.30, tolerance: 0.40, weight: 0.3 },
        sunExposure: { ideal: 0.80, tolerance: 0.25, weight: 0.7 },
    },
    color: '#8aaa6a',
    matureColor: '#7a9a5a',
    maxSize: 5,
    growthDays: 4,             // very fast
    resilience: 0.5,
    seedSpread: {
        minGrowth: 0.5,
        seedCount: 3,          // rhizome reproduction
        intervalDays: 3,
        radius: 35,            // short range, dense colonies
    },
    // No fruit
});

// --- Fruitier: Pommier ---
registerSpecies({
    id: 'apple',
    displayName: 'Pommier',
    soilNeeds: {
        humidity: { ideal: 0.55, tolerance: 0.25, weight: 1.0 },
        minerals: { ideal: 0.55, tolerance: 0.25, weight: 0.9 },
        organicMatter: { ideal: 0.60, tolerance: 0.25, weight: 0.8 },
        sunExposure: { ideal: 0.75, tolerance: 0.25, weight: 0.8 },
    },
    color: '#5a8a4a',
    matureColor: '#3a6a2a',
    maxSize: 12,
    growthDays: 18,
    resilience: 0.6,
    seedSpread: {
        minGrowth: 0.70,
        seedCount: 4,
        intervalDays: 3,
        radius: 80,
    },
    fruitProduction: {
        fruitName: 'Pomme',
        fruitColor: '#CC3333',
        nutritionValue: 0.40,  // excellent food
        minGrowth: 0.85,
        fruitsPerCycle: 5,
        intervalDays: 3,
        dropRadius: 40,
        lifetimeDays: 6,
    },
});

// --- Fruitier: Cerisier ---
registerSpecies({
    id: 'cherry',
    displayName: 'Cerisier',
    soilNeeds: {
        humidity: { ideal: 0.50, tolerance: 0.25, weight: 1.0 },
        minerals: { ideal: 0.50, tolerance: 0.30, weight: 0.8 },
        organicMatter: { ideal: 0.55, tolerance: 0.30, weight: 0.7 },
        sunExposure: { ideal: 0.80, tolerance: 0.20, weight: 0.9 },
    },
    color: '#6a8a5a',
    matureColor: '#4a6a3a',
    maxSize: 11,
    growthDays: 15,
    resilience: 0.55,
    seedSpread: {
        minGrowth: 0.70,
        seedCount: 4,
        intervalDays: 3,
        radius: 90,
    },
    fruitProduction: {
        fruitName: 'Cerise',
        fruitColor: '#8B0000',
        nutritionValue: 0.30,  // tasty fruit
        minGrowth: 0.8,
        fruitsPerCycle: 8,     // abundant producer
        intervalDays: 2,
        dropRadius: 35,
        lifetimeDays: 4,       // fragile fruit
    },
});

// =============================================================
//  GROWTH STAGE THRESHOLDS
// =============================================================

function computeStage(growth: number, healthRatio: number): PlantGrowthStage {
    if (healthRatio <= 0) return 'dead';
    if (growth < 0.02) return 'seed';
    if (growth < 0.15) return 'sprout';
    if (growth < 0.85) return 'growing';
    return 'mature';
}

// =============================================================
//  SOIL CONSUMPTION
// =============================================================

/**
 * Base drain per sim-second per unit of weight for a growing plant.
 * Tuned so a single plant depletes roughly 20-30% of its cell
 * over a full growth cycle — enough to matter with multiple plants,
 * not enough to self-destruct alone.
 */
const GROWTH_DRAIN_RATE = 0.00015;

/**
 * Mature plants still need resources, but much less (maintenance).
 * Expressed as a fraction of the growth drain.
 */
const MAINTENANCE_FRACTION = 0.4;

/**
 * Drain soil nutrients at the plant's position.
 * @param growthDelta how much the plant grew this tick (0 if mature/maintenance)
 * @param dt          time step in sim-seconds
 */
function consumeSoil(
    grid: SoilGrid,
    plant: PlantEntity,
    needs: PlantSoilNeeds,
    growthDelta: number,
    dt: number,
) {
    const { x, y } = plant.position;
    const isGrowing = growthDelta > 0;

    for (const prop of SOIL_PROPERTIES) {
        const need = needs[prop];
        if (!need) continue; // this species doesn't care about this property

        // Drain proportional to the property weight (more important = more consumed)
        let drain: number;
        if (isGrowing) {
            // Active growth: drain proportional to weight * growth delta
            // 0.05 means a full growth cycle (0→1) drains 5% of soil per unit of weight
            drain = need.weight * (growthDelta * 0.05 + GROWTH_DRAIN_RATE * dt);
        } else {
            // Maintenance: small constant drain
            drain = need.weight * GROWTH_DRAIN_RATE * MAINTENANCE_FRACTION * dt;
        }

        // Scale drain by plant maturity — bigger plant = bigger roots = more absorption
        const sizeFactor = 0.3 + plant.growth * 0.7;
        drain *= sizeFactor;

        // Apply: read current, subtract, write back (clamped to 0)
        const current = grid.layers[prop][cellIndex(grid, x, y)];
        if (current <= 0) continue;
        const newVal = Math.max(0, current - drain);
        setSoilPropertyAt(grid, x, y, prop, newVal);
    }
}

/** Get flat array index for a world position. Returns -1 if out of bounds. */
function cellIndex(grid: SoilGrid, worldX: number, worldY: number): number {
    const col = Math.floor((worldX - grid.originX) / grid.cellSize);
    const row = Math.floor((worldY - grid.originY) / grid.cellSize);
    if (col < 0 || col >= grid.cols || row < 0 || row >= grid.rows) return -1;
    return row * grid.cols + col;
}

// =============================================================
//  DECOMPOSITION — dead plants return nutrients to soil
// =============================================================

/** How much organic matter a fully-grown plant of maxSize=1 returns */
const DECOMPOSE_BASE_ORGANIC = 0.25;

/** How much minerals a fully-grown plant of maxSize=1 returns at death */
const DECOMPOSE_BASE_MINERALS = 0.08;

/** Radius in cells around the plant that receives organic matter */
const DECOMPOSE_RADIUS_CELLS = 2;

/**
 * When a plant dies and is removed, spread organic matter
 * into surrounding soil cells. Amount is proportional to
 * how big the plant was (growth * maxSize).
 */
function decomposeIntoSoil(grid: SoilGrid, plant: PlantEntity, species: PlantSpecies) {
    const biomass = plant.growth * (species.maxSize / 18); // normalized to oak maxSize
    const totalOrganic = DECOMPOSE_BASE_ORGANIC * biomass;

    const centerCol = Math.floor((plant.position.x - grid.originX) / grid.cellSize);
    const centerRow = Math.floor((plant.position.y - grid.originY) / grid.cellSize);
    const r = DECOMPOSE_RADIUS_CELLS;

    // Collect cells and compute distance weights
    const cells: { idx: number; w: number }[] = [];
    let totalW = 0;

    for (let dr = -r; dr <= r; dr++) {
        for (let dc = -r; dc <= r; dc++) {
            const col = centerCol + dc;
            const row = centerRow + dr;
            if (col < 0 || col >= grid.cols || row < 0 || row >= grid.rows) continue;

            const dist = Math.sqrt(dc * dc + dr * dr);
            if (dist > r + 0.5) continue;

            const w = 1 - dist / (r + 1); // closer = more
            cells.push({ idx: row * grid.cols + col, w });
            totalW += w;
        }
    }

    if (totalW <= 0) return;

    // Distribute organic matter AND minerals weighted by proximity
    const organicLayer = grid.layers.organicMatter;
    const mineralLayer = grid.layers.minerals;
    const totalMinerals = DECOMPOSE_BASE_MINERALS * biomass;

    for (const { idx, w } of cells) {
        const frac = w / totalW;
        organicLayer[idx] = Math.min(1, organicLayer[idx] + totalOrganic * frac);
        mineralLayer[idx] = Math.min(1, mineralLayer[idx] + totalMinerals * frac);
    }
}

// =============================================================
//  SPATIAL HASH GRID — O(1) proximity queries instead of O(n)
// =============================================================

const SPATIAL_CELL = 100; // px per cell — must be >= largest query radius

type SpatialGrid = {
    cells: Map<number, PlantEntity[]>;
    cellSize: number;
    originX: number;
    originY: number;
    cols: number;
};

let _spatialGrid: SpatialGrid | null = null;

function buildSpatialGrid(scene: Scene): SpatialGrid {
    const cellSize = SPATIAL_CELL;
    const originX = -1200;
    const originY = -1200;
    const cols = Math.ceil(2400 / cellSize);
    const cells = new Map<number, PlantEntity[]>();

    for (const entity of scene.entities) {
        if (entity.type !== 'plant') continue;
        const p = entity as PlantEntity;
        if (p.health <= 0) continue;
        const c = Math.floor((p.position.x - originX) / cellSize);
        const r = Math.floor((p.position.y - originY) / cellSize);
        const key = r * cols + c;
        let bucket = cells.get(key);
        if (!bucket) { bucket = []; cells.set(key, bucket); }
        bucket.push(p);
    }

    _spatialGrid = { cells, cellSize, originX, originY, cols };
    return _spatialGrid;
}

/** Query all plants within a radius from a point using the spatial grid */
function queryNearby(grid: SpatialGrid, x: number, y: number, radius: number, exclude?: PlantEntity): PlantEntity[] {
    const result: PlantEntity[] = [];
    const r2 = radius * radius;
    const minC = Math.floor((x - radius - grid.originX) / grid.cellSize);
    const maxC = Math.floor((x + radius - grid.originX) / grid.cellSize);
    const minR = Math.floor((y - radius - grid.originY) / grid.cellSize);
    const maxR = Math.floor((y + radius - grid.originY) / grid.cellSize);

    for (let r = minR; r <= maxR; r++) {
        for (let c = minC; c <= maxC; c++) {
            const bucket = grid.cells.get(r * grid.cols + c);
            if (!bucket) continue;
            for (const p of bucket) {
                if (p === exclude) continue;
                const dx = p.position.x - x;
                const dy = p.position.y - y;
                if (dx * dx + dy * dy < r2) result.push(p);
            }
        }
    }
    return result;
}

// =============================================================
//  COMPETITION / DENSITY — nearby plants reduce growth rate
// =============================================================

/** Max density check radius in px. Plants within this get counted. */
const CROWD_RADIUS_BASE = 40; // px — scaled by species maxSize

/** Max neighbor count before growth starts to be penalized */
const CROWD_MAX_NEIGHBORS = 6;

/**
 * Count how many living plants are within crowding radius of a given plant.
 * Returns a growth multiplier [0.0 .. 1.0] — 1.0 = no penalty, 0.0 = full stop.
 */
function getCrowdingFactor(plant: PlantEntity, species: PlantSpecies): number {
    if (!_spatialGrid) return 1.0;
    const radius = CROWD_RADIUS_BASE * (species.maxSize / 10);
    const nearby = queryNearby(_spatialGrid, plant.position.x, plant.position.y, radius, plant);
    // Only count plants above seedling stage
    const count = nearby.filter(p => p.growth >= 0.1).length;

    if (count <= CROWD_MAX_NEIGHBORS) return 1.0;
    // Linear penalty: goes from 1.0 at maxNeighbors to 0.0 at 4x maxNeighbors
    return Math.max(0.0, 1 - (count - CROWD_MAX_NEIGHBORS) / (CROWD_MAX_NEIGHBORS * 3));
}

// =============================================================
//  GERMINATION — seeds need adequate soil to sprout
// =============================================================

/** Minimum fertility for a seed to germinate */
const GERMINATION_MIN_FERTILITY = 0.15;

/** Max dormancy time in game days — after this, seed dies if soil is still bad */
const MAX_DORMANCY_DAYS = 4;

// =============================================================
//  DENSITY CAP — prevent over-seeding in a small area
// =============================================================

/** Max same-species plants allowed in seed radius before blocking new seeds */
const DENSITY_CAP = 12;

/**
 * Check if an area already has too many plants of the same species.
 * Uses the spatial grid for fast lookup.
 */
function isAreaOvercrowded(speciesId: string, x: number, y: number, radius: number): boolean {
    if (!_spatialGrid) return false;
    const nearby = queryNearby(_spatialGrid, x, y, radius);
    let count = 0;
    for (const p of nearby) {
        if (p.speciesId === speciesId) {
            count++;
            if (count >= DENSITY_CAP) return true;
        }
    }
    return false;
}

// =============================================================
//  CROSS-POLLINATION — bonus fruit production near same-species
// =============================================================

/** Radius to check for same-species neighbors for pollination bonus */
const POLLINATION_RADIUS = 80;

/** Bonus multiplier for fruit production when pollinated */
const POLLINATION_BONUS = 1.2;

/**
 * Check if a mature plant has a same-species neighbor nearby.
 * Returns a fruit production multiplier (1.0 or POLLINATION_BONUS).
 */
function getPollinationFactor(plant: PlantEntity): number {
    if (!_spatialGrid) return 1.0;
    const nearby = queryNearby(_spatialGrid, plant.position.x, plant.position.y, POLLINATION_RADIUS, plant);
    for (const other of nearby) {
        if (other.speciesId === plant.speciesId && other.growth >= 0.5) return POLLINATION_BONUS;
    }
    return 1.0;
}

// =============================================================
//  HEALTH — driven entirely by soil conditions
// =============================================================

/** HP/s regenerated when soil fertility is perfect (1.0) */
const HEALTH_REGEN_RATE = 2.0;
/** HP/s lost when soil fertility is zero, before resilience */
const HEALTH_STRESS_RATE = 5.0;
/** Fertility threshold: above → regen, below → stress */
const FERTILITY_COMFORT = 0.35;

// =============================================================
//  SEED DISPERSAL
// =============================================================

/**
 * Try to disperse seeds from a mature plant.
 * New seeds are added directly to scene.entities.
 */
function tryDisperse(scene: Scene, plant: PlantEntity, species: PlantSpecies, dt: number) {
    const spread = species.seedSpread;

    // Not mature enough to produce seeds
    if (plant.growth < spread.minGrowth) return;
    // Must be healthy to reproduce
    if (plant.health < 50) return;

    plant.seedTimer -= dt;
    if (plant.seedTimer > 0) return;

    // Reset timer
    plant.seedTimer = DAYS(spread.intervalDays);

    // Check density cap — don't over-seed if area is already full
    if (isAreaOvercrowded(species.id, plant.position.x, plant.position.y, spread.radius)) return;

    // Disperse seeds
    for (let s = 0; s < spread.seedCount; s++) {
        const angle = Math.random() * Math.PI * 2;
        // Random distance — biased toward the edge (sqrt for uniform area distribution)
        const dist = Math.sqrt(Math.random()) * spread.radius;

        const seedPos = {
            x: plant.position.x + Math.cos(angle) * dist,
            y: plant.position.y + Math.sin(angle) * dist,
        };

        // Don't drop seeds outside the world
        if (!isInWorldBounds(seedPos.x, seedPos.y)) continue;

        // Don't drop seeds into water
        if (scene.lakesEnabled && scene.soilGrid) {
            const idx = cellIndex(scene.soilGrid, seedPos.x, seedPos.y);
            if (idx >= 0 && scene.soilGrid.waterLevel[idx] > 0.3) continue;
        }

        const seed: PlantEntity = {
            id: `plant-${generateEntityId()}`,
            type: 'plant',
            speciesId: species.id,
            position: seedPos,
            growth: 0,
            health: 100,
            age: 0,
            stage: 'seed',
            seedTimer: 0,
            fruitTimer: 0,
            dormancyTimer: DAYS(MAX_DORMANCY_DAYS),
        };

        scene.entities.push(seed);
    }
}

// =============================================================
//  FRUIT PRODUCTION
// =============================================================

/**
 * Try to produce fruits from a mature plant.
 * Fruits are dropped as FruitEntity around the plant.
 */
function tryProduceFruits(scene: Scene, plant: PlantEntity, species: PlantSpecies, dt: number) {
    const fp = species.fruitProduction;
    if (!fp) return; // this species doesn't produce fruits

    // Not mature enough
    if (plant.growth < fp.minGrowth) return;
    // Must be healthy
    if (plant.health < 40) return;

    plant.fruitTimer -= dt;
    if (plant.fruitTimer > 0) return;

    // Reset timer
    plant.fruitTimer = DAYS(fp.intervalDays);

    // Health factor: healthier plants produce more fruits
    const healthFactor = Math.min(1, plant.health / 80);
    // Cross-pollination bonus: +20% when same-species neighbor is nearby
    const pollinationMult = getPollinationFactor(plant);
    const count = Math.max(1, Math.round(fp.fruitsPerCycle * healthFactor * pollinationMult));

    for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = Math.sqrt(Math.random()) * fp.dropRadius;

        const fruitPos = {
            x: plant.position.x + Math.cos(angle) * dist,
            y: plant.position.y + Math.sin(angle) * dist,
        };

        // Don't drop fruits outside the world
        if (!isInWorldBounds(fruitPos.x, fruitPos.y)) continue;

        // Don't drop fruits into water
        if (scene.lakesEnabled && scene.soilGrid) {
            const idx = cellIndex(scene.soilGrid, fruitPos.x, fruitPos.y);
            if (idx >= 0 && scene.soilGrid.waterLevel[idx] > 0.3) continue;
        }

        const fruit: FruitEntity = {
            id: `fruit-${generateEntityId()}`,
            type: 'fruit',
            speciesId: species.id,
            fruitName: fp.fruitName,
            position: fruitPos,
            nutritionValue: fp.nutritionValue,
            age: 0,
            maxAge: DAYS(fp.lifetimeDays),
            color: fp.fruitColor,
            parentPlantId: plant.id,
        };

        scene.entities.push(fruit);
    }
}

// =============================================================
//  FRUIT AGING — fruits rot and decompose into soil
// =============================================================

/**
 * Process all fruits in the scene: age them, and when they rot,
 * return organic matter to the soil.
 */
function processFruits(scene: Scene, dt: number) {
    const soilGrid = scene.soilGrid;

    for (let i = scene.entities.length - 1; i >= 0; i--) {
        const entity = scene.entities[i];
        if (entity.type !== 'fruit') continue;

        const fruit = entity as FruitEntity;
        fruit.age += dt;

        // Fruit rotted — remove and add organic matter to soil
        if (fruit.age >= fruit.maxAge) {
            if (soilGrid) {
                const idx = cellIndex(soilGrid, fruit.position.x, fruit.position.y);
                if (idx >= 0) {
                    // Small amount of organic matter from decomposing fruit
                    soilGrid.layers.organicMatter[idx] = Math.min(
                        1,
                        soilGrid.layers.organicMatter[idx] + 0.01 * fruit.nutritionValue,
                    );
                }
            }
            scene.entities.splice(i, 1);
        }
    }
}

// =============================================================
//  CANOPY — mature trees cast shade, reducing sunExposure
// =============================================================

/** How often to recompute canopy (sim-seconds). ~1 game-hour. */
const CANOPY_UPDATE_INTERVAL = 300;

/** Tracks elapsed time since last canopy update */
let canopyTimer = 0;

/** Max shade radius in cells for a fully-grown tree of maxSize=18 */
const CANOPY_MAX_RADIUS_CELLS = 4;

/** Max sun reduction at center of a fully-grown tree */
const CANOPY_MAX_SHADE = 0.7;

/**
 * Recompute sunExposure for the entire soil grid based on tree canopy.
 * Reset to 1.0 then subtract shade from each mature tree.
 */
function updateCanopy(scene: Scene) {
    const grid = scene.soilGrid;
    if (!grid) return;

    const sun = grid.layers.sunExposure;

    // Reset to full sun
    sun.fill(1.0);

    // Gather all living plants
    const plants = scene.entities.filter(
        (e): e is PlantEntity => e.type === 'plant' && e.health > 0 && e.growth > 0.3,
    );

    for (const plant of plants) {
        const species = getSpecies(plant.speciesId);
        if (!species) continue;

        // Only trees cast meaningful shade (maxSize >= 10)
        if (species.maxSize < 10) continue;

        const sizeFactor = (species.maxSize / 18) * plant.growth;
        const radiusCells = Math.max(1, Math.round(CANOPY_MAX_RADIUS_CELLS * sizeFactor));
        const shade = CANOPY_MAX_SHADE * sizeFactor;

        const centerCol = Math.floor((plant.position.x - grid.originX) / grid.cellSize);
        const centerRow = Math.floor((plant.position.y - grid.originY) / grid.cellSize);

        for (let dr = -radiusCells; dr <= radiusCells; dr++) {
            for (let dc = -radiusCells; dc <= radiusCells; dc++) {
                const col = centerCol + dc;
                const row = centerRow + dr;
                if (col < 0 || col >= grid.cols || row < 0 || row >= grid.rows) continue;

                const dist = Math.sqrt(dc * dc + dr * dr);
                if (dist > radiusCells + 0.5) continue;

                // Shade falls off with distance from trunk
                const falloff = 1 - dist / (radiusCells + 1);
                const reduction = shade * falloff;

                const idx = row * grid.cols + col;
                sun[idx] = Math.max(0, sun[idx] - reduction);
            }
        }
    }
}

// =============================================================
//  FLORA SIMULATION — called each tick
// =============================================================

export function processFlora(scene: Scene, dt: number) {
    const soilGrid = scene.soilGrid;

    // --- Rebuild spatial index for fast proximity queries ---
    buildSpatialGrid(scene);

    // --- Periodic canopy update ---
    canopyTimer += dt;
    if (canopyTimer >= CANOPY_UPDATE_INTERVAL) {
        canopyTimer = 0;
        updateCanopy(scene);
    }

    for (let i = scene.entities.length - 1; i >= 0; i--) {
        const entity = scene.entities[i];
        if (entity.type !== 'plant') continue;

        const plant = entity as PlantEntity;
        const species = getSpecies(plant.speciesId);
        if (!species) continue;

        const growthRate = 1 / DAYS(species.growthDays);

        // --- Age ---
        plant.age += dt;

        // --- Soil fertility score ---
        let fertility = 0.5;
        if (soilGrid) {
            const sample = getSoilAt(soilGrid, plant.position.x, plant.position.y);
            const stIdx = getSoilTypeAt(soilGrid, plant.position.x, plant.position.y);
            fertility = computePlantFertility(sample, species.soilNeeds, stIdx);
        }

        // --- Seed dormancy: seeds wait for good soil, die if too long ---
        if (plant.stage === 'seed' && plant.growth < 0.02) {
            if (plant.dormancyTimer > 0) {
                plant.dormancyTimer -= dt;
                // Check if soil is good enough to germinate
                if (fertility >= GERMINATION_MIN_FERTILITY) {
                    plant.dormancyTimer = 0; // germinate!
                } else if (plant.dormancyTimer <= 0) {
                    // Dormancy expired, soil still bad → seed dies
                    plant.health = 0;
                    plant.stage = 'dead';
                    // Return tiny organic matter
                    if (soilGrid) {
                        const idx = cellIndex(soilGrid, plant.position.x, plant.position.y);
                        if (idx >= 0) {
                            soilGrid.layers.organicMatter[idx] = Math.min(1, soilGrid.layers.organicMatter[idx] + 0.002);
                        }
                    }
                    scene.entities.splice(i, 1);
                    continue;
                } else {
                    continue; // still dormant, skip all processing
                }
            }
        }

        // --- Submersion: plants drown in water ---
        if (soilGrid && scene.lakesEnabled) {
            const idx = cellIndex(soilGrid, plant.position.x, plant.position.y);
            if (idx >= 0) {
                const wl = soilGrid.waterLevel[idx];
                if (wl > 0.3 && plant.health > 0) {
                    const drownDamage = HEALTH_STRESS_RATE * 2 * wl * dt;
                    plant.health = Math.max(0, plant.health - drownDamage);
                }
            }
        }

        // --- Health: consequence of soil conditions ---
        if (plant.health > 0) {
            if (fertility >= FERTILITY_COMFORT) {
                const regenFactor = (fertility - FERTILITY_COMFORT) / (1 - FERTILITY_COMFORT);
                plant.health = Math.min(100, plant.health + HEALTH_REGEN_RATE * regenFactor * dt);
            } else {
                const stressFactor = 1 - fertility / FERTILITY_COMFORT;
                const damage = HEALTH_STRESS_RATE * stressFactor * (1 - species.resilience * 0.8) * dt;
                plant.health = Math.max(0, plant.health - damage);
            }
        }

        // --- Growth (with crowding penalty) ---
        const prevGrowth = plant.growth;
        if (plant.health > 0 && plant.growth < 1) {
            if (fertility >= FERTILITY_COMFORT * 0.5) {
                const growthFertility = Math.min(1, fertility / 0.8);
                const crowdFactor = getCrowdingFactor(plant, species);
                const growthDelta = growthRate * growthFertility * crowdFactor * dt;
                plant.growth = Math.min(1, plant.growth + growthDelta);

                if (soilGrid) {
                    consumeSoil(soilGrid, plant, species.soilNeeds, growthDelta, dt);
                }
            }
        }
        if (prevGrowth < 0.85 && plant.growth >= 0.85) {
            console.log(`[flora] ${species.displayName} reached 85% growth — can now produce seeds`);
        } else if (plant.health > 0 && plant.growth >= 1 && soilGrid) {
            consumeSoil(soilGrid, plant, species.soilNeeds, 0, dt);
        }

        // --- Leaf litter: mature living plants continuously add organic matter + trace minerals ---
        if (soilGrid && plant.health > 0 && plant.growth > 0.8) {
            const idx = cellIndex(soilGrid, plant.position.x, plant.position.y);
            if (idx >= 0) {
                // Larger trees deposit more litter; rate is slow but meaningful
                const litterRate = 0.000015 * (species.maxSize / 18) * plant.growth;
                soilGrid.layers.organicMatter[idx] = Math.min(
                    1,
                    soilGrid.layers.organicMatter[idx] + litterRate * dt,
                );
                // Trace mineral return from leaf decomposition (~20% of organic rate)
                soilGrid.layers.minerals[idx] = Math.min(
                    1,
                    soilGrid.layers.minerals[idx] + litterRate * 0.2 * dt,
                );
            }
        }

        // --- Seed dispersal ---
        if (plant.health > 0) {
            tryDisperse(scene, plant, species, dt);
        }

        // --- Fruit production ---
        if (plant.health > 0) {
            tryProduceFruits(scene, plant, species, dt);
        }

        // --- Update stage ---
        const wasDead = plant.stage === 'dead';
        plant.stage = computeStage(plant.growth, plant.health);

        // --- Death log (once) ---
        if (plant.stage === 'dead' && !wasDead) {
            const ageDays = (plant.age / SECONDS_PER_DAY).toFixed(1);
            console.log(`[flora] ${species.displayName} DIED at age ${ageDays}d (growth: ${(plant.growth * 100).toFixed(1)}%, fertility: ${(fertility * 100).toFixed(1)}%)`);
        }

        // --- Death: remove after fade ---
        if (plant.health <= 0) {
            plant.stage = 'dead';
            plant.health -= dt * 5;
            if (plant.health < -50) {
                // Decompose: return organic matter to surrounding soil
                if (soilGrid) {
                    decomposeIntoSoil(soilGrid, plant, species);
                }
                scene.entities.splice(i, 1);
            }
        }
    }

    // --- Process fruit aging / rotting ---
    processFruits(scene, dt);
}
