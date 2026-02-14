// =============================================================
//  HEIGHT MAP — Terrain elevation for the world
//  Simplex noise based. Used for 3D terrain rendering and
//  water flow / accumulation simulation.
// =============================================================

import { createNoise2D } from 'simplex-noise';
import { mulberry32 } from '../Shared/prng';

// =============================================================
//  Types
// =============================================================

export type HeightMap = {
    cols: number;
    rows: number;
    cellSize: number;
    originX: number;
    originY: number;
    /** Height values in world units, row-major */
    data: Float32Array;
    /** Min/max height for normalization */
    minHeight: number;
    maxHeight: number;
};

// =============================================================
//  Generation
// =============================================================

/**
 * Create a height map using multi-octave simplex noise.
 * Heights are in world units (px). The map shares the same grid
 * dimensions as the soil grid for easy cross-referencing.
 */
export function createHeightMap(
    originX: number,
    originY: number,
    worldWidth: number,
    worldHeight: number,
    cellSize: number,
    maxElevation: number,
    seed?: number,
): HeightMap {
    const cols = Math.ceil(worldWidth / cellSize);
    const rows = Math.ceil(worldHeight / cellSize);
    const data = new Float32Array(cols * rows);

    const rng = mulberry32(seed ?? (Math.random() * 0xffffffff));
    const n1 = createNoise2D(() => rng());
    const n2 = createNoise2D(() => rng());
    const n3 = createNoise2D(() => rng());

    // Noise scales for terrain: big smooth hills + medium bumps + fine detail
    const S1 = 0.0012;
    const S2 = 0.005;
    const S3 = 0.018;

    let minH = Infinity;
    let maxH = -Infinity;

    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            const wx = originX + col * cellSize;
            const wy = originY + row * cellSize;

            const v1 = n1(wx * S1, wy * S1) * 0.6;   // large hills
            const v2 = n2(wx * S2, wy * S2) * 0.3;   // medium bumps
            const v3 = n3(wx * S3, wy * S3) * 0.1;   // fine noise

            // Combine: [-1..1] → [0..maxElevation]
            const raw = (v1 + v2 + v3 + 1) * 0.5; // normalize to [0..1]
            const h = raw * maxElevation;

            data[row * cols + col] = h;
            if (h < minH) minH = h;
            if (h > maxH) maxH = h;
        }
    }

    return { cols, rows, cellSize, originX, originY, data, minHeight: minH, maxHeight: maxH };
}

// =============================================================
//  Accessors
// =============================================================

/**
 * Get height at a world position using triangle interpolation.
 *
 * Three.js PlaneGeometry splits each quad into two triangles along the
 * diagonal from (col, row+1) to (col+1, row).  We must use the same
 * barycentric interpolation so that objects sit exactly on the mesh surface.
 *
 * Triangle 1 (tx + ty <= 1): vertices h00, h01, h10
 *   h = h00·(1-tx-ty) + h01·ty + h10·tx
 *
 * Triangle 2 (tx + ty > 1):  vertices h01, h11, h10
 *   h = h01·(1-tx) + h11·(tx+ty-1) + h10·(1-ty)
 */
export function getHeightAt(map: HeightMap, worldX: number, worldY: number): number {
    const fx = (worldX - map.originX) / map.cellSize;
    const fy = (worldY - map.originY) / map.cellSize;

    const col = Math.floor(fx);
    const row = Math.floor(fy);

    if (col < 0 || col >= map.cols - 1 || row < 0 || row >= map.rows - 1) {
        // Edge/out of bounds: fall back to nearest cell
        const c = Math.max(0, Math.min(map.cols - 1, col));
        const r = Math.max(0, Math.min(map.rows - 1, row));
        return map.data[r * map.cols + c];
    }

    // Fractional part within the cell [0..1]
    const tx = fx - col;
    const ty = fy - row;

    // Four corner heights
    const h00 = map.data[row * map.cols + col];
    const h10 = map.data[row * map.cols + col + 1];
    const h01 = map.data[(row + 1) * map.cols + col];
    const h11 = map.data[(row + 1) * map.cols + col + 1];

    // Triangle interpolation matching Three.js PlaneGeometry triangulation
    if (tx + ty <= 1) {
        // Triangle 1: (col,row), (col,row+1), (col+1,row)
        return h00 * (1 - tx - ty) + h01 * ty + h10 * tx;
    } else {
        // Triangle 2: (col,row+1), (col+1,row+1), (col+1,row)
        return h01 * (1 - tx) + h11 * (tx + ty - 1) + h10 * (1 - ty);
    }
}

