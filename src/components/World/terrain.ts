import { BuildingEntity } from './types';

/** @deprecated Use BuildingEntity */
type CabinEntity = BuildingEntity;
import { Vector2D, distance } from '../Shared/vector';

// --- Cabin plot generation ---

const PLOT_BASE_RADIUS = 28;     // base size of terrain plot
const PLOT_RADIUS_JITTER = 6;    // random variation on base
const PLOT_MIN_RADIUS = 10;      // minimum vertex distance from center
const PLOT_VERTEX_COUNT = 8;     // enough resolution for smooth clipping
const PLOT_SPACING = 58;         // min distance between cabin centers
const PLOT_MARGIN = 3;           // gap between adjacent plots (px)

/**
 * Generate an organic polygon for a cabin plot, aware of neighbors.
 *
 * Each vertex is extended outward, then clipped so it never crosses
 * the midpoint plane between this cabin and any neighbor. This creates
 * plots that naturally tessellate without overlap.
 */
export function generateCabinPlot(center: Vector2D, neighborCenters: Vector2D[]): Vector2D[] {
    const baseRadius = PLOT_BASE_RADIUS + Math.random() * PLOT_RADIUS_JITTER;
    const vertices: Vector2D[] = [];

    for (let i = 0; i < PLOT_VERTEX_COUNT; i++) {
        const baseAngle = (i / PLOT_VERTEX_COUNT) * Math.PI * 2;
        const angle = baseAngle + (Math.random() - 0.5) * 0.3; // small angle jitter
        let radius = baseRadius * (0.8 + Math.random() * 0.4);  // 80%-120% of base

        // Constrain radius: don't cross the midpoint line with any neighbor
        for (const neighbor of neighborCenters) {
            const dist = distance(center, neighbor);
            if (dist < 1) continue;

            const angleToNeighbor = Math.atan2(neighbor.y - center.y, neighbor.x - center.x);
            const angleDiff = angle - angleToNeighbor;
            const cosA = Math.cos(angleDiff);

            // Only constrain when vertex points towards this neighbor
            if (cosA > 0.05) {
                // Max radius so the projected distance along the neighbor axis
                // doesn't exceed half the inter-cabin distance (minus margin)
                const maxRadius = (dist * 0.5 - PLOT_MARGIN) / cosA;
                radius = Math.min(radius, maxRadius);
            }
        }

        radius = Math.max(PLOT_MIN_RADIUS, radius);

        vertices.push({
            x: center.x + Math.cos(angle) * radius,
            y: center.y + Math.sin(angle) * radius,
        });
    }

    return vertices;
}

/**
 * Find an available position for a new cabin, adjacent to existing village cabins.
 *
 * @param allCabins     All cabins in the world (used for collision checks)
 * @param villageCabins Only the cabins belonging to this village (used for adjacency)
 * @param nearPosition  Desired position hint
 * @param villageCenter Center of the village — cabins are kept within a max radius
 */
export function findCabinSlot(
    allCabins: CabinEntity[],
    villageCabins: CabinEntity[],
    nearPosition: Vector2D,
    villageCenter?: Vector2D,
): Vector2D {
    const MAX_VILLAGE_RADIUS = 200; // cabins won't be placed further than this from village center

    if (villageCabins.length === 0) return { x: nearPosition.x, y: nearPosition.y };

    // Find nearest existing village cabin to the desired position
    let nearest = villageCabins[0];
    let nearestDist = distance(nearPosition, villageCabins[0].position);

    for (const c of villageCabins) {
        const d = distance(nearPosition, c.position);
        if (d < nearestDist) {
            nearest = c;
            nearestDist = d;
        }
    }

    // Helper: check if a candidate is valid (not too close to ANY cabin, not too far from village)
    const isValid = (candidate: Vector2D) => {
        if (allCabins.some((c) => distance(c.position, candidate) < PLOT_SPACING * 0.7)) return false;
        if (villageCenter && distance(villageCenter, candidate) > MAX_VILLAGE_RADIUS) return false;
        return true;
    };

    // Try 16 angles around the nearest village cabin to find a free slot
    const startAngle = Math.random() * Math.PI * 2;

    for (let attempt = 0; attempt < 16; attempt++) {
        const angle = startAngle + (attempt / 16) * Math.PI * 2;
        const candidate: Vector2D = {
            x: nearest.position.x + Math.cos(angle) * PLOT_SPACING,
            y: nearest.position.y + Math.sin(angle) * PLOT_SPACING,
        };
        if (isValid(candidate)) return candidate;
    }

    // All slots taken around nearest → try second ring
    for (let attempt = 0; attempt < 16; attempt++) {
        const angle = startAngle + (attempt / 16) * Math.PI * 2;
        const candidate: Vector2D = {
            x: nearest.position.x + Math.cos(angle) * PLOT_SPACING * 1.7,
            y: nearest.position.y + Math.sin(angle) * PLOT_SPACING * 1.7,
        };
        if (isValid(candidate)) return candidate;
    }

    // Fallback: place near village center with some jitter
    if (villageCenter) {
        for (let attempt = 0; attempt < 16; attempt++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = PLOT_SPACING + Math.random() * PLOT_SPACING;
            const candidate: Vector2D = {
                x: villageCenter.x + Math.cos(angle) * dist,
                y: villageCenter.y + Math.sin(angle) * dist,
            };
            if (isValid(candidate)) return candidate;
        }
    }

    // Ultimate fallback
    return {
        x: nearest.position.x + (Math.random() - 0.5) * 120,
        y: nearest.position.y + (Math.random() - 0.5) * 120,
    };
}

/**
 * After placing a new cabin, regenerate polygons for all nearby cabins
 * so they adjust to the new neighbor. This keeps plots tight and non-overlapping.
 */
export function refreshNearbyPlots(cabins: CabinEntity[], newCabin: CabinEntity) {
    const REFRESH_RANGE = PLOT_SPACING * 2;

    for (const cabin of cabins) {
        if (cabin.id === newCabin.id) continue;
        if (distance(cabin.position, newCabin.position) > REFRESH_RANGE) continue;

        // Regenerate this cabin's polygon with updated neighbor awareness
        const neighbors = cabins
            .filter((c) => c.id !== cabin.id && distance(c.position, cabin.position) < REFRESH_RANGE)
            .map((c) => c.position);

        cabin.polygon = generateCabinPlot(cabin.position, neighbors);
    }
}
