// =============================================================
//  SOIL GRID — Multi-property spatial map for the world
//  Each cell stores soil properties (humidity, minerals, etc.)
//  that determine how well different plant species can grow.
// =============================================================

import { createNoise2D } from 'simplex-noise';
import { mulberry32 } from '../Shared/prng';
import type { HeightMap } from './heightmap';

// =============================================================
//  SOIL PROPERTIES — one value per cell, each [0..1]
// =============================================================

/**
 * Names of all soil properties stored per cell.
 * Add new ones here — the grid, accessors, and noise generation
 * will adapt automatically.
 */
export const SOIL_PROPERTIES = ['humidity', 'minerals', 'organicMatter', 'sunExposure'] as const;
export type SoilProperty = typeof SOIL_PROPERTIES[number];

/**
 * A snapshot of soil conditions at a single cell.
 * One number per property, all [0..1].
 */
export type SoilSample = Record<SoilProperty, number>;

// =============================================================
//  SOIL TYPE — geological base layer
// =============================================================

export const SOIL_TYPE_IDS = ['dirt', 'sand', 'clay', 'rock', 'peat'] as const;
export type SoilTypeId = typeof SOIL_TYPE_IDS[number];

export type SoilTypeDef = {
    id: SoilTypeId;
    humidityMod: number;
    mineralsMod: number;
    organicMatterBase: number;
    drainageRate: number;
    fertilityMult: number;
    color: number;
};

export const SOIL_TYPE_DEFS: Record<SoilTypeId, SoilTypeDef> = {
    dirt: { id: 'dirt', humidityMod: 1.0, mineralsMod: 1.0, organicMatterBase: 0.40, drainageRate: 0.50, fertilityMult: 1.0, color: 0x8B7355 },
    sand: { id: 'sand', humidityMod: 0.45, mineralsMod: 0.50, organicMatterBase: 0.10, drainageRate: 0.90, fertilityMult: 0.35, color: 0xC2B280 },
    clay: { id: 'clay', humidityMod: 1.40, mineralsMod: 1.30, organicMatterBase: 0.35, drainageRate: 0.15, fertilityMult: 0.85, color: 0x9B7653 },
    rock: { id: 'rock', humidityMod: 0.15, mineralsMod: 0.70, organicMatterBase: 0.02, drainageRate: 0.95, fertilityMult: 0.05, color: 0x808080 },
    peat: { id: 'peat', humidityMod: 1.60, mineralsMod: 0.60, organicMatterBase: 0.80, drainageRate: 0.10, fertilityMult: 0.70, color: 0x3D2B1F },
};

export const SOIL_TYPE_INDEX: SoilTypeId[] = [...SOIL_TYPE_IDS];

// =============================================================
//  SOIL GRID — Structure of Arrays for perf
// =============================================================

export type SoilGrid = {
    cols: number;
    rows: number;
    cellSize: number;
    originX: number;
    originY: number;
    layers: Record<SoilProperty, Float32Array>;
    waterLevel: Float32Array;
    soilType: Uint8Array;
};

// =============================================================
//  PLANT SOIL NEEDS — what a plant species requires to thrive
// =============================================================

/**
 * Describes a plant species' ideal range for a single soil property.
 * Fertility score for this property is 1.0 when the value is between
 * `ideal` ± tolerance, and drops off linearly outside that range.
 */
export type SoilNeedRange = {
    ideal: number;      // best value (0..1)
    tolerance: number;  // acceptable deviation from ideal
    weight: number;     // importance of this property (higher = more impactful)
};

/**
 * A plant species' full soil requirements.
 * Only the properties listed matter — unlisted properties are ignored.
 */
export type PlantSoilNeeds = Partial<Record<SoilProperty, SoilNeedRange>>;

/**
 * Calculate how suitable a soil sample is for a given plant species.
 * Returns a score [0..1] where 1 = perfect conditions, 0 = cannot grow.
 */
export function computePlantFertility(sample: SoilSample, needs: PlantSoilNeeds, soilTypeIdx?: number): number {
    let totalWeight = 0;
    let weightedScore = 0;

    for (const prop of SOIL_PROPERTIES) {
        const need = needs[prop];
        if (!need) continue;

        const value = sample[prop];
        const distance = Math.abs(value - need.ideal);
        const score = Math.max(0, 1 - distance / Math.max(0.01, need.tolerance));

        weightedScore += score * need.weight;
        totalWeight += need.weight;
    }

    let base = totalWeight > 0 ? weightedScore / totalWeight : 0;
    if (soilTypeIdx !== undefined) {
        const def = SOIL_TYPE_DEFS[SOIL_TYPE_INDEX[soilTypeIdx]];
        if (def) base *= def.fertilityMult;
    }
    return base;
}

