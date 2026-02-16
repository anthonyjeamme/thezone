import type { Scene } from '../World/types';
import { getCalendar } from '../World/types';
import type { WeatherType } from '../World/weather';
import { getHeightAt, SEA_LEVEL } from '../World/heightmap';

type AmbianceLayer = {
    id: string;
    audio: HTMLAudioElement;
    baseVolume: number;
    currentVolume: number;
    targetVolume: number;
    loop: boolean;
    loaded: boolean;
};

type AmbianceCondition = {
    id: string;
    src: string;
    baseVolume: number;
    loop: boolean;
    isActive: (ctx: AmbianceContext) => boolean;
    volumeScale?: (ctx: AmbianceContext) => number;
};

type AmbianceContext = {
    hour: number;
    nightFactor: number;
    weather: WeatherType;
    rainIntensity: number;
    isForest: boolean;
    isNearWater: boolean;
    playerMoving: boolean;
    playerSprinting: boolean;
    playerCrouching: boolean;
};

const FADE_SPEED = 0.8;
const FADE_SPEED_FAST = 6;

const AMBIANCE_DEFS: AmbianceCondition[] = [
    {
        id: 'birds-morning',
        src: '/sounds/ambiance/birds-morning.mp3',
        baseVolume: 0.4,
        loop: true,
        isActive: (ctx) => ctx.hour >= 5 && ctx.hour < 10 && ctx.weather !== 'stormy',
        volumeScale: (ctx) => {
            if (ctx.hour < 6) return 0.3;
            if (ctx.hour < 8) return 1;
            return 0.5;
        },
    },
    {
        id: 'birds-day',
        src: '/sounds/ambiance/birds-day.mp3',
        baseVolume: 0.25,
        loop: true,
        isActive: (ctx) => ctx.hour >= 8 && ctx.hour < 19 && ctx.weather !== 'stormy' && ctx.weather !== 'rainy',
    },
    {
        id: 'crickets-night',
        src: '/sounds/ambiance/crickets-night.mp3',
        baseVolume: 0.35,
        loop: true,
        isActive: (ctx) => ctx.nightFactor > 0.4,
        volumeScale: (ctx) => Math.min(1, (ctx.nightFactor - 0.4) / 0.3),
    },
    {
        id: 'wind',
        src: '/sounds/ambiance/wind.mp3',
        baseVolume: 0.2,
        loop: true,
        isActive: () => true,
        volumeScale: (ctx) => {
            if (ctx.weather === 'stormy') return 1;
            if (ctx.weather === 'rainy') return 0.6;
            if (ctx.weather === 'cloudy') return 0.4;
            return 0.15;
        },
    },
    {
        id: 'rain',
        src: '/sounds/ambiance/rain.mp3',
        baseVolume: 0.5,
        loop: true,
        isActive: (ctx) => ctx.rainIntensity > 0.1,
        volumeScale: (ctx) => ctx.rainIntensity,
    },
    {
        id: 'thunder',
        src: '/sounds/ambiance/thunder.mp3',
        baseVolume: 0.6,
        loop: true,
        isActive: (ctx) => ctx.weather === 'stormy',
        volumeScale: (ctx) => ctx.rainIntensity * 0.8,
    },
    {
        id: 'storm',
        src: '/sounds/ambiance/storm.mp3',
        baseVolume: 0.45,
        loop: true,
        isActive: (ctx) => ctx.weather === 'stormy',
        volumeScale: (ctx) => ctx.rainIntensity,
    },
    {
        id: 'forest',
        src: '/sounds/ambiance/forest.mp3',
        baseVolume: 0.2,
        loop: true,
        isActive: (ctx) => ctx.isForest && ctx.nightFactor < 0.5,
    },
    {
        id: 'forest-deep',
        src: '/sounds/ambiance/forest-deep.mp3',
        baseVolume: 0.25,
        loop: true,
        isActive: (ctx) => ctx.isForest,
        volumeScale: (ctx) => ctx.nightFactor > 0.4 ? 0.7 : 1,
    },
    {
        id: 'forest-edge',
        src: '/sounds/ambiance/forest-edge.mp3',
        baseVolume: 0.15,
        loop: true,
        isActive: (ctx) => ctx.isForest && ctx.nightFactor < 0.6 && ctx.weather !== 'stormy',
    },
    {
        id: 'water',
        src: '/sounds/ambiance/water.mp3',
        baseVolume: 0.3,
        loop: true,
        isActive: (ctx) => ctx.isNearWater,
    },
    {
        id: 'footsteps',
        src: '/sounds/footsteps.mp3',
        baseVolume: 1,
        loop: true,
        isActive: (ctx) => ctx.playerMoving,
        volumeScale: (ctx) => {
            if (ctx.playerCrouching) return 0.25;
            if (ctx.playerSprinting) return 1;
            return 0.7;
        },
    },
];

