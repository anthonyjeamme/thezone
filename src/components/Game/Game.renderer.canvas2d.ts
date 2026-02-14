// =============================================================
//  CANVAS 2D RENDERER — Implementation of GameRenderer
//  This is the original top-down 2D renderer, now pluggable.
// =============================================================

import { GameRenderer, registerRenderer } from './Game.renderer';
import { BuildingEntity, Camera, CorpseEntity, FertileZoneEntity, Highlight, LifeStage, NPCEntity, ResourceEntity, Scene, StockEntity, getCalendar, getLifeStage } from './Game.types';
import { Vector2D } from './Game.vector';
import { GESTATION_DURATION } from './Game.reproduction';

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

    render(scene: Scene, camera: Camera, highlight: Highlight): void {
        const ctx = this.ctx;
        if (!ctx || !this.canvas) return;

        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.save();
        ctx.translate(this.canvas.width / 2, this.canvas.height / 2);
        ctx.translate(camera.position.x, camera.position.y);

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
