// =============================================================
//  CANVAS 2D RENDERER — Implementation of GameRenderer
//  This is the original top-down 2D renderer, now pluggable.
// =============================================================

import { GameRenderer, registerRenderer, SoilOverlay } from '../GameRenderer';
import { BuildingEntity, Camera, CorpseEntity, FertileZoneEntity, FruitEntity, Highlight, LifeStage, NPCEntity, PlantEntity, ResourceEntity, Scene, StockEntity, getCalendar, getLifeStage } from '../../World/types';
import { getSpecies } from '../../World/flora';
import { Vector2D } from '../../Shared/vector';
import { GESTATION_DURATION } from '../../World/reproduction';
import type { SoilGrid } from '../../World/fertility';
import type { HeightMap, BasinMap } from '../../World/heightmap';

// --- Constants ---

const NPC_RADIUS: Record<LifeStage, number> = {
    baby: 5,
    child: 8,
    adolescent: 10,
    adult: 12,
};

const HEALTH_BAR_WIDTH = 28;
const HEALTH_BAR_HEIGHT = 3;

// --- Canvas2D Renderer class ---

class Canvas2DRenderer implements GameRenderer {
    readonly id = 'canvas2d';
    readonly name = 'Canvas 2D (top-down)';

    private canvas: HTMLCanvasElement | null = null;
    private ctx: CanvasRenderingContext2D | null = null;

    init(container: HTMLElement): void {
        this.canvas = document.createElement('canvas');
        this.canvas.style.display = 'block';
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        container.appendChild(this.canvas);

        this.ctx = this.canvas.getContext('2d');

        // Initial resize
        const rect = container.getBoundingClientRect();
        this.resize(rect.width, rect.height);
    }

    render(scene: Scene, camera: Camera, highlight: Highlight, soilOverlay?: SoilOverlay): void {
        const ctx = this.ctx;
        if (!ctx || !this.canvas) return;

        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.save();
        ctx.translate(this.canvas.width / 2, this.canvas.height / 2);
        ctx.translate(camera.position.x, camera.position.y);

        // Render overlay (background layer)
        if (soilOverlay === 'water' && scene.soilGrid) {
            renderWaterOverlay(ctx, scene.soilGrid, camera, this.canvas.width, this.canvas.height);
        } else if (soilOverlay === 'elevation' && scene.heightMap) {
            renderHeightGrid(ctx, scene.heightMap, camera, this.canvas.width, this.canvas.height);
        } else if (soilOverlay === 'basin' && scene.basinMap) {
            renderBasinGrid(ctx, scene.basinMap, camera, this.canvas.width, this.canvas.height);
        } else if (scene.soilGrid && soilOverlay && soilOverlay !== 'elevation' && soilOverlay !== 'basin' && soilOverlay !== 'water') {
            renderSoilGrid(ctx, scene.soilGrid, soilOverlay, camera, this.canvas.width, this.canvas.height);
        }

        // Render water (lakes) over terrain
        if (scene.lakesEnabled && scene.soilGrid && soilOverlay !== 'water') {
            renderWaterLayer(ctx, scene.soilGrid, camera, this.canvas.width, this.canvas.height);
        }

        // Render layers in order
        scene.entities.forEach((entity) => {
            if (entity.type === 'fertile_zone') renderFertileZone(ctx, entity);
        });
        scene.entities.forEach((entity) => {
            if (entity.type === 'corpse') renderCorpse(ctx, entity);
        });
        scene.entities.forEach((entity) => {
            if (entity.type === 'building') renderBuilding(ctx, entity);
        });
        scene.entities.forEach((entity) => {
            if (entity.type === 'stock') renderStock(ctx, entity);
        });
        scene.entities.forEach((entity) => {
            if (entity.type === 'plant') renderPlant(ctx, entity);
        });
        scene.entities.forEach((entity) => {
            if (entity.type === 'fruit') renderFruit(ctx, entity);
        });
        scene.entities.forEach((entity) => {
            if (entity.type === 'resource') renderResource(ctx, entity);
        });
        scene.entities.forEach((entity) => {
            if (entity.type === 'npc') {
                const isHighlighted = highlight?.type === 'npc' && highlight.id === entity.id;
                renderNPC(ctx, entity, isHighlighted);
            }
        });

        // Highlight: zone marker
        if (highlight?.type === 'zone') {
            renderZoneHighlight(ctx, highlight.position, highlight.resourceType);
        }

        ctx.restore();

        // Night overlay
        const { nightFactor } = getCalendar(scene.time);
        if (nightFactor > 0) {
            ctx.save();
            ctx.globalCompositeOperation = 'source-over';
            ctx.globalAlpha = nightFactor * 0.55;
            ctx.fillStyle = '#0a0a2e';
            ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
            ctx.restore();
        }
    }