/** Get normalized height [0..1] at a world position. */
export function getNormalizedHeightAt(map: HeightMap, worldX: number, worldY: number): number {
    const h = getHeightAt(map, worldX, worldY);
    const range = map.maxHeight - map.minHeight;
    if (range <= 0) return 0;
    return (h - map.minHeight) / range;
}

// =============================================================
//  BASIN MAP — Flow accumulation derived from terrain topology
//  Identifies where water would collect: valleys, depressions,
//  convergence zones. Purely static — computed once from heightmap.
// =============================================================

export type BasinMap = {
    cols: number;
    rows: number;
    cellSize: number;
    originX: number;
    originY: number;
    /** Flow accumulation score per cell [0..1], row-major.
     *  0 = ridgeline/peak, 1 = deepest basin / most upstream drainage */
    data: Float32Array;
};

// D8 neighbor offsets: [dCol, dRow]
const D8: [number, number][] = [
    [-1, -1], [0, -1], [1, -1],
    [-1,  0],          [1,  0],
    [-1,  1], [0,  1], [1,  1],
];

/**
 * Compute a basin map from a heightmap using D8 flow direction + accumulation.
 *
 * Algorithm:
 * 1. For each cell, find the steepest downhill neighbor (D8 flow direction).
 * 2. Sort all cells from highest to lowest.
 * 3. Walk downhill: each cell passes its accumulated flow to its downhill neighbor.
 * 4. Normalize with log scale so the result is [0..1].
 *
 * Flat areas (no downhill neighbor) are treated as local sinks — natural basins.
 */
