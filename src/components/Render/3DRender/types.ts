import * as THREE from 'three';

export type PlantPartDef = {
    geo: THREE.BufferGeometry;
    mat: THREE.MeshLambertMaterial;
    offsetY: number;
};

export type InteractTarget = {
    id: string;
    type: 'fruit' | 'plant';
    pos3: THREE.Vector3;
    pickDuration: number;
    label: string;
};
