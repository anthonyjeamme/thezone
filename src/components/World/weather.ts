// =============================================================
//  WEATHER SYSTEM — Dynamic weather with effect on soil
//  Weather state machine with smooth transitions.
//  Rain uses the basin map to distribute water realistically.
// =============================================================

import type { Scene } from './types';
import type { BasinMap } from './heightmap';
import { SOIL_TYPE_DEFS, SOIL_TYPE_INDEX, type SoilGrid } from './fertility';
import { getWaterSurfaceElevation } from './heightmap';
import { SECONDS_PER_HOUR } from './types';

// =============================================================
//  Types
// =============================================================

export type WeatherType = 'sunny' | 'cloudy' | 'rainy' | 'stormy' | 'foggy' | 'snowy';

export type WeatherState = {
    /** Current weather */
    current: WeatherType;
    /** How long we've been in this weather (sim-seconds) */
    elapsed: number;
    /** How long this weather episode lasts (sim-seconds) */
    duration: number;
    /** Rain intensity [0..1] — 0 for non-rain, ramps up/down for transitions */
    rainIntensity: number;
    /** Manual override — locks the weather to this type, null = automatic */
    override: WeatherType | null;
};

// =============================================================
//  Weather display info
// =============================================================

export const WEATHER_LABELS: Record<WeatherType, string> = {
    sunny: 'Ensoleillé',
    cloudy: 'Nuageux',
    rainy: 'Pluie',
    stormy: 'Orage',
    foggy: 'Brumeux',
    snowy: 'Neige',
};

export const WEATHER_ICONS: Record<WeatherType, string> = {
    sunny: '☀️',
    cloudy: '☁️',
    rainy: '🌧️',
    stormy: '⛈️',
    foggy: '🌫️',
    snowy: '❄️',
};

// =============================================================
//  Transition probabilities — what can follow what
// =============================================================

/** Probability weights for the next weather state given the current one */
const TRANSITIONS: Record<WeatherType, Record<WeatherType, number>> = {
    sunny:  { sunny: 0.40, cloudy: 0.40, rainy: 0.07, stormy: 0.02, foggy: 0.08, snowy: 0.03 },
    cloudy: { sunny: 0.25, cloudy: 0.25, rainy: 0.22, stormy: 0.08, foggy: 0.14, snowy: 0.06 },
    rainy:  { sunny: 0.08, cloudy: 0.28, rainy: 0.35, stormy: 0.12, foggy: 0.12, snowy: 0.05 },
    stormy: { sunny: 0.05, cloudy: 0.20, rainy: 0.38, stormy: 0.15, foggy: 0.12, snowy: 0.10 },
    foggy:  { sunny: 0.15, cloudy: 0.35, rainy: 0.20, stormy: 0.05, foggy: 0.20, snowy: 0.05 },
    snowy:  { sunny: 0.05, cloudy: 0.20, rainy: 0.10, stormy: 0.10, foggy: 0.10, snowy: 0.45 },
};

/** Duration range for each weather type [min, max] in game hours */
const DURATION_RANGE: Record<WeatherType, [number, number]> = {
    sunny:  [4, 16],
    cloudy: [2, 10],
    rainy:  [1, 8],
    stormy: [0.5, 3],
    foggy:  [2, 8],
    snowy:  [1, 6],
};

// =============================================================
//  Rain effect on soil
// =============================================================

/** How much humidity is added per sim-second of rain at intensity 1.0, for a basin value of 1.0 */
const RAIN_HUMIDITY_RATE = 0.0008;

/** Minimum humidity gain per rain tick (even ridgelines get some rain) */
const RAIN_BASE_GAIN = 0.15;

/** Natural evaporation rate per sim-second (humidity decays when not raining) */
const EVAPORATION_RATE = 0.00005;

// --- Lake volumetric constants ---

/** Rain depth added per sim-second at intensity 1.0 (world units / sim-second).
 *  This drives how fast depressions fill during rain. */
const RAIN_DEPTH_RATE = 0.00015;

/** Evaporation depth removed per sim-second from exposed water surface (world units / sim-second). */
const EVAP_DEPTH_RATE = 0.00004;

/** Maximum visual lake depth for normalizing waterLevel to [0..1]. */
const MAX_LAKE_DEPTH = 20;