export function createBasinMap(heightMap: HeightMap): BasinMap {
    const { cols, rows, data: heights } = heightMap;
    const count = cols * rows;

    // --- Step 1: compute D8 flow target for each cell ---
    // flowTarget[i] = flat index of the steepest downhill neighbor, or -1 (sink)
    const flowTarget = new Int32Array(count).fill(-1);

    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            const idx = row * cols + col;
            const h = heights[idx];

            let bestDrop = 0;
            let bestIdx = -1;

            for (const [dc, dr] of D8) {
                const nc = col + dc;
                const nr = row + dr;
                if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;

                const ni = nr * cols + nc;
                const drop = h - heights[ni];

                if (drop > bestDrop) {
                    bestDrop = drop;
                    bestIdx = ni;
                }
            }

            flowTarget[idx] = bestIdx; // -1 if no downhill neighbor (local sink)
        }
    }

    // --- Step 2: sort cells from highest to lowest ---
    const sorted = new Uint32Array(count);
    for (let i = 0; i < count; i++) sorted[i] = i;
    sorted.sort((a, b) => heights[b] - heights[a]);

    // --- Step 3: accumulate flow downhill ---
    // Each cell starts with 1 (itself) and passes everything to its target
    const accumulation = new Float32Array(count).fill(1);

    for (let s = 0; s < count; s++) {
        const idx = sorted[s]; // process from highest to lowest
        const target = flowTarget[idx];
        if (target >= 0) {
            accumulation[target] += accumulation[idx];
        }
    }

    // --- Step 4: log scale ---
    const logAcc = new Float32Array(count);
    let maxLog = 0;
    for (let i = 0; i < count; i++) {
        logAcc[i] = Math.log(accumulation[i]);
        if (logAcc[i] > maxLog) maxLog = logAcc[i];
    }

    if (maxLog > 0) {
        for (let i = 0; i < count; i++) {
            logAcc[i] /= maxLog;
        }
    }

    // --- Step 5: Gaussian blur to spread basin influence ---
    // Multiple passes of a 3x3 box blur approximate a Gaussian.
    const BLUR_PASSES = 3;
    let src = logAcc;
    let dst = new Float32Array(count);

    for (let pass = 0; pass < BLUR_PASSES; pass++) {
        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
                let sum = 0;
                let wt = 0;
                for (let dr = -1; dr <= 1; dr++) {
                    for (let dc = -1; dc <= 1; dc++) {
                        const nr = row + dr;
                        const nc = col + dc;
                        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
                        const w = (dr === 0 && dc === 0) ? 4 : (dr === 0 || dc === 0) ? 2 : 1;
                        sum += src[nr * cols + nc] * w;
                        wt += w;
                    }
                }
                dst[row * cols + col] = sum / wt;
            }
        }
        // Swap buffers
        const tmp = src;
        src = dst;
        dst = tmp;
    }

    // --- Step 6: re-normalize to [0..1] after blur ---
    let minV = Infinity;
    let maxV = -Infinity;
    for (let i = 0; i < count; i++) {
        if (src[i] < minV) minV = src[i];
        if (src[i] > maxV) maxV = src[i];
    }

    const result = new Float32Array(count);
    const range = maxV - minV || 1;
    for (let i = 0; i < count; i++) {
        result[i] = (src[i] - minV) / range;
    }

    return {
        cols, rows,
        cellSize: heightMap.cellSize,
        originX: heightMap.originX,
        originY: heightMap.originY,
        data: result,
    };
}

/** Get basin accumulation [0..1] at a world position. Returns 0 if out of bounds. */
export function getBasinValueAt(map: BasinMap, worldX: number, worldY: number): number {
    const col = Math.floor((worldX - map.originX) / map.cellSize);
    const row = Math.floor((worldY - map.originY) / map.cellSize);
    if (col < 0 || col >= map.cols || row < 0 || row >= map.rows) return 0;
    return map.data[row * map.cols + col];
}

// =============================================================
//  DEPRESSION MAP — Topographic depressions for lake simulation
//  Each depression is a closed basin that can fill with water.
//  Pre-computed from heightmap; runtime only tracks volume.
// =============================================================

export type Depression = {
    /** Unique ID (index in depressions array) */
    id: number;
    /** Flat index of the lowest cell (the sink) */
    sinkIdx: number;
    /** Elevation of the pour point where water overflows */
    spillElevation: number;
    /** Depression downstream of the spill (-1 = off-map / no target) */
    spillTargetId: number;
    /** Maximum water volume before overflow (world_units^3) */
    volumeCapacity: number;
    /** Total cells in the watershed */
    cellCount: number;
    /** Cell elevations sorted ascending (floodable cells + spillElevation as last entry) */
    sortedElevations: Float32Array;
    /** Cumulative water volume at each sorted elevation level */
    cumulativeVolumes: Float32Array;
    /** Runtime: current water volume in this depression */
    waterVolume: number;
};

export type DepressionMap = {
    /** Depression ID per cell (-1 = drains off-map, not part of any depression) */
    cellDepression: Int32Array;
    /** All depressions, indexed by ID */
    depressions: Depression[];
    cols: number;
    rows: number;
};

/**
 * Compute a depression map from a heightmap.
 *
 * Algorithm:
 * 1. D8 flow directions (steepest downhill neighbor per cell).
 * 2. Follow flow chains to label each cell with its terminal sink.
 * 3. Border sinks = edge drains (water flows off-map). Interior sinks = depressions.
 * 4. For each depression, find the spill elevation (lowest saddle on the rim).
 * 5. Compute cumulative volume tables for fast water-surface lookup.
 */