// =============================================================
//  GRID CREATION
// =============================================================

/** Noise config per soil property — different scales produce different patterns */
type NoiseConfig = {
    scale1: number;  // large features
    scale2: number;  // medium detail
    scale3: number;  // fine detail
    bias: number;    // shift: > 0.5 means "generally high"
};

const NOISE_CONFIG: Record<SoilProperty, NoiseConfig> = {
    humidity: {
        scale1: 0.002,   // large rivers / wet zones
        scale2: 0.008,   // medium moisture patches
        scale3: 0.025,   // fine variation
        bias: 0.50,      // neutral default
    },
    minerals: {
        scale1: 0.0015,  // large geological features
        scale2: 0.006,   // medium deposits
        scale3: 0.02,    // fine veins
        bias: 0.45,      // slightly scarce by default
    },
    organicMatter: {
        scale1: 0.003,   // large forested areas vs barren
        scale2: 0.012,   // patches of humus
        scale3: 0.035,   // fine leaf litter
        bias: 0.40,      // low by default — builds up with plant death
    },
    sunExposure: {
        scale1: 0.004,   // valleys (low) vs open plains (high)
        scale2: 0.015,   // medium shade patches
        scale3: 0.04,    // fine canopy gaps
        bias: 0.70,      // generally sunny — decreases under tree canopy
    },
};

/**
 * Create a soil grid covering a rectangular area of the world.
 * Each property uses independently seeded multi-octave simplex noise.
 */
export function createSoilGrid(
    originX: number,
    originY: number,
    worldWidth: number,
    worldHeight: number,
    cellSize: number,
    seed?: number,
    heightMap?: HeightMap,
): SoilGrid {
    const cols = Math.ceil(worldWidth / cellSize);
    const rows = Math.ceil(worldHeight / cellSize);
    const cellCount = cols * rows;

    const rng = mulberry32(seed ?? (Math.random() * 0xffffffff));

    const noisePerProp = {} as Record<SoilProperty, [ReturnType<typeof createNoise2D>, ReturnType<typeof createNoise2D>, ReturnType<typeof createNoise2D>]>;
    for (const prop of SOIL_PROPERTIES) {
        noisePerProp[prop] = [
            createNoise2D(() => rng()),
            createNoise2D(() => rng()),
            createNoise2D(() => rng()),
        ];
    }

    const soilTypeNoise = createNoise2D(() => rng());
    const soilTypeNoise2 = createNoise2D(() => rng());

    const layers = {} as Record<SoilProperty, Float32Array>;
    for (const prop of SOIL_PROPERTIES) {
        layers[prop] = new Float32Array(cellCount);
    }

    const soilType = new Uint8Array(cellCount);
    const hmRange = heightMap ? (heightMap.maxHeight - heightMap.minHeight || 1) : 1;

    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            const idx = row * cols + col;
            const wx = originX + col * cellSize;
            const wy = originY + row * cellSize;

            const elevNorm = heightMap
                ? (heightMap.data[Math.min(idx, heightMap.data.length - 1)] - heightMap.minHeight) / hmRange
                : 0.5;

            const sn1 = (soilTypeNoise(wx * 0.002, wy * 0.002) + 1) * 0.5;
            const sn2 = (soilTypeNoise2(wx * 0.008, wy * 0.008) + 1) * 0.5;
            const typeVal = sn1 * 0.7 + sn2 * 0.3;

            let typeIdx: number;
            if (elevNorm > 0.72) {
                typeIdx = SOIL_TYPE_INDEX.indexOf('rock');
            } else if (elevNorm < 0.08 && typeVal < 0.5) {
                typeIdx = SOIL_TYPE_INDEX.indexOf('sand');
            } else if (elevNorm < 0.18 && typeVal > 0.7) {
                typeIdx = SOIL_TYPE_INDEX.indexOf('peat');
            } else if (typeVal < 0.35) {
                typeIdx = SOIL_TYPE_INDEX.indexOf('clay');
            } else if (typeVal < 0.75) {
                typeIdx = SOIL_TYPE_INDEX.indexOf('dirt');
            } else {
                typeIdx = SOIL_TYPE_INDEX.indexOf('sand');
            }
            soilType[idx] = typeIdx;

            layers.sunExposure[idx] = 1.0;

            for (const prop of SOIL_PROPERTIES) {
                if (prop === 'sunExposure') continue;

                const cfg = NOISE_CONFIG[prop];
                const [n1, n2, n3] = noisePerProp[prop];

                const v1 = n1(wx * cfg.scale1, wy * cfg.scale1) * 0.5;
                const v2 = n2(wx * cfg.scale2, wy * cfg.scale2) * 0.3;
                const v3 = n3(wx * cfg.scale3, wy * cfg.scale3) * 0.2;

                const raw = v1 + v2 + v3 + cfg.bias;
                layers[prop][idx] = Math.max(0, Math.min(1, raw));
            }

            const def = SOIL_TYPE_DEFS[SOIL_TYPE_INDEX[typeIdx]];
            layers.humidity[idx] = Math.max(0, Math.min(1, layers.humidity[idx] * def.humidityMod));
            layers.minerals[idx] = Math.max(0, Math.min(1, layers.minerals[idx] * def.mineralsMod));
            layers.organicMatter[idx] = Math.max(0, Math.min(1,
                layers.organicMatter[idx] * 0.4 + def.organicMatterBase * 0.6));
        }
    }

    const waterLevel = new Float32Array(cellCount);
    return { cols, rows, cellSize, originX, originY, layers, waterLevel, soilType };
}

