import type { Vector2D } from '../Shared/vector';
import type { Scene } from './types';

export type SignalKind = 'noise' | 'scent' | 'visual' | 'call';

export type Signal = {
    id: string;
    kind: SignalKind;
    sourcePos: Vector2D;
    emitterId: string | null;
    intensity: number;
    radius: number;
    data?: Record<string, unknown>;
    emittedAt: number;
    ttl: number;
};

export type PerceptionProfile = {
    hearing: number;
    smell: number;
    sight: number;
    reactionTime: number;
};

export type PendingSignal = {
    signal: Signal;
    perceivedIntensity: number;
    reactionTimer: number;
};

let _nextSignalId = 0;
function nextSignalId(): string {
    return `sig-${++_nextSignalId}`;
}

export function emitSignal(
    scene: Scene,
    kind: SignalKind,
    sourcePos: Vector2D,
    emitterId: string | null,
    intensity: number,
    radius: number,
    ttl: number,
    data?: Record<string, unknown>,
): void {
    if (!scene.signals) scene.signals = [];
    scene.signals.push({
        id: nextSignalId(),
        kind,
        sourcePos: { x: sourcePos.x, y: sourcePos.y },
        emitterId,
        intensity,
        radius,
        data,
        emittedAt: scene.time,
        ttl,
    });
}

export function processSignals(scene: Scene, dt: number): void {
    if (!scene.signals) return;
    const now = scene.time;
    scene.signals = scene.signals.filter(s => (now - s.emittedAt) < s.ttl);
}

export function querySignals(
    scene: Scene,
    listenerPos: Vector2D,
    perception: PerceptionProfile,
): PendingSignal[] {
    if (!scene.signals || scene.signals.length === 0) return [];

    const results: PendingSignal[] = [];

    for (const sig of scene.signals) {
        const dx = listenerPos.x - sig.sourcePos.x;
        const dy = listenerPos.y - sig.sourcePos.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist > sig.radius) continue;

        const distFalloff = 1 - dist / sig.radius;

        let sensitivity = 0;
        switch (sig.kind) {
            case 'noise':
            case 'call':
                sensitivity = perception.hearing;
                break;
            case 'scent':
                sensitivity = perception.smell;
                break;
            case 'visual':
                sensitivity = perception.sight;
                break;
        }

        const perceivedIntensity = sig.intensity * distFalloff * sensitivity;

        if (perceivedIntensity < 0.1) continue;

        const jitter = (Math.random() - 0.5) * 0.3 * perception.reactionTime;
        const reactionTimer = perception.reactionTime + jitter;

        results.push({
            signal: sig,
            perceivedIntensity,
            reactionTimer: Math.max(0.05, reactionTimer),
        });
    }

    return results;
}
