// =============================================================
//  RENDERER INTERFACE — Pluggable rendering abstraction
//  Any renderer (Canvas2D, WebGL, Three.js, etc.) implements this.
// =============================================================

import { Camera, Highlight, Scene } from './Game.types';
import { Vector2D } from './Game.vector';

/**
 * Abstract renderer interface.
 * The simulation knows nothing about how it's rendered —
 * it just calls these methods each frame.
 */
export interface GameRenderer {
    /** Unique identifier for this renderer type */
    readonly id: string;
    /** Human-readable name */
    readonly name: string;

    /**
     * Initialize the renderer: create DOM elements, set up contexts.
     * The renderer must append its element(s) to the given container.
     */
    init(container: HTMLElement): void;

    /**
     * Render one frame of the scene.
     * Called every frame from the game loop.
     */
    render(scene: Scene, camera: Camera, highlight: Highlight): void;

    /**
     * Handle container resize. Called when the window/container size changes.
     */
    resize(width: number, height: number): void;

    /**
     * Cleanup: remove DOM elements, release GPU resources, etc.
     * Called when the renderer is swapped out or the game is unmounted.
     */
    destroy(): void;

    /**
     * Return the main DOM element used for rendering.
     * Used by the host component for event binding (drag, click, etc.)
     */
    getElement(): HTMLElement | null;

    /**
     * Convert screen coordinates to world coordinates.
     * Needed for mouse interactions (click to select NPC, etc.)
     */
    screenToWorld(screenX: number, screenY: number, camera: Camera): Vector2D;
}

// =============================================================
//  RENDERER REGISTRY — register and switch renderers at runtime
// =============================================================

const renderers = new Map<string, () => GameRenderer>();

/** Register a renderer factory. Call at module load time. */
export function registerRenderer(id: string, factory: () => GameRenderer) {
    renderers.set(id, factory);
}

/** Get a list of all registered renderer IDs. */
export function getAvailableRenderers(): string[] {
    return Array.from(renderers.keys());
}

/** Create a renderer instance by ID. */
export function createRenderer(id: string): GameRenderer | null {
    const factory = renderers.get(id);
    return factory ? factory() : null;
}