// =============================================================
//  GRID ACCESS
// =============================================================

export function getSoilTypeAt(grid: SoilGrid, worldX: number, worldY: number): number {
    const col = Math.floor((worldX - grid.originX) / grid.cellSize);
    const row = Math.floor((worldY - grid.originY) / grid.cellSize);
    if (col < 0 || col >= grid.cols || row < 0 || row >= grid.rows) return 0;
    return grid.soilType[row * grid.cols + col];
}

export function getSoilAt(grid: SoilGrid, worldX: number, worldY: number): SoilSample {
    const col = Math.floor((worldX - grid.originX) / grid.cellSize);
    const row = Math.floor((worldY - grid.originY) / grid.cellSize);

    const result = {} as SoilSample;

    if (col < 0 || col >= grid.cols || row < 0 || row >= grid.rows) {
        for (const prop of SOIL_PROPERTIES) result[prop] = 0;
        return result;
    }

    const idx = row * grid.cols + col;
    for (const prop of SOIL_PROPERTIES) {
        result[prop] = grid.layers[prop][idx];
    }
    return result;
}

/** Get a single soil property at a world position. Returns 0 if out of bounds. */
export function getSoilPropertyAt(grid: SoilGrid, worldX: number, worldY: number, prop: SoilProperty): number {
    const col = Math.floor((worldX - grid.originX) / grid.cellSize);
    const row = Math.floor((worldY - grid.originY) / grid.cellSize);

    if (col < 0 || col >= grid.cols || row < 0 || row >= grid.rows) return 0;
    return grid.layers[prop][row * grid.cols + col];
}

/** Set a single soil property at a world position. No-op if out of bounds. */
export function setSoilPropertyAt(grid: SoilGrid, worldX: number, worldY: number, prop: SoilProperty, value: number): void {
    const col = Math.floor((worldX - grid.originX) / grid.cellSize);
    const row = Math.floor((worldY - grid.originY) / grid.cellSize);

    if (col < 0 || col >= grid.cols || row < 0 || row >= grid.rows) return;
    grid.layers[prop][row * grid.cols + col] = Math.max(0, Math.min(1, value));
}

/** Get the cell indices for a world position. Returns null if out of bounds. */
export function worldToCell(grid: SoilGrid, worldX: number, worldY: number): { col: number; row: number } | null {
    const col = Math.floor((worldX - grid.originX) / grid.cellSize);
    const row = Math.floor((worldY - grid.originY) / grid.cellSize);

    if (col < 0 || col >= grid.cols || row < 0 || row >= grid.rows) return null;
    return { col, row };
}

/**
 * Compute a plant-specific fertility map from the soil grid.
 * Returns a Float32Array of [0..1] scores, same layout as a single layer.
 * Useful for rendering "where can oak trees grow?" heat maps.
 */
export function computeFertilityMap(grid: SoilGrid, needs: PlantSoilNeeds): Float32Array {
    const cellCount = grid.cols * grid.rows;
    const result = new Float32Array(cellCount);
    const sample = {} as SoilSample;

    for (let i = 0; i < cellCount; i++) {
        for (const prop of SOIL_PROPERTIES) {
            sample[prop] = grid.layers[prop][i];
        }
        result[i] = computePlantFertility(sample, needs);
    }

    return result;
}

// =============================================================
//  SOIL CYCLES — slow natural processes
// =============================================================

/**
 * Rate at which organic matter converts to minerals per sim-second.
 * Very slow — a cell at organicMatter=1.0 would release ~0.07 minerals/hour.
 */
const MINERALIZATION_RATE = 0.00002;

/** Fraction of organic matter that becomes minerals (rest is lost as CO2) */
const MINERALIZATION_YIELD = 0.6;

// --- Diffusion ---

