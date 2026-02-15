// =============================================================
//  FARMING API — utility functions for player/NPC interaction
//  with the flora system. Not connected to gameplay yet.
// =============================================================

import { getSpecies } from './flora';
import { generateEntityId } from '../Shared/ids';
import { SECONDS_PER_DAY, type FruitEntity, type PlantEntity, type Scene } from './types';
import type { SoilGrid } from './fertility';
import type { Vector2D } from '../Shared/vector';

// =============================================================
//  PLANT SEED — manually place a seed in the world
// =============================================================

/**
 * Plant a seed of a given species at a world position.
 * Returns the created PlantEntity, or null if the species doesn't exist.
 */
export function plantSeed(
    scene: Scene,
    speciesId: string,
    position: Vector2D,
    owner?: string,
): PlantEntity | null {
    const species = getSpecies(speciesId);
    if (!species) return null;

    const seed: PlantEntity = {
        id: `plant-${generateEntityId()}`,
        type: 'plant',
        speciesId: species.id,
        position: { x: position.x, y: position.y },
        growth: 0,
        health: 100,
        age: 0,
        stage: 'seed',
        seedTimer: 0,
        fruitTimer: 0,
        dormancyTimer: 0, // manually planted → no dormancy
        owner,
    };

    scene.entities.push(seed);
    return seed;
}

// =============================================================
//  HARVEST FRUIT — pick up a fruit from the world
// =============================================================

/**
 * Remove a fruit from the scene and return its data.
 * Returns the fruit entity or null if not found.
 */
export function harvestFruit(scene: Scene, fruitId: string): FruitEntity | null {
    const idx = scene.entities.findIndex(e => e.id === fruitId && e.type === 'fruit');
    if (idx < 0) return null;

    const fruit = scene.entities[idx] as FruitEntity;
    scene.entities.splice(idx, 1);
    return fruit;
}

// =============================================================
//  TILL SOIL — improve soil in an area (preparing for farming)
// =============================================================

/** Amount of organicMatter added per tilling action */
const TILL_ORGANIC_BOOST = 0.08;
/** Amount of minerals added per tilling action */
const TILL_MINERAL_BOOST = 0.03;

/**
 * Till (work) the soil in a circular area, improving organic matter and minerals.
 * Simulates turning soil, adding compost, etc.
 * @param radius - radius in world units (px)
 */
export function tillSoil(soilGrid: SoilGrid, position: Vector2D, radius: number): void {
    const { cols, rows, cellSize, originX, originY } = soilGrid;
    const organic = soilGrid.layers.organicMatter;
    const minerals = soilGrid.layers.minerals;

    const centerCol = Math.floor((position.x - originX) / cellSize);
    const centerRow = Math.floor((position.y - originY) / cellSize);
    const radiusCells = Math.ceil(radius / cellSize);

    for (let dr = -radiusCells; dr <= radiusCells; dr++) {
        for (let dc = -radiusCells; dc <= radiusCells; dc++) {
            const col = centerCol + dc;
            const row = centerRow + dr;
            if (col < 0 || col >= cols || row < 0 || row >= rows) continue;

            const dist = Math.sqrt(dc * dc + dr * dr) * cellSize;
            if (dist > radius) continue;

            // Falloff: center gets full boost, edges get less
            const falloff = 1 - dist / radius;
            const idx = row * cols + col;
            organic[idx] = Math.min(1, organic[idx] + TILL_ORGANIC_BOOST * falloff);
            minerals[idx] = Math.min(1, minerals[idx] + TILL_MINERAL_BOOST * falloff);
        }
    }
}

// =============================================================
//  HARVEST PLANT — uproot a plant (for gathering, clearing land)
// =============================================================

/**
 * Remove a plant from the scene. Returns the plant or null if not found.
 * Does NOT decompose — the plant is removed cleanly (harvested/uprooted).
 */
export function harvestPlant(scene: Scene, plantId: string): PlantEntity | null {
    const idx = scene.entities.findIndex(e => e.id === plantId && e.type === 'plant');
    if (idx < 0) return null;

    const plant = scene.entities[idx] as PlantEntity;
    scene.entities.splice(idx, 1);
    return plant;
}