// =============================================================
//  Initialization
// =============================================================

export function createWeatherState(): WeatherState {
    return {
        current: 'sunny',
        elapsed: 0,
        duration: randomDuration('sunny'),
        rainIntensity: 0,
        override: null,
    };
}

/** All weather types, exported for UI iteration */
export const WEATHER_TYPES: WeatherType[] = ['sunny', 'cloudy', 'rainy', 'stormy', 'foggy', 'snowy'];

// =============================================================
//  Simulation — called each tick
// =============================================================

export function processWeather(scene: Scene, dt: number) {
    const weather = scene.weather;
    if (!weather) return;

    // --- Manual override: lock weather to chosen type ---
    if (weather.override !== null) {
        if (weather.current !== weather.override) {
            weather.current = weather.override;
            weather.elapsed = 0;
            weather.duration = Infinity; // never transitions while overridden
        }
    } else {
        // --- Advance elapsed ---
        weather.elapsed += dt;

        // --- Transition if duration expired ---
        if (weather.elapsed >= weather.duration) {
            const next = pickNextWeather(weather.current);
            weather.current = next;
            weather.elapsed = 0;
            weather.duration = randomDuration(next);
        }
    }

    // --- Update rain/snow intensity (smooth ramp) ---
    const isRaining = weather.current === 'rainy' || weather.current === 'stormy';
    const isSnowing = weather.current === 'snowy';
    let targetIntensity: number;
    if (weather.current === 'stormy') targetIntensity = 1.0;
    else if (isSnowing) targetIntensity = 0.6;
    else if (isRaining) targetIntensity = 0.5;
    else targetIntensity = 0;

    const rampSpeed = 1 / (2 * SECONDS_PER_HOUR);
    if (weather.rainIntensity < targetIntensity) {
        weather.rainIntensity = Math.min(targetIntensity, weather.rainIntensity + rampSpeed * dt);
    } else if (weather.rainIntensity > targetIntensity) {
        weather.rainIntensity = Math.max(targetIntensity, weather.rainIntensity - rampSpeed * dt);
    }

    // --- Apply rain/snow to soil using basin map ---
    if (weather.rainIntensity > 0 && scene.soilGrid && scene.basinMap) {
        const effectiveIntensity = isSnowing
            ? weather.rainIntensity * 0.4
            : weather.rainIntensity;
        applyRain(scene.soilGrid, scene.basinMap, effectiveIntensity, dt);
    }

    // --- Evaporation (fog greatly slows it, rain/snow stops it) ---
    if (weather.rainIntensity === 0 && scene.soilGrid) {
        const evapDt = weather.current === 'foggy' ? dt * 0.2 : dt;
        applyEvaporation(scene.soilGrid, evapDt);
    }

    // --- Update surface water (lakes via depression map) ---
    if (scene.lakesEnabled && scene.soilGrid && scene.depressionMap && scene.heightMap) {
        updateWaterLevel(scene, dt);
    } else if (!scene.lakesEnabled && scene.soilGrid) {
        // Drain all water when feature is disabled
        scene.soilGrid.waterLevel.fill(0);
    }
}

// =============================================================
//  Internal helpers
// =============================================================

function pickNextWeather(current: WeatherType): WeatherType {
    const weights = TRANSITIONS[current];
    const types = Object.keys(weights) as WeatherType[];
    const cumulative: number[] = [];
    let sum = 0;

    for (const t of types) {
        sum += weights[t];
        cumulative.push(sum);
    }

    const r = Math.random() * sum;
    for (let i = 0; i < types.length; i++) {
        if (r <= cumulative[i]) return types[i];
    }
    return current;
}

function randomDuration(type: WeatherType): number {
    const [minH, maxH] = DURATION_RANGE[type];
    const hours = minH + Math.random() * (maxH - minH);
    return hours * SECONDS_PER_HOUR;
}

