import * as THREE from 'three';

export function createTextSprite(text: string, color: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;

    drawTextToCanvas(ctx, text, color, canvas.width, canvas.height);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(1.5, 0.375, 1);
    sprite.userData.text = text;
    return sprite;
}

export function updateSpriteText(sprite: THREE.Sprite, text: string, color: string): void {
    if (sprite.userData.text === text) return;
    sprite.userData.text = text;

    const mat = sprite.material as THREE.SpriteMaterial;
    const texture = mat.map;
    if (!texture || !(texture instanceof THREE.CanvasTexture)) return;

    const canvas = texture.image as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    drawTextToCanvas(ctx, text, color, canvas.width, canvas.height);
    texture.needsUpdate = true;
}

function drawTextToCanvas(ctx: CanvasRenderingContext2D, text: string, color: string, w: number, h: number): void {
    ctx.clearRect(0, 0, w, h);
    ctx.font = 'bold 28px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillText(text, w / 2 + 1, h / 2 + 1);

    ctx.fillStyle = color;
    ctx.fillText(text, w / 2, h / 2);
}