export class AmbianceManager {
    private layers = new Map<string, AmbianceLayer>();
    private masterVolume = 0.6;
    private started = false;

    constructor() {
        for (const def of AMBIANCE_DEFS) {
            const audio = new Audio(def.src);
            audio.loop = def.loop;
            audio.volume = 0;
            audio.preload = 'auto';

            const layer: AmbianceLayer = {
                id: def.id,
                audio,
                baseVolume: def.baseVolume,
                currentVolume: 0,
                targetVolume: 0,
                loop: def.loop,
                loaded: false,
            };

            audio.addEventListener('canplaythrough', () => {
                layer.loaded = true;
            }, { once: true });

            audio.addEventListener('error', () => {
                layer.loaded = false;
            });

            this.layers.set(def.id, layer);
        }
    }

    setMasterVolume(vol: number): void {
        this.masterVolume = Math.max(0, Math.min(1, vol));
    }

    start(): void {
        if (this.started) return;
        this.started = true;
    }

    update(scene: Scene, dt: number): void {
        if (!this.started) return;

        const cal = getCalendar(scene.time);
        const weather = scene.weather?.current ?? 'sunny';
        const rainIntensity = scene.weather?.rainIntensity ?? 0;

        const ctx: AmbianceContext = {
            hour: cal.hour,
            nightFactor: cal.nightFactor,
            weather,
            rainIntensity,
            isForest: false,
            isNearWater: false,
            playerMoving: scene.playerMoving ?? false,
            playerSprinting: scene.playerSprinting ?? false,
            playerCrouching: scene.playerCrouching ?? false,
        };

        if (scene.playerPos && scene.heightMap) {
            const h = getHeightAt(scene.heightMap, scene.playerPos.x, scene.playerPos.y);
            ctx.isNearWater = h < SEA_LEVEL + 5;

            let treeCount = 0;
            const px = scene.playerPos.x;
            const py = scene.playerPos.y;
            const r2 = 50 * 50;
            for (const e of scene.entities) {
                if (e.type !== 'plant') continue;
                if (!['oak', 'pine', 'birch', 'willow', 'apple', 'cherry'].includes(e.speciesId)) continue;
                if (e.growth < 0.5) continue;
                const dx = e.position.x - px;
                const dy = e.position.y - py;
                if (dx * dx + dy * dy < r2) treeCount++;
                if (treeCount >= 8) break;
            }
            ctx.isForest = treeCount >= 8;
        }

        for (const def of AMBIANCE_DEFS) {
            const layer = this.layers.get(def.id);
            if (!layer) continue;

            const active = def.isActive(ctx);
            const scale = active && def.volumeScale ? def.volumeScale(ctx) : 1;
            layer.targetVolume = active ? layer.baseVolume * scale : 0;

            const isFootsteps = def.id === 'footsteps';
            const fade = isFootsteps ? FADE_SPEED_FAST : FADE_SPEED;
            const fadeStep = fade * dt;
            if (layer.currentVolume < layer.targetVolume) {
                layer.currentVolume = Math.min(layer.targetVolume, layer.currentVolume + fadeStep);
            } else if (layer.currentVolume > layer.targetVolume) {
                layer.currentVolume = Math.max(layer.targetVolume, layer.currentVolume - fadeStep);
            }

            if (isFootsteps) {
                const ctx2 = ctx;
                if (ctx2.playerCrouching) layer.audio.playbackRate = 0.7;
                else if (ctx2.playerSprinting) layer.audio.playbackRate = 1.5;
                else layer.audio.playbackRate = 1.0;
            }

            const finalVol = layer.currentVolume * this.masterVolume;
            layer.audio.volume = Math.max(0, Math.min(1, finalVol));

            if (layer.loaded) {
                if (finalVol > 0.005 && layer.audio.paused) {
                    layer.audio.play().catch(() => {});
                } else if (finalVol <= 0.005 && !layer.audio.paused) {
                    layer.audio.pause();
                }
            }
        }
    }

    destroy(): void {
        for (const layer of this.layers.values()) {
            layer.audio.pause();
            layer.audio.src = '';
        }
        this.layers.clear();
        this.started = false;
    }
}