function applyRain(soilGrid: SoilGrid, basinMap: BasinMap, intensity: number, dt: number) {
    const humidity = soilGrid.layers.humidity;
    const basin = basinMap.data;
    const { soilType } = soilGrid;
    const count = soilGrid.cols * soilGrid.rows;

    for (let i = 0; i < count; i++) {
        const basinFactor = RAIN_BASE_GAIN + basin[i] * (1 - RAIN_BASE_GAIN);
        const def = SOIL_TYPE_DEFS[SOIL_TYPE_INDEX[soilType[i]]];
        const retention = 1.0 - def.drainageRate * 0.6;
        const gain = RAIN_HUMIDITY_RATE * intensity * basinFactor * retention * dt;
        humidity[i] = Math.min(1, humidity[i] + gain);
    }
}

function applyEvaporation(soilGrid: SoilGrid, dt: number) {
    const humidity = soilGrid.layers.humidity;
    const { soilType } = soilGrid;
    const count = soilGrid.cols * soilGrid.rows;

    for (let i = 0; i < count; i++) {
        const def = SOIL_TYPE_DEFS[SOIL_TYPE_INDEX[soilType[i]]];
        const evapMult = 0.5 + def.drainageRate * 1.0;
        humidity[i] = Math.max(0, humidity[i] - EVAPORATION_RATE * evapMult * dt);
    }
}

/**
 * Depression-based water level update.
 * 1. Rain adds volume to each depression proportional to intensity and cell count.
 * 2. Evaporation removes volume proportional to wet cell count.
 * 3. Overflow cascades excess volume downstream.
 * 4. Compute flat water surface per depression and write waterLevel per cell.
 */
function updateWaterLevel(scene: Scene, dt: number) {
    const soilGrid = scene.soilGrid!;
    const depMap = scene.depressionMap!;
    const heightMap = scene.heightMap!;
    const { depressions, cellDepression } = depMap;
    const water = soilGrid.waterLevel;
    const heights = heightMap.data;
    const cellArea = soilGrid.cellSize * soilGrid.cellSize;
    const count = soilGrid.cols * soilGrid.rows;
    const rainIntensity = scene.weather?.rainIntensity ?? 0;

    // --- 1. Rain fills depressions ---
    if (rainIntensity > 0) {
        for (const dep of depressions) {
            dep.waterVolume += RAIN_DEPTH_RATE * rainIntensity * dep.cellCount * cellArea * dt;
        }
    }

    // --- 2. Evaporation (proportional to wet surface area) ---
    for (const dep of depressions) {
        if (dep.waterVolume <= 0) continue;

        const surfElev = getWaterSurfaceElevation(dep);

        // Count cells below surface (binary search in sorted elevations)
        const elev = dep.sortedElevations;
        let wetCells = 0;
        // sortedElevations has N floodable cells + 1 spill entry
        const nFloodable = elev.length - 1;
        for (let k = 0; k < nFloodable; k++) {
            if (elev[k] < surfElev) wetCells++;
            else break; // sorted, so all remaining are higher
        }

        const surfaceArea = Math.max(1, wetCells) * cellArea;
        dep.waterVolume = Math.max(0, dep.waterVolume - EVAP_DEPTH_RATE * surfaceArea * dt);
    }

    // --- 3. Overflow cascading (up to 5 passes for chain reactions) ---
    for (let pass = 0; pass < 5; pass++) {
        let anyOverflow = false;
        for (const dep of depressions) {
            if (dep.waterVolume > dep.volumeCapacity) {
                const excess = dep.waterVolume - dep.volumeCapacity;
                dep.waterVolume = dep.volumeCapacity;

                if (dep.spillTargetId >= 0) {
                    depressions[dep.spillTargetId].waterVolume += excess;
                }
                // else: water flows off-map, lost
                anyOverflow = true;
            }
        }
        if (!anyOverflow) break;
    }

    // --- 4. Precompute surface elevations per depression ---
    const surfaceElevs = new Float64Array(depressions.length);
    for (let d = 0; d < depressions.length; d++) {
        surfaceElevs[d] = depressions[d].waterVolume > 0
            ? getWaterSurfaceElevation(depressions[d])
            : -Infinity;
    }

    // --- 5. Write waterLevel per cell ---
    water.fill(0);
    for (let i = 0; i < count; i++) {
        const depId = cellDepression[i];
        if (depId < 0) continue;

        const surfElev = surfaceElevs[depId];
        const depth = surfElev - heights[i];
        if (depth > 0) {
            water[i] = Math.min(1, depth / MAX_LAKE_DEPTH);
        }
    }
}