/** Diffusion rate per sim-second. Higher = nutrients spread faster between cells. */
const DIFFUSION_RATE = 0.0001;

/** Properties that diffuse between cells. sunExposure is NOT diffused (it's derived). */
const DIFFUSIBLE_PROPS: SoilProperty[] = ['humidity', 'minerals', 'organicMatter'];

// --- Weathering (mineral regeneration) ---

/** Rate at which minerals regenerate toward baseline per sim-second. */
const WEATHERING_RATE = 0.000005;

/** Base mineral baseline. Actual baseline is modulated by elevation. */
const WEATHERING_BASE = 0.30;

/** Extra mineral baseline at max elevation (mountains are mineral-rich). */
const WEATHERING_ELEVATION_BONUS = 0.25;

/**
 * Process slow natural soil cycles. Called each tick.
 * - Organic matter decomposes into minerals (mineralization).
 * - Nutrients diffuse between adjacent cells (prevents dead pockets).
 * - Minerals regenerate slowly toward a natural baseline (weathering).
 */
export function processSoilCycles(
    grid: SoilGrid,
    dt: number,
    heightMap?: { data: Float32Array; minHeight: number; maxHeight: number },
) {
    const organic = grid.layers.organicMatter;
    const minerals = grid.layers.minerals;
    const count = grid.cols * grid.rows;

    // --- Mineralization ---
    for (let i = 0; i < count; i++) {
        const org = organic[i];
        if (org <= 0) continue;

        const decomposed = org * MINERALIZATION_RATE * dt;
        organic[i] = Math.max(0, org - decomposed);
        minerals[i] = Math.min(1, minerals[i] + decomposed * MINERALIZATION_YIELD);
    }

    // --- Diffusion (4-neighbor) ---
    diffuseSoil(grid, dt);

    // --- Weathering (mineral regeneration toward elevation-based baseline) ---
    weatherMinerals(grid, dt, heightMap);
}

/**
 * Diffuse soil properties between adjacent cells.
 * Each property flows from high-concentration to low-concentration cells.
 * Uses a simple explicit scheme: delta = DIFFUSION_RATE * dt * (neighbor - cell).
 */
function diffuseSoil(grid: SoilGrid, dt: number) {
    const { cols, rows, soilType } = grid;
    const factor = DIFFUSION_RATE * dt;

    for (const prop of DIFFUSIBLE_PROPS) {
        const layer = grid.layers[prop];
        const old = new Float32Array(layer);
        const isHumidity = prop === 'humidity';

        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
                const idx = row * cols + col;
                let flux = 0;
                let neighbors = 0;

                if (col > 0) { flux += old[idx - 1] - old[idx]; neighbors++; }
                if (col < cols - 1) { flux += old[idx + 1] - old[idx]; neighbors++; }
                if (row > 0) { flux += old[idx - cols] - old[idx]; neighbors++; }
                if (row < rows - 1) { flux += old[idx + cols] - old[idx]; neighbors++; }

                if (neighbors > 0) {
                    let f = factor;
                    if (isHumidity) {
                        const def = SOIL_TYPE_DEFS[SOIL_TYPE_INDEX[soilType[idx]]];
                        f *= 0.3 + def.drainageRate * 1.4;
                    }
                    layer[idx] = Math.max(0, Math.min(1, old[idx] + flux * f));
                }
            }
        }
    }
}

/**
 * Minerals slowly regenerate toward a natural baseline that depends on elevation.
 * Mountains (high elevation) have a higher mineral baseline.
 * This simulates rock weathering / erosion feeding the soil.
 */
function weatherMinerals(
    grid: SoilGrid,
    dt: number,
    heightMap?: { data: Float32Array; minHeight: number; maxHeight: number },
) {
    const minerals = grid.layers.minerals;
    const count = grid.cols * grid.rows;
    const rate = WEATHERING_RATE * dt;

    for (let i = 0; i < count; i++) {
        // Compute elevation-dependent baseline
        let baseline = WEATHERING_BASE;
        if (heightMap) {
            const range = heightMap.maxHeight - heightMap.minHeight;
            const normalizedH = range > 0
                ? (heightMap.data[i] - heightMap.minHeight) / range
                : 0;
            baseline += normalizedH * WEATHERING_ELEVATION_BONUS;
        }

        // Pull minerals toward baseline (never push above it)
        const current = minerals[i];
        if (current < baseline) {
            minerals[i] = Math.min(baseline, current + (baseline - current) * rate);
        }
    }
}

// =============================================================
//  BACKWARD COMPATIBILITY — legacy FertilityGrid type alias
// =============================================================

/** @deprecated Use SoilGrid instead. Kept as alias during migration. */
export type FertilityGrid = SoilGrid;

