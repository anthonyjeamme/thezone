import * as THREE from 'three';

export function buildRabbitModel(color: string): THREE.Group {
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color });

    const body = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), mat);
    body.scale.set(1, 0.8, 1.3);
    body.position.y = 0.06;
    body.castShadow = true;
    g.add(body);

    const headMat = new THREE.MeshLambertMaterial({ color: '#c0a080' });
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 6), headMat);
    head.position.set(0, 0.09, 0.07);
    head.castShadow = true;
    g.add(head);

    const earMat = new THREE.MeshLambertMaterial({ color: '#d4b896' });
    for (const side of [-1, 1]) {
        const ear = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.012, 0.06, 5), earMat);
        ear.position.set(side * 0.02, 0.15, 0.06);
        ear.rotation.z = side * 0.2;
        g.add(ear);
    }

    const tailMat = new THREE.MeshLambertMaterial({ color: '#e0d0c0' });
    const tail = new THREE.Mesh(new THREE.SphereGeometry(0.018, 6, 6), tailMat);
    tail.position.set(0, 0.06, -0.09);
    g.add(tail);

    return g;
}

export function buildDeerModel(color: string): THREE.Group {
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color });

    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.22, 8), mat);
    body.rotation.x = Math.PI / 2;
    body.position.set(0, 0.18, 0);
    body.castShadow = true;
    g.add(body);

    const headMat = new THREE.MeshLambertMaterial({ color: '#a08050' });
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 6), headMat);
    head.position.set(0, 0.24, 0.12);
    head.castShadow = true;
    g.add(head);

    const legMat = new THREE.MeshLambertMaterial({ color: '#7a5c32' });
    const legPositions = [
        { x: -0.04, z: 0.06 }, { x: 0.04, z: 0.06 },
        { x: -0.04, z: -0.06 }, { x: 0.04, z: -0.06 },
    ];
    for (const lp of legPositions) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.01, 0.14, 5), legMat);
        leg.position.set(lp.x, 0.07, lp.z);
        leg.castShadow = true;
        g.add(leg);
    }

    const antlerMat = new THREE.MeshLambertMaterial({ color: '#6b5030' });
    for (const side of [-1, 1]) {
        const antler = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.008, 0.08, 4), antlerMat);
        antler.position.set(side * 0.025, 0.30, 0.11);
        antler.rotation.z = side * 0.4;
        antler.rotation.x = -0.3;
        g.add(antler);

        const branch = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.005, 0.04, 4), antlerMat);
        branch.position.set(side * 0.04, 0.34, 0.10);
        branch.rotation.z = side * 0.8;
        g.add(branch);
    }

    return g;
}

export function buildFoxModel(color: string): THREE.Group {
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color });

    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.045, 0.16, 8), mat);
    body.rotation.x = Math.PI / 2;
    body.position.set(0, 0.1, 0);
    body.castShadow = true;
    g.add(body);

    const headMat = new THREE.MeshLambertMaterial({ color: '#d06020' });
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), headMat);
    head.position.set(0, 0.13, 0.09);
    head.castShadow = true;
    g.add(head);

    const snout = new THREE.Mesh(new THREE.ConeGeometry(0.015, 0.04, 6), headMat);
    snout.rotation.x = -Math.PI / 2;
    snout.position.set(0, 0.12, 0.12);
    g.add(snout);

    const earMat = new THREE.MeshLambertMaterial({ color: '#e07030' });
    for (const side of [-1, 1]) {
        const ear = new THREE.Mesh(new THREE.ConeGeometry(0.012, 0.03, 4), earMat);
        ear.position.set(side * 0.02, 0.17, 0.08);
        g.add(ear);
    }

    const tailMat = new THREE.MeshLambertMaterial({ color: '#e8a060' });
    const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.025, 0.1, 6), tailMat);
    tail.rotation.x = Math.PI / 2 + 0.5;
    tail.position.set(0, 0.1, -0.11);
    g.add(tail);

    const whiteTip = new THREE.Mesh(new THREE.SphereGeometry(0.012, 6, 6), new THREE.MeshLambertMaterial({ color: '#ffffff' }));
    whiteTip.position.set(0, 0.13, -0.15);
    g.add(whiteTip);

    const legMat = new THREE.MeshLambertMaterial({ color: '#2a2a2a' });
    for (const lp of [{ x: -0.025, z: 0.04 }, { x: 0.025, z: 0.04 }, { x: -0.025, z: -0.04 }, { x: 0.025, z: -0.04 }]) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.006, 0.08, 5), legMat);
        leg.position.set(lp.x, 0.04, lp.z);
        g.add(leg);
    }

    return g;
}

export function buildWolfModel(color: string): THREE.Group {
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color });

    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.06, 0.2, 8), mat);
    body.rotation.x = Math.PI / 2;
    body.position.set(0, 0.14, 0);
    body.castShadow = true;
    g.add(body);

    const headMat = new THREE.MeshLambertMaterial({ color: '#666677' });
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), headMat);
    head.position.set(0, 0.18, 0.11);
    head.castShadow = true;
    g.add(head);

    const snout = new THREE.Mesh(new THREE.ConeGeometry(0.02, 0.05, 6), headMat);
    snout.rotation.x = -Math.PI / 2;
    snout.position.set(0, 0.16, 0.15);
    g.add(snout);

    const earMat = new THREE.MeshLambertMaterial({ color: '#555566' });
    for (const side of [-1, 1]) {
        const ear = new THREE.Mesh(new THREE.ConeGeometry(0.015, 0.035, 4), earMat);
        ear.position.set(side * 0.025, 0.23, 0.10);
        g.add(ear);
    }

    const tailMat = new THREE.MeshLambertMaterial({ color: '#555566' });
    const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.025, 0.12, 6), tailMat);
    tail.rotation.x = Math.PI / 2 + 0.6;
    tail.position.set(0, 0.14, -0.13);
    g.add(tail);

    const legMat = new THREE.MeshLambertMaterial({ color: '#444455' });
    for (const lp of [{ x: -0.03, z: 0.05 }, { x: 0.03, z: 0.05 }, { x: -0.03, z: -0.05 }, { x: 0.03, z: -0.05 }]) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.01, 0.11, 5), legMat);
        leg.position.set(lp.x, 0.055, lp.z);
        g.add(leg);
    }

    return g;
}

export function buildAnimalModel(speciesId: string, color: string): THREE.Group {
    switch (speciesId) {
        case 'rabbit': return buildRabbitModel(color);
        case 'deer': return buildDeerModel(color);
        case 'fox': return buildFoxModel(color);
        case 'wolf': return buildWolfModel(color);
        default: return buildRabbitModel(color);
    }
}