    resize(width: number, height: number): void {
        if (!this.canvas) return;
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = Math.round(width * dpr);
        this.canvas.height = Math.round(height * dpr);
        this.canvas.style.width = `${width}px`;
        this.canvas.style.height = `${height}px`;
        this.ctx?.scale(dpr, dpr);
    }

    destroy(): void {
        if (this.canvas && this.canvas.parentElement) {
            this.canvas.parentElement.removeChild(this.canvas);
        }
        this.canvas = null;
        this.ctx = null;
    }

    getElement(): HTMLElement | null {
        return this.canvas;
    }

    screenToWorld(screenX: number, screenY: number, camera: Camera): Vector2D {
        if (!this.canvas) return { x: 0, y: 0 };
        const rect = this.canvas.getBoundingClientRect();
        const centerX = rect.width / 2;
        const centerY = rect.height / 2;
        return {
            x: screenX - rect.left - centerX - camera.position.x,
            y: screenY - rect.top - centerY - camera.position.y,
        };
    }
}

// --- Register this renderer ---

registerRenderer('canvas2d', () => new Canvas2DRenderer());

// =============================================================
//  RENDER FUNCTIONS (unchanged, just moved here)
// =============================================================

function renderNPC(ctx: CanvasRenderingContext2D, entity: NPCEntity, highlighted = false) {
    const { x, y } = entity.position;
    const stage = getLifeStage(entity.age);
    const radius = NPC_RADIUS[stage];
    const outerRadius = radius + 6;

    // Highlight ring (glow effect)
    if (highlighted) {
        ctx.save();
        ctx.shadowColor = '#fff';
        ctx.shadowBlur = 16;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(x, y, outerRadius, 0, 2 * Math.PI);
        ctx.stroke();
        ctx.restore();
    }

    // Draw movement target line
    if (entity.movement) {
        ctx.strokeStyle = entity.color;
        ctx.globalAlpha = 0.2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(entity.movement.target.x, entity.movement.target.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
    }

    // Draw take progress arc
    if (entity.action?.type === 'take') {
        const progress = 1 - entity.action.remaining / entity.action.duration;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 3;
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        ctx.arc(x, y, outerRadius, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.globalAlpha = 1;
    }

    // Draw mating progress arc (pink)
    if (entity.action?.type === 'mating') {
        const progress = 1 - entity.action.remaining / entity.action.duration;
        ctx.strokeStyle = '#ff69b4';
        ctx.lineWidth = 3;
        ctx.globalAlpha = 0.8;
        ctx.beginPath();
        ctx.arc(x, y, outerRadius, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.globalAlpha = 1;
    }

    // Draw crafting progress arc (orange)
    if (entity.action?.type === 'crafting') {
        const progress = 1 - entity.action.remaining / entity.action.duration;
        ctx.strokeStyle = '#e67e22';
        ctx.lineWidth = 3;
        ctx.globalAlpha = 0.8;
        ctx.beginPath();
        ctx.arc(x, y, outerRadius, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.globalAlpha = 1;
    }

    // Draw NPC body (dimmer when low health, size by age)
    ctx.globalAlpha = 0.3 + (entity.needs.health / 100) * 0.7;
    ctx.fillStyle = entity.color;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, 2 * Math.PI);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Center text indicator (scaled font)
    const fontSize = Math.max(8, Math.round(radius * 0.9));
    if (entity.ai.state === 'sleeping') {
        ctx.fillStyle = '#f1c40f';
        ctx.font = `bold ${fontSize}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('Z', x, y);
    } else if (entity.ai.state === 'mating') {
        ctx.fillStyle = '#ff69b4';
        ctx.font = `bold ${fontSize + 2}px serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('\u2665', x, y);
    } else if (entity.ai.state === 'waiting_for_mate') {
        ctx.fillStyle = '#ff69b4';
        ctx.globalAlpha = 0.5;
        ctx.font = `bold ${fontSize}px serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('\u2665', x, y);
        ctx.globalAlpha = 1;
    } else if (entity.ai.state === 'fighting') {
        ctx.fillStyle = '#e74c3c';
        ctx.font = `bold ${fontSize + 2}px serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('\u2694', x, y);
    } else if (entity.ai.state === 'fleeing') {
        ctx.fillStyle = '#f1c40f';
        ctx.font = `bold ${fontSize}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('!', x, y);
    } else if (entity.ai.state === 'crafting') {
        ctx.fillStyle = '#e67e22';
        ctx.font = `bold ${fontSize}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('\u2692', x, y);
    } else if (entity.inventory.length > 0) {
        ctx.fillStyle = '#fff';
        ctx.font = `bold ${Math.max(8, fontSize - 2)}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(entity.inventory.length), x, y);
    }

    // Health bar above NPC (scaled)
    const barWidth = HEALTH_BAR_WIDTH * (radius / 12);
    const healthRatio = entity.needs.health / 100;
    const barX = x - barWidth / 2;
    const barY = y - radius - 8;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(barX, barY, barWidth, HEALTH_BAR_HEIGHT);

    const r = healthRatio < 0.5 ? 255 : Math.round(255 * (1 - healthRatio) * 2);
    const g = healthRatio > 0.5 ? 255 : Math.round(255 * healthRatio * 2);
    ctx.fillStyle = `rgb(${r}, ${g}, 50)`;
    ctx.fillRect(barX, barY, barWidth * healthRatio, HEALTH_BAR_HEIGHT);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(barX, barY, barWidth, HEALTH_BAR_HEIGHT);
    ctx.lineWidth = 1;

    // Greeting bubble
    if (entity.ai.greetBubbleTimer > 0) {
        const bubbleAlpha = Math.min(1, entity.ai.greetBubbleTimer / 0.5);
        const bubbleY = y - radius - 16;
        ctx.globalAlpha = bubbleAlpha * 0.9;
        ctx.fillStyle = '#fff';
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('\uD83D\uDC4B', x, bubbleY);
        ctx.globalAlpha = 1;
    }

    // Gestation arc (outer ring)
    if (entity.reproduction.gestation) {
        const gestationProgress = 1 - entity.reproduction.gestation.remaining / GESTATION_DURATION;
        ctx.strokeStyle = '#e91e63';
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.7;
        ctx.beginPath();
        ctx.arc(x, y, outerRadius - 1, -Math.PI / 2, -Math.PI / 2 + gestationProgress * Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.globalAlpha = 1;
    }
}

function renderZoneHighlight(ctx: CanvasRenderingContext2D, position: { x: number; y: number }, resourceType: string) {
    const { x, y } = position;
    const color = resourceType === 'food' ? '#2ecc71' : resourceType === 'wood' ? '#8B6914' : '#00bcd4';

    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 20;

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.arc(x, y, 20, 0, 2 * Math.PI);
    ctx.stroke();

    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(x - 10, y);
    ctx.lineTo(x + 10, y);
    ctx.moveTo(x, y - 10);
    ctx.lineTo(x, y + 10);
    ctx.stroke();

    ctx.restore();
}

function renderCorpse(ctx: CanvasRenderingContext2D, entity: CorpseEntity) {
    const { x, y } = entity.position;
    const size = 6;

    ctx.strokeStyle = entity.color;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.25;

    ctx.beginPath();
    ctx.moveTo(x - size, y - size);
    ctx.lineTo(x + size, y + size);
    ctx.moveTo(x + size, y - size);
    ctx.lineTo(x - size, y + size);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(x, y, 3, 0, 2 * Math.PI);
    ctx.stroke();

    ctx.lineWidth = 1;
    ctx.globalAlpha = 1;
}

function renderResource(ctx: CanvasRenderingContext2D, entity: ResourceEntity) {
    ctx.fillStyle = entity.color;
    ctx.globalAlpha = entity.lockedBy ? 0.3 : 1;

    if (entity.resourceType === 'wood') {
        const s = 5;
        ctx.fillRect(entity.position.x - s, entity.position.y - s, s * 2, s * 2);
        ctx.strokeStyle = '#5a4000';
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = entity.lockedBy ? 0.3 : 0.8;
        ctx.strokeRect(entity.position.x - s, entity.position.y - s, s * 2, s * 2);
        ctx.lineWidth = 1;
    } else {
        ctx.beginPath();
        ctx.arc(entity.position.x, entity.position.y, 6, 0, 2 * Math.PI);
        ctx.fill();
    }

    ctx.globalAlpha = 1;
}

function renderBuilding(ctx: CanvasRenderingContext2D, entity: BuildingEntity) {
    const poly = entity.polygon;

    if (poly.length > 0) {
        ctx.fillStyle = entity.color;
        ctx.globalAlpha = 0.22;
        ctx.beginPath();
        ctx.moveTo(poly[0].x, poly[0].y);
        for (let i = 1; i < poly.length; i++) {
            ctx.lineTo(poly[i].x, poly[i].y);
        }
        ctx.closePath();
        ctx.fill();

        ctx.strokeStyle = entity.color;
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 2;
        ctx.stroke();
    }

    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
}

function renderStock(ctx: CanvasRenderingContext2D, entity: StockEntity) {
    if (entity.items.length === 0) return;

    const totalCount = entity.items.reduce((sum, s) => sum + s.quantity, 0);
    ctx.fillStyle = entity.color;
    ctx.globalAlpha = 0.5;
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(totalCount), entity.position.x, entity.position.y);
    ctx.globalAlpha = 1;
}

function renderFertileZone(ctx: CanvasRenderingContext2D, entity: FertileZoneEntity) {
    const { x, y } = entity.position;

    ctx.fillStyle = entity.color;
    ctx.globalAlpha = 0.12;
    ctx.beginPath();
    ctx.arc(x, y, entity.radius, 0, 2 * Math.PI);
    ctx.fill();

    ctx.strokeStyle = entity.color;
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 6]);
    ctx.beginPath();
    ctx.arc(x, y, entity.radius, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.globalAlpha = 1;
}

// --- Plant rendering ---

function renderPlant(ctx: CanvasRenderingContext2D, plant: PlantEntity) {
    const species = getSpecies(plant.speciesId);
    if (!species) return;

    const { x, y } = plant.position;
    const size = species.maxSize * Math.max(0.15, plant.growth);

    // Color shifts with growth and health
    const baseColor = plant.growth > 0.6 ? species.matureColor : species.color;
    const color = plant.stage === 'dead' ? '#6B5B3A' : baseColor;

    ctx.save();

    // Fade out when dying
    if (plant.health < 30 && plant.health > 0) {
        ctx.globalAlpha = 0.4 + (plant.health / 30) * 0.6;
    } else if (plant.stage === 'dead') {
        ctx.globalAlpha = Math.max(0.1, 1 + plant.health / 50); // health goes negative after death
    }

    if (plant.stage === 'seed') {
        // Tiny dot
        ctx.fillStyle = '#8B7355';
        ctx.beginPath();
        ctx.arc(x, y, 2, 0, Math.PI * 2);
        ctx.fill();
    } else if (plant.stage === 'sprout') {
        // Small green stem
        ctx.strokeStyle = '#5a9a3a';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, y + 3);
        ctx.lineTo(x, y - 3);
        ctx.stroke();
        // Tiny leaf
        ctx.fillStyle = '#6abf4a';
        ctx.beginPath();
        ctx.ellipse(x + 2, y - 3, 2, 1.2, 0.5, 0, Math.PI * 2);
        ctx.fill();
    } else if (species.id === 'oak' || species.id === 'pine') {
        // Tree: trunk + crown
        const trunkH = size * 0.6;
        const trunkW = size * 0.25;
        ctx.fillStyle = '#6B4226';
        ctx.fillRect(x - trunkW / 2, y - trunkH / 2, trunkW, trunkH);

        // Crown
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        if (species.id === 'pine') {
            // Triangle for pine
            ctx.moveTo(x, y - size);
            ctx.lineTo(x - size * 0.7, y + size * 0.2);
            ctx.lineTo(x + size * 0.7, y + size * 0.2);
            ctx.closePath();
        } else {
            // Circle for oak
            ctx.save()
            ctx.translate(0, -size * 0.3);
            ctx.arc(x, y - size * 0.3, size * 0.75, 0, Math.PI * 2);
            ctx.restore();
        }
        ctx.fill();
    } else if (species.id === 'raspberry') {
        // Raspberry bush: rounded bushy shape
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.85;
        // Main bush body — wide low oval
        ctx.beginPath();
        ctx.ellipse(x, y, size * 0.7, size * 0.5, 0, 0, Math.PI * 2);
        ctx.fill();
        // Darker center for depth
        ctx.fillStyle = species.matureColor;
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.ellipse(x, y + size * 0.1, size * 0.4, size * 0.3, 0, 0, Math.PI * 2);
        ctx.fill();
        // Small berry dots if mature
        if (plant.growth > 0.75) {
            ctx.fillStyle = '#C2185B';
            ctx.globalAlpha = 0.9;
            const berryOffsets = [[-0.3, -0.2], [0.25, -0.1], [0, 0.2], [-0.15, 0.1], [0.3, 0.15]];
            for (const [ox, oy] of berryOffsets) {
                ctx.beginPath();
                ctx.arc(x + size * ox, y + size * oy, 1.5, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    } else if (species.id === 'wheat') {
        // Wheat stalk
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, y + size * 0.5);
        ctx.lineTo(x, y - size * 0.5);
        ctx.stroke();
        // Grain head
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.ellipse(x, y - size * 0.5, size * 0.3, size * 0.5, 0, 0, Math.PI * 2);
        ctx.fill();
    } else {
        // Default: flower / small plant — colored circle
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.arc(x, y, size * 0.6, 0, Math.PI * 2);
        ctx.fill();
        // Center dot
        ctx.fillStyle = '#fff';
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.arc(x, y, size * 0.2, 0, Math.PI * 2);
        ctx.fill();
    }

    ctx.restore();
}

// --- Fruit rendering ---

function renderFruit(ctx: CanvasRenderingContext2D, fruit: FruitEntity) {
    const { x, y } = fruit.position;

    // Fade out as fruit rots (last 30% of life)
    const lifeRatio = 1 - fruit.age / fruit.maxAge;
    const fadeStart = 0.3;
    const alpha = lifeRatio < fadeStart ? lifeRatio / fadeStart : 1;

    ctx.save();
    ctx.globalAlpha = alpha * 0.9;

    // Small colored circle
    ctx.fillStyle = fruit.color;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();

    // Tiny highlight dot
    ctx.fillStyle = '#fff';
    ctx.globalAlpha = alpha * 0.4;
    ctx.beginPath();
    ctx.arc(x - 0.8, y - 0.8, 1, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
}

// --- Soil grid rendering ---

import type { SoilProperty } from '../../World/fertility';

/** Color palettes per soil property: low → high */
const SOIL_COLORS: Record<SoilProperty, { r0: number; g0: number; b0: number; r1: number; g1: number; b1: number }> = {
    humidity:      { r0: 200, g0: 184, b0: 122, r1: 26, g1: 122, b1: 180 },  // sand → blue
    minerals:      { r0: 180, g0: 170, b0: 150, r1: 160, g1: 100, b1: 30 },  // grey → orange-brown
    organicMatter: { r0: 200, g0: 190, b0: 170, r1: 40, g1: 30, b1: 10 },    // pale → dark earth
    sunExposure:   { r0: 60, g0: 60, b0: 80, r1: 255, g1: 240, b1: 140 },    // shadow → bright yellow
};

function soilColor(value: number, prop: SoilProperty): string {
    const c = SOIL_COLORS[prop];
    const r = Math.round(c.r0 + value * (c.r1 - c.r0));
    const g = Math.round(c.g0 + value * (c.g1 - c.g0));
    const b = Math.round(c.b0 + value * (c.b1 - c.b0));
    return `rgb(${r},${g},${b})`;
}

function renderSoilGrid(
    ctx: CanvasRenderingContext2D,
    grid: SoilGrid,
    prop: SoilProperty,
    camera: Camera,
    canvasWidth: number,
    canvasHeight: number,
) {
    const dpr = window.devicePixelRatio || 1;
    const viewW = canvasWidth / dpr;
    const viewH = canvasHeight / dpr;

    const worldLeft = -camera.position.x - viewW / 2;
    const worldTop = -camera.position.y - viewH / 2;
    const worldRight = worldLeft + viewW;
    const worldBottom = worldTop + viewH;

    const colStart = Math.max(0, Math.floor((worldLeft - grid.originX) / grid.cellSize));
    const colEnd = Math.min(grid.cols, Math.ceil((worldRight - grid.originX) / grid.cellSize));
    const rowStart = Math.max(0, Math.floor((worldTop - grid.originY) / grid.cellSize));
    const rowEnd = Math.min(grid.rows, Math.ceil((worldBottom - grid.originY) / grid.cellSize));

    const cs = grid.cellSize;
    const layer = grid.layers[prop];

    ctx.save();
    ctx.globalAlpha = 0.5;

    for (let row = rowStart; row < rowEnd; row++) {
        for (let col = colStart; col < colEnd; col++) {
            const idx = row * grid.cols + col;
            const wx = grid.originX + col * cs;
            const wy = grid.originY + row * cs;

            ctx.fillStyle = soilColor(layer[idx], prop);
            ctx.fillRect(wx, wy, cs, cs);
        }
    }

    ctx.restore();
}

function renderHeightGrid(
    ctx: CanvasRenderingContext2D,
    map: HeightMap,
    camera: Camera,
    canvasWidth: number,
    canvasHeight: number,
) {
    const dpr = window.devicePixelRatio || 1;
    const viewW = canvasWidth / dpr;
    const viewH = canvasHeight / dpr;

    const worldLeft = -camera.position.x - viewW / 2;
    const worldTop = -camera.position.y - viewH / 2;
    const worldRight = worldLeft + viewW;
    const worldBottom = worldTop + viewH;

    const colStart = Math.max(0, Math.floor((worldLeft - map.originX) / map.cellSize));
    const colEnd = Math.min(map.cols, Math.ceil((worldRight - map.originX) / map.cellSize));
    const rowStart = Math.max(0, Math.floor((worldTop - map.originY) / map.cellSize));
    const rowEnd = Math.min(map.rows, Math.ceil((worldBottom - map.originY) / map.cellSize));

    const cs = map.cellSize;
    const range = map.maxHeight - map.minHeight || 1;

    ctx.save();
    ctx.globalAlpha = 0.55;

    for (let row = rowStart; row < rowEnd; row++) {
        for (let col = colStart; col < colEnd; col++) {
            const idx = row * map.cols + col;
            const h = (map.data[idx] - map.minHeight) / range; // [0..1]

            // Low = dark green/blue, high = bright tan/white
            const r = Math.round(40 + h * 200);
            const g = Math.round(80 + h * 140);
            const b = Math.round(40 + h * 80);

            const wx = map.originX + col * cs;
            const wy = map.originY + row * cs;

            ctx.fillStyle = `rgb(${r},${g},${b})`;
            ctx.fillRect(wx, wy, cs, cs);
        }
    }

    ctx.restore();
}

function renderBasinGrid(
    ctx: CanvasRenderingContext2D,
    map: BasinMap,
    camera: Camera,
    canvasWidth: number,
    canvasHeight: number,
) {
    const dpr = window.devicePixelRatio || 1;
    const viewW = canvasWidth / dpr;
    const viewH = canvasHeight / dpr;

    const worldLeft = -camera.position.x - viewW / 2;
    const worldTop = -camera.position.y - viewH / 2;
    const worldRight = worldLeft + viewW;
    const worldBottom = worldTop + viewH;

    const colStart = Math.max(0, Math.floor((worldLeft - map.originX) / map.cellSize));
    const colEnd = Math.min(map.cols, Math.ceil((worldRight - map.originX) / map.cellSize));
    const rowStart = Math.max(0, Math.floor((worldTop - map.originY) / map.cellSize));
    const rowEnd = Math.min(map.rows, Math.ceil((worldBottom - map.originY) / map.cellSize));

    const cs = map.cellSize;

    ctx.save();
    ctx.globalAlpha = 0.6;

    for (let row = rowStart; row < rowEnd; row++) {
        for (let col = colStart; col < colEnd; col++) {
            const idx = row * map.cols + col;
            const v = map.data[idx]; // [0..1] — 0 = ridge, 1 = deep basin

            // Dry sand (#c8b87a) → Deep blue (#0a3a7a)
            const r = Math.round(200 - v * 190);
            const g = Math.round(184 - v * 126);
            const b = Math.round(122 + v * 0);

            const wx = map.originX + col * cs;
            const wy = map.originY + row * cs;

            ctx.fillStyle = `rgb(${r},${g},${b})`;
            ctx.fillRect(wx, wy, cs, cs);
        }
    }

    ctx.restore();
}

// =============================================================
//  Water layer (semi-transparent blue over flooded cells)
// =============================================================

function renderWaterLayer(
    ctx: CanvasRenderingContext2D,
    soilGrid: SoilGrid,
    camera: Camera,
    screenW: number,
    screenH: number,
) {
    const { cols, rows, cellSize, originX, originY, waterLevel } = soilGrid;

    ctx.save();

    // Culling bounds
    const worldLeft = -camera.position.x - screenW / 2;
    const worldTop = -camera.position.y - screenH / 2;
    const worldRight = worldLeft + screenW;
    const worldBottom = worldTop + screenH;

    const c0 = Math.max(0, Math.floor((worldLeft - originX) / cellSize));
    const c1 = Math.min(cols - 1, Math.ceil((worldRight - originX) / cellSize));
    const r0 = Math.max(0, Math.floor((worldTop - originY) / cellSize));
    const r1 = Math.min(rows - 1, Math.ceil((worldBottom - originY) / cellSize));

    for (let row = r0; row <= r1; row++) {
        for (let col = c0; col <= c1; col++) {
            const idx = row * cols + col;
            const wl = waterLevel[idx];
            if (wl <= 0.01) continue; // skip dry cells

            const wx = originX + col * cellSize;
            const wy = originY + row * cellSize;

            const alpha = Math.min(0.7, wl * 0.8);
            const depth = Math.min(1, wl);
            // Shallow = light cyan, Deep = dark blue
            const r = Math.round(20 * (1 - depth) + 10 * depth);
            const g = Math.round(140 * (1 - depth) + 40 * depth);
            const b = Math.round(200 * (1 - depth) + 160 * depth);

            ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
            ctx.fillRect(wx, wy, cellSize, cellSize);
        }
    }

    ctx.restore();
}

// =============================================================
//  Water overlay (opaque view for data visualization)
// =============================================================

function renderWaterOverlay(
    ctx: CanvasRenderingContext2D,
    soilGrid: SoilGrid,
    camera: Camera,
    screenW: number,
    screenH: number,
) {
    const { cols, rows, cellSize, originX, originY, waterLevel } = soilGrid;

    ctx.save();

    const worldLeft = -camera.position.x - screenW / 2;
    const worldTop = -camera.position.y - screenH / 2;
    const worldRight = worldLeft + screenW;
    const worldBottom = worldTop + screenH;

    const c0 = Math.max(0, Math.floor((worldLeft - originX) / cellSize));
    const c1 = Math.min(cols - 1, Math.ceil((worldRight - originX) / cellSize));
    const r0 = Math.max(0, Math.floor((worldTop - originY) / cellSize));
    const r1 = Math.min(rows - 1, Math.ceil((worldBottom - originY) / cellSize));

    for (let row = r0; row <= r1; row++) {
        for (let col = c0; col <= c1; col++) {
            const idx = row * cols + col;
            const wl = waterLevel[idx];

            const wx = originX + col * cellSize;
            const wy = originY + row * cellSize;

            // Dry = tan (#c8b87a), Wet = deep blue (#0a4aa0)
            const depth = Math.min(1, wl);
            const r = Math.round(200 * (1 - depth) + 10 * depth);
            const g = Math.round(184 * (1 - depth) + 74 * depth);
            const b = Math.round(122 * (1 - depth) + 160 * depth);

            ctx.fillStyle = `rgb(${r},${g},${b})`;
            ctx.fillRect(wx, wy, cellSize, cellSize);
        }
    }

    ctx.restore();
}
