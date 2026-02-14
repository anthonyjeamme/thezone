// =============================================================
//  SOIL GRID — Multi-property spatial map for the world
//  Each cell stores soil properties (humidity, minerals, etc.)
//  that determine how well different plant species can grow.
// =============================================================

import { createNoise2D } from 'simplex-noise';
import { mulberry32 } from '../Shared/prng';

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
//  SOIL GRID — Structure of Arrays for perf
// =============================================================

export type SoilGrid = {
    /** Width of the grid in cells */
    cols: number;
    /** Height of the grid in cells */
    rows: number;
    /** Size of each cell in world units (px) */
    cellSize: number;
    /** World-space origin (top-left corner of cell 0,0) */
    originX: number;
    originY: number;
    /**
     * One Float32Array per soil property, row-major: layers[prop][row * cols + col].
     * Structure-of-Arrays is cache-friendly when iterating one property at a time.
     */
    layers: Record<SoilProperty, Float32Array>;
    /**
     * Derived water level [0..1] per cell. 0 = dry, >0 = surface water (lake).
     * Not a soil property — computed dynamically from humidity + basin map.
     */
    waterLevel: Float32Array;
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
export function computePlantFertility(sample: SoilSample, needs: PlantSoilNeeds): number {
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

    return totalWeight > 0 ? weightedScore / totalWeight : 0;
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
): SoilGrid {
    const cols = Math.ceil(worldWidth / cellSize);
    const rows = Math.ceil(worldHeight / cellSize);
    const cellCount = cols * rows;

    const rng = mulberry32(seed ?? (Math.random() * 0xffffffff));

    // Create one set of noise functions per property
    const noisePerProp = {} as Record<SoilProperty, [ReturnType<typeof createNoise2D>, ReturnType<typeof createNoise2D>, ReturnType<typeof createNoise2D>]>;
    for (const prop of SOIL_PROPERTIES) {
        noisePerProp[prop] = [
            createNoise2D(() => rng()),
            createNoise2D(() => rng()),
            createNoise2D(() => rng()),
        ];
    }

    // Allocate layers
    const layers = {} as Record<SoilProperty, Float32Array>;
    for (const prop of SOIL_PROPERTIES) {
        layers[prop] = new Float32Array(cellCount);
    }

    // Fill each cell
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            const idx = row * cols + col;
            const wx = originX + col * cellSize;
            const wy = originY + row * cellSize;

            // sunExposure: uniform 1.0 — will be reduced dynamically by tree canopy later
            layers.sunExposure[idx] = 1.0;

            for (const prop of SOIL_PROPERTIES) {
                if (prop === 'sunExposure') continue; // handled above

                const cfg = NOISE_CONFIG[prop];
                const [n1, n2, n3] = noisePerProp[prop];

                const v1 = n1(wx * cfg.scale1, wy * cfg.scale1) * 0.5;
                const v2 = n2(wx * cfg.scale2, wy * cfg.scale2) * 0.3;
                const v3 = n3(wx * cfg.scale3, wy * cfg.scale3) * 0.2;

                const raw = v1 + v2 + v3 + cfg.bias;
                layers[prop][idx] = Math.max(0, Math.min(1, raw));
            }
        }
    }

    const waterLevel = new Float32Array(cellCount); // starts dry
    return { cols, rows, cellSize, originX, originY, layers, waterLevel };
}

// =============================================================
//  GRID ACCESS
// =============================================================

/** Get all soil properties at a world position. Returns zeros if out of bounds. */
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

/**
 * Process slow natural soil cycles. Called each tick.
 * - Organic matter decomposes into minerals (mineralization).
 */
export function processSoilCycles(grid: SoilGrid, dt: number) {
    const organic = grid.layers.organicMatter;
    const minerals = grid.layers.minerals;
    const count = grid.cols * grid.rows;

    for (let i = 0; i < count; i++) {
        const org = organic[i];
        if (org <= 0) continue;

        // Amount of organic matter decomposing this tick
        const decomposed = org * MINERALIZATION_RATE * dt;

        organic[i] = Math.max(0, org - decomposed);
        minerals[i] = Math.min(1, minerals[i] + decomposed * MINERALIZATION_YIELD);
    }
}

// =============================================================
//  BACKWARD COMPATIBILITY — legacy FertilityGrid type alias
// =============================================================

/** @deprecated Use SoilGrid instead. Kept as alias during migration. */
export type FertilityGrid = SoilGrid;