export function createDepressionMap(heightMap: HeightMap): DepressionMap {
    const { cols, rows, data: heights, cellSize } = heightMap;
    const count = cols * rows;
    const cellArea = cellSize * cellSize;

    // --- Step 1: D8 flow targets ---
    const flowTarget = new Int32Array(count).fill(-1);

    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            const idx = row * cols + col;
            const h = heights[idx];

            let bestDrop = 0;
            let bestIdx = -1;

            for (const [dc, dr] of D8) {
                const nc = col + dc;
                const nr = row + dr;
                if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;

                const ni = nr * cols + nc;
                const drop = h - heights[ni];
                if (drop > bestDrop) {
                    bestDrop = drop;
                    bestIdx = ni;
                }
            }

            flowTarget[idx] = bestIdx; // -1 = sink (no downhill neighbor)
        }
    }

    // --- Step 2: follow flow chains to find the sink for each cell ---
    const sinkOf = new Int32Array(count).fill(-1);

    for (let i = 0; i < count; i++) {
        if (sinkOf[i] >= 0) continue; // already labeled

        const chain: number[] = [];
        let cur = i;

        while (cur >= 0 && sinkOf[cur] < 0) {
            chain.push(cur);
            sinkOf[cur] = -2; // mark as "in progress"
            const next = flowTarget[cur];
            if (next < 0) break; // cur is a sink
            cur = next;
        }

        // Determine the terminal sink
        let sink: number;
        if (sinkOf[cur] >= 0 && sinkOf[cur] !== -2) {
            // Reached an already-labeled cell
            sink = sinkOf[cur];
        } else {
            // cur is a sink (flowTarget == -1)
            sink = cur;
        }

        for (const c of chain) {
            sinkOf[c] = sink;
        }
    }

    // --- Step 3: classify sinks as depression (interior) vs edge drain (border) ---
    const isBorderCell = (idx: number) => {
        const r = Math.floor(idx / cols);
        const c = idx % cols;
        return r === 0 || r === rows - 1 || c === 0 || c === cols - 1;
    };

    const sinkToDepId = new Map<number, number>();
    let nextDepId = 0;

    for (let i = 0; i < count; i++) {
        if (flowTarget[i] === -1 && !isBorderCell(i)) {
            if (!sinkToDepId.has(i)) {
                sinkToDepId.set(i, nextDepId++);
            }
        }
    }

    // Label every cell with its depression ID (-1 if drains off-map)
    const cellDepression = new Int32Array(count).fill(-1);
    for (let i = 0; i < count; i++) {
        const depId = sinkToDepId.get(sinkOf[i]);
        if (depId !== undefined) {
            cellDepression[i] = depId;
        }
    }

    // --- Step 4: collect cells per depression ---
    const depCells: number[][] = Array.from({ length: nextDepId }, () => []);
    for (let i = 0; i < count; i++) {
        const d = cellDepression[i];
        if (d >= 0) depCells[d].push(i);
    }

    // --- Step 5: compute spill elevation and target for each depression ---
    const depressions: Depression[] = [];

    for (let d = 0; d < nextDepId; d++) {
        const cells = depCells[d];
        // Find the actual sink (lowest cell)
        const sinkIdx = cells.reduce((best, i) => heights[i] < heights[best] ? i : best, cells[0]);

        // Find the spill point: lowest saddle on the rim
        // Saddle height at boundary pair (C in depression d, N not in d) = max(height[C], height[N])
        let spillElev = Infinity;
        let spillTarget = -1;

        for (const ci of cells) {
            const cr = Math.floor(ci / cols);
            const cc = ci % cols;

            for (const [dc, dr] of D8) {
                const nr = cr + dr;
                const nc = cc + dc;

                if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) {
                    // Off-map neighbor: spill to outside
                    const saddleH = heights[ci];
                    if (saddleH < spillElev) {
                        spillElev = saddleH;
                        spillTarget = -1;
                    }
                    continue;
                }

                const ni = nr * cols + nc;
                if (cellDepression[ni] === d) continue; // same depression

                // Boundary pair: saddle = max(our height, neighbor height)
                const saddleH = Math.max(heights[ci], heights[ni]);
                if (saddleH < spillElev) {
                    spillElev = saddleH;
                    spillTarget = cellDepression[ni]; // -1 (edge drain) or another depression
                }
            }
        }

        // Safety: if no spill found, set to max height
        if (spillElev === Infinity) spillElev = heights[sinkIdx] + 1;

        // --- Step 6: cumulative volume table ---
        // Only cells below spill elevation can be flooded
        const floodable = cells.filter(i => heights[i] < spillElev);
        floodable.sort((a, b) => heights[a] - heights[b]);

        const n = floodable.length;
        // +1 entry for the spill elevation itself (allows interpolation up to spill)
        const sortedElevations = new Float32Array(n + 1);
        const cumulativeVolumes = new Float32Array(n + 1);

        for (let k = 0; k < n; k++) {
            sortedElevations[k] = heights[floodable[k]];
        }
        sortedElevations[n] = spillElev;

        // cumVol[0] = 0 (water barely touches the lowest cell)
        // cumVol[k] = cumVol[k-1] + k * (elev[k] - elev[k-1]) * cellArea
        // When water rises from elev[k-1] to elev[k], k cells are already submerged,
        // each gaining (elev[k] - elev[k-1]) depth.
        cumulativeVolumes[0] = 0;
        for (let k = 1; k <= n; k++) {
            cumulativeVolumes[k] = cumulativeVolumes[k - 1]
                + k * (sortedElevations[k] - sortedElevations[k - 1]) * cellArea;
        }

        const volumeCapacity = cumulativeVolumes[n];

        depressions.push({
            id: d,
            sinkIdx,
            spillElevation: spillElev,
            spillTargetId: spillTarget,
            volumeCapacity,
            cellCount: cells.length,
            sortedElevations,
            cumulativeVolumes,
            waterVolume: 0,
        });
    }

    console.log(`[depression] Found ${depressions.length} depressions (grid ${cols}x${rows})`);
    for (const dep of depressions) {
        console.log(`  #${dep.id}: ${dep.cellCount} cells, capacity ${dep.volumeCapacity.toFixed(0)}, spill at ${dep.spillElevation.toFixed(1)} → dep ${dep.spillTargetId}`);
    }

    return { cellDepression, depressions, cols, rows };
}

