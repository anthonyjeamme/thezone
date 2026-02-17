import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export class GroundRenderer {
    private renderer: THREE.WebGLRenderer | null = null;
    private scene: THREE.Scene | null = null;
    private camera: THREE.PerspectiveCamera | null = null;
    private controls: OrbitControls | null = null;
    private container: HTMLElement | null = null;

    private ground: THREE.Mesh | null = null;
    private splatCanvas: HTMLCanvasElement | null = null;
    private splatTexture: THREE.CanvasTexture | null = null;
    private grassDetailTex: THREE.Texture | null = null;
    private dirtDetailTex: THREE.Texture | null = null;
    private groundMaterial: THREE.ShaderMaterial | null = null;

    private grassInstances: THREE.InstancedMesh | null = null;
    private grassMaterial: THREE.ShaderMaterial | null = null;
    private grassTexture: THREE.Texture | null = null;
    private cloudTexture: THREE.DataTexture | null = null;

    init(container: HTMLElement): void {
        this.container = container;

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.renderer.setClearColor(0x87ceeb);
        this.renderer.domElement.style.display = 'block';
        this.renderer.domElement.style.width = '100%';
        this.renderer.domElement.style.height = '100%';
        container.appendChild(this.renderer.domElement);

        this.scene = new THREE.Scene();
        this.scene.fog = new THREE.Fog(0x87ceeb, 40, 120);

        this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
        this.camera.position.set(0, 15, 25);
        this.camera.lookAt(0, 0, 0);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.maxPolarAngle = Math.PI / 2.1;
        this.controls.minDistance = 0.5;
        this.controls.maxDistance = 100;
        this.controls.target.set(0, 0, 0);

        const ambient = new THREE.AmbientLight(0xffffff, 0.6);
        this.scene.add(ambient);

        const sunLight = new THREE.DirectionalLight(0xfff5e6, 0.8);
        sunLight.position.set(50, 80, 30);
        sunLight.castShadow = true;
        sunLight.shadow.mapSize.width = 2048;
        sunLight.shadow.mapSize.height = 2048;
        sunLight.shadow.camera.left = -50;
        sunLight.shadow.camera.right = 50;
        sunLight.shadow.camera.top = 50;
        sunLight.shadow.camera.bottom = -50;
        sunLight.shadow.camera.far = 200;
        this.scene.add(sunLight);

        this.createSplatMap();
        this.loadTextures();
        this.createGround();
        this.createGrassInstances();

        this.onResize();
        window.addEventListener('resize', this.onResize.bind(this));
    }

    private createSplatMap(): void {
        const size = 512;
        this.splatCanvas = document.createElement('canvas');
        this.splatCanvas.width = size;
        this.splatCanvas.height = size;

        const ctx = this.splatCanvas.getContext('2d')!;
        const imageData = ctx.createImageData(size, size);

        const centerX = size / 2;
        const centerY = size / 2;
        const grassRadius = size * 0.25;
        const fadeRadius = size * 0.15;

        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const dx = x - centerX;
                const dy = y - centerY;
                const dist = Math.sqrt(dx * dx + dy * dy);

                let grassBlend = 0;
                if (dist < grassRadius) {
                    grassBlend = 1;
                } else if (dist < grassRadius + fadeRadius) {
                    const t = (dist - grassRadius) / fadeRadius;
                    grassBlend = 1 - t;
                }

                const idx = (y * size + x) * 4;
                imageData.data[idx + 0] = Math.round(grassBlend * 255);
                imageData.data[idx + 1] = 0;
                imageData.data[idx + 2] = 0;
                imageData.data[idx + 3] = 255;
            }
        }

        ctx.putImageData(imageData, 0, 0);

        this.splatTexture = new THREE.CanvasTexture(this.splatCanvas);
        this.splatTexture.minFilter = THREE.LinearFilter;
        this.splatTexture.magFilter = THREE.LinearFilter;
    }

    private loadTextures(): void {
        const textureLoader = new THREE.TextureLoader();

        this.grassDetailTex = textureLoader.load('/textures/ground/ground-grass.png', (tex) => {
            tex.wrapS = THREE.RepeatWrapping;
            tex.wrapT = THREE.RepeatWrapping;
            if (this.groundMaterial) {
                this.groundMaterial.uniforms.grassTex.value = tex;
                this.groundMaterial.needsUpdate = true;
            }
        });

        this.dirtDetailTex = textureLoader.load('/textures/ground/ground-dirt.png', (tex) => {
            tex.wrapS = THREE.RepeatWrapping;
            tex.wrapT = THREE.RepeatWrapping;
            if (this.groundMaterial) {
                this.groundMaterial.uniforms.dirtTex.value = tex;
                this.groundMaterial.needsUpdate = true;
            }
        });

        this.grassTexture = textureLoader.load('/textures/grass-brush.svg', (tex) => {
            tex.colorSpace = THREE.SRGBColorSpace;
            if (this.grassMaterial) {
                this.grassMaterial.uniforms.grassBrush.value = tex;
                this.grassMaterial.needsUpdate = true;
            }
        });
    }

    private createGround(): void {
        const size = 12.5;
        const geometry = new THREE.PlaneGeometry(size, size, 128, 128);
        geometry.rotateX(-Math.PI / 2);

        const vertexShader = `
            varying vec2 vUv;
            varying vec3 vNormal;
            
            void main() {
                vUv = uv;
                vNormal = normalize(normalMatrix * normal);
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `;

        const fragmentShader = `
            uniform sampler2D splatMap;
            uniform sampler2D grassTex;
            uniform sampler2D dirtTex;
            uniform float texRepeat;
            
            varying vec2 vUv;
            varying vec3 vNormal;
            
            void main() {
                vec4 splat = texture2D(splatMap, vUv);
                float grassBlend = splat.r;
                
                vec2 detailUv = vUv * texRepeat;
                vec4 grassColor = texture2D(grassTex, detailUv);
                vec4 dirtColor = texture2D(dirtTex, detailUv);
                
                vec4 finalColor = mix(dirtColor, grassColor, grassBlend);
                
                gl_FragColor = vec4(finalColor.rgb, 1.0);
            }
        `;

        const whitePx = new Uint8Array([255, 255, 255, 255]);
        const whiteTex = new THREE.DataTexture(whitePx, 1, 1);
        whiteTex.needsUpdate = true;

        this.groundMaterial = new THREE.ShaderMaterial({
            uniforms: {
                splatMap: { value: this.splatTexture },
                grassTex: { value: whiteTex },
                dirtTex: { value: whiteTex },
                texRepeat: { value: size / 0.25 }
            },
            vertexShader: vertexShader,
            fragmentShader: fragmentShader
        });

        this.ground = new THREE.Mesh(geometry, this.groundMaterial);
        this.ground.receiveShadow = true;
        this.scene!.add(this.ground);
    }

    private buildCloudTexture(): void {
        const res = 128;
        const pixels = new Uint8Array(res * res * 4);
        const seed = Math.random() * 100;

        for (let y = 0; y < res; y++) {
            for (let x = 0; x < res; x++) {
                const nx = x / res;
                const ny = y / res;
                const v = 0.5
                    + 0.25 * Math.sin((nx * 2.5 + seed) * Math.PI * 2) * Math.cos((ny * 3.1 + seed * 0.7) * Math.PI * 2)
                    + 0.15 * Math.sin((nx * 5.3 + ny * 4.7 + seed * 1.3) * Math.PI * 2)
                    + 0.10 * Math.cos((nx * 8.1 - ny * 6.3 + seed * 0.5) * Math.PI * 2);
                const clamped = Math.max(0, Math.min(1, v));
                const byte = Math.round(clamped * 255);
                const i = (y * res + x) * 4;
                pixels[i] = byte;
                pixels[i + 1] = byte;
                pixels[i + 2] = byte;
                pixels[i + 3] = 255;
            }
        }

        this.cloudTexture = new THREE.DataTexture(pixels, res, res);
        this.cloudTexture.wrapS = THREE.ClampToEdgeWrapping;
        this.cloudTexture.wrapT = THREE.ClampToEdgeWrapping;
        this.cloudTexture.magFilter = THREE.LinearFilter;
        this.cloudTexture.minFilter = THREE.LinearFilter;
        this.cloudTexture.needsUpdate = true;
    }

    private createGrassInstances(): void {
        const bladeW = 0.3;
        const bladeH = 0.225;
        const bladeGeometry = new THREE.PlaneGeometry(bladeW, bladeH);
        bladeGeometry.translate(0, bladeH * 0.5, 0);

        this.buildCloudTexture();

        const whitePx = new Uint8Array([255, 255, 255, 255]);
        const whiteTex = new THREE.DataTexture(whitePx, 1, 1);
        whiteTex.needsUpdate = true;

        const grassVert = `
            varying vec2 vUv;
            varying vec3 vWorldPos;

            void main() {
                vUv = uv;
                vec4 worldPos = instanceMatrix * vec4(position, 1.0);
                vWorldPos = worldPos.xyz;
                gl_Position = projectionMatrix * viewMatrix * worldPos;
            }
        `;

        const grassFrag = `
            uniform sampler2D grassBrush;
            uniform sampler2D cloudMap;
            uniform float groundSize;

            varying vec2 vUv;
            varying vec3 vWorldPos;

            void main() {
                vec4 tex = texture2D(grassBrush, vUv);
                if (tex.a < 0.7) discard;

                vec2 cloudUv = vWorldPos.xz / groundSize + 0.5;
                float cloud = texture2D(cloudMap, cloudUv).r;
                float brightness = 1.4 + cloud * 0.5;

                gl_FragColor = vec4(tex.rgb * brightness, 1.0);
            }
        `;

        this.grassMaterial = new THREE.ShaderMaterial({
            uniforms: {
                grassBrush: { value: whiteTex },
                cloudMap: { value: this.cloudTexture },
                groundSize: { value: 12.5 }
            },
            vertexShader: grassVert,
            fragmentShader: grassFrag,
            side: THREE.DoubleSide
        });

        const count = 30000;
        this.grassInstances = new THREE.InstancedMesh(
            bladeGeometry,
            this.grassMaterial,
            count
        );

        const matrix = new THREE.Matrix4();
        const position = new THREE.Vector3();
        const rotation = new THREE.Euler();
        const quaternion = new THREE.Quaternion();
        const scale = new THREE.Vector3();

        const size = 12.5;
        const centerX = 0;
        const centerZ = 0;
        const grassRadius = size * 0.25;
        const fadeRadius = size * 0.15;

        let instanceIndex = 0;
        for (let i = 0; i < count * 3; i++) {
            if (instanceIndex >= count) break;

            const x = (Math.random() - 0.5) * size;
            const z = (Math.random() - 0.5) * size;

            const dx = x - centerX;
            const dz = z - centerZ;
            const dist = Math.sqrt(dx * dx + dz * dz);

            let grassBlend = 0;
            if (dist < grassRadius) {
                grassBlend = 1;
            } else if (dist < grassRadius + fadeRadius) {
                const t = (dist - grassRadius) / fadeRadius;
                grassBlend = 1 - t;
            }

            if (Math.random() > grassBlend) continue;

            position.set(x, 0, z);
            rotation.set(0, Math.random() * Math.PI * 2, 0);
            quaternion.setFromEuler(rotation);
            const s = 0.6 + Math.random() * 0.5;
            scale.set(s, s, s);

            matrix.compose(position, quaternion, scale);
            this.grassInstances.setMatrixAt(instanceIndex, matrix);
            instanceIndex++;
        }

        this.grassInstances.count = instanceIndex;
        this.grassInstances.instanceMatrix.needsUpdate = true;
        this.scene!.add(this.grassInstances);
    }

    private onResize(): void {
        if (!this.container || !this.renderer || !this.camera) return;

        const width = this.container.clientWidth;
        const height = this.container.clientHeight;

        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(width, height);
    }

    render(): void {
        if (!this.renderer || !this.scene || !this.camera || !this.controls) return;

        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }

    dispose(): void {
        window.removeEventListener('resize', this.onResize.bind(this));

        if (this.renderer && this.container) {
            this.container.removeChild(this.renderer.domElement);
        }

        if (this.ground) {
            this.ground.geometry.dispose();
            if (this.groundMaterial) this.groundMaterial.dispose();
        }

        if (this.grassInstances) {
            this.grassInstances.geometry.dispose();
            if (this.grassMaterial) this.grassMaterial.dispose();
        }

        if (this.splatTexture) this.splatTexture.dispose();
        if (this.grassDetailTex) this.grassDetailTex.dispose();
        if (this.dirtDetailTex) this.dirtDetailTex.dispose();
        if (this.grassTexture) this.grassTexture.dispose();
        if (this.cloudTexture) this.cloudTexture.dispose();

        if (this.renderer) this.renderer.dispose();
    }
}
