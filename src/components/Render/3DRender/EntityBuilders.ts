import * as THREE from 'three';
import type { BuildingEntity, ResourceEntity, CorpseEntity, FertileZoneEntity } from '../../World/types';
import { toWorld } from './utils';
import { SCALE } from './constants';

export function createCabinMesh(entity: BuildingEntity): THREE.Group {
    const group = new THREE.Group();
    const pos = toWorld(entity.position);

    const wallMat = new THREE.MeshLambertMaterial({ color: '#8B6914' });
    const wallGeo = new THREE.BoxGeometry(2, 1.5, 2);
    const walls = new THREE.Mesh(wallGeo, wallMat);
    walls.position.set(pos.x, 0.75, pos.z);
    walls.castShadow = true;
    walls.receiveShadow = true;
    group.add(walls);

    const roofGeo = new THREE.ConeGeometry(1.7, 1, 4);
    const roofMat = new THREE.MeshLambertMaterial({ color: '#5a3a1a' });
    const roof = new THREE.Mesh(roofGeo, roofMat);
    roof.position.set(pos.x, 2, pos.z);
    roof.rotation.y = Math.PI / 4;
    roof.castShadow = true;
    group.add(roof);

    const doorMat = new THREE.MeshLambertMaterial({ color: '#3e2507' });
    const doorGeo = new THREE.BoxGeometry(0.4, 0.7, 0.05);
    const door = new THREE.Mesh(doorGeo, doorMat);
    door.position.set(pos.x, 0.35, pos.z + 1.01);
    group.add(door);

    return group;
}

export function createResourceMesh(entity: ResourceEntity): THREE.Mesh {
    const pos = toWorld(entity.position);
    let mesh: THREE.Mesh;

    if (entity.resourceType === 'wood') {
        const trunkGeo = new THREE.CylinderGeometry(0.1, 0.12, 0.8, 6);
        const trunkMat = new THREE.MeshLambertMaterial({ color: '#5a3a1a' });
        const trunk = new THREE.Mesh(trunkGeo, trunkMat);
        trunk.position.set(pos.x, 0.4, pos.z);
        trunk.castShadow = true;

        const leavesGeo = new THREE.SphereGeometry(0.35, 6, 6);
        const leavesMat = new THREE.MeshLambertMaterial({ color: '#2d8c3e' });
        const leaves = new THREE.Mesh(leavesGeo, leavesMat);
        leaves.position.set(pos.x, 0.9, pos.z);
        leaves.castShadow = true;

        trunk.add(leaves);
        leaves.position.set(0, 0.5, 0);
        mesh = trunk;
    } else if (entity.resourceType === 'water') {
        const geo = new THREE.SphereGeometry(0.2, 8, 8);
        const mat = new THREE.MeshLambertMaterial({ color: '#00bcd4', transparent: true, opacity: 0.7 });
        mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(pos.x, 0.2, pos.z);
    } else {
        const geo = new THREE.SphereGeometry(0.15, 6, 6);
        const mat = new THREE.MeshLambertMaterial({ color: '#2ecc71' });
        mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(pos.x, 0.15, pos.z);
        mesh.castShadow = true;
    }

    return mesh;
}

export function createCorpseMesh(entity: CorpseEntity): THREE.Mesh {
    const pos = toWorld(entity.position);
    const geo = new THREE.BoxGeometry(0.6, 0.1, 0.3);
    const mat = new THREE.MeshLambertMaterial({ color: entity.color, transparent: true, opacity: 0.4 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(pos.x, 0.05, pos.z);
    return mesh;
}

export function createZoneMesh(entity: FertileZoneEntity): THREE.Mesh {
    const pos = toWorld(entity.position);
    const r = entity.radius * SCALE;
    const geo = new THREE.CircleGeometry(r, 32);
    const colorMap: Record<string, string> = { food: '#2ecc71', water: '#00bcd4', wood: '#8B6914' };
    const mat = new THREE.MeshBasicMaterial({
        color: colorMap[entity.resourceType] ?? '#888',
        transparent: true,
        opacity: 0.15,
        side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(pos.x, 0.02, pos.z);
    return mesh;
}