/**
 * Compute the flat water surface elevation for a depression given its current waterVolume.
 * Uses binary search + interpolation on the pre-computed cumulative volume table.
 * Returns -Infinity if no water.
 */
export function getWaterSurfaceElevation(dep: Depression): number {
    if (dep.waterVolume <= 0) return -Infinity;

    const { sortedElevations, cumulativeVolumes, volumeCapacity } = dep;
    const n = sortedElevations.length;
    if (n === 0) return -Infinity;

    // Clamp to capacity (overflow is handled separately)
    const vol = Math.min(dep.waterVolume, volumeCapacity);

    // Binary search: find first index where cumVol[idx] >= vol
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cumulativeVolumes[mid] < vol) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }

    // lo is the first index where cumVol[lo] >= vol
    if (lo === 0) {
        // Tiny amount of water, surface at the bottom
        return sortedElevations[0];
    }

    // Interpolate between lo-1 and lo
    const prevVol = cumulativeVolumes[lo - 1];
    const nextVol = cumulativeVolumes[lo];
    const prevElev = sortedElevations[lo - 1];
    const nextElev = sortedElevations[lo];

    if (nextVol <= prevVol) return prevElev; // degenerate (duplicate elevations)

    const t = (vol - prevVol) / (nextVol - prevVol);
    return prevElev + t * (nextElev - prevElev);
}
