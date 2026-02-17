import * as THREE from 'three';
import type { LifeStage } from '../../World/types';
import { NPC_HEIGHT, NPC_WIDTH } from './constants';

export function createMinecraftCharacter(color: string, stage: LifeStage): THREE.Group {
    const group = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color });
    const skinMat = new THREE.MeshLambertMaterial({ color: '#ffdbac' });
    const h = NPC_HEIGHT[stage];
    const w = NPC_WIDTH[stage];

    const headSize = w * 0.8;
    const headGeo = new THREE.BoxGeometry(headSize, headSize, headSize);
    const head = new THREE.Mesh(headGeo, skinMat);
    head.position.y = h - headSize / 2;
    head.castShadow = true;
    group.add(head);

    const eyeMat = new THREE.MeshBasicMaterial({ color: '#222' });
    const eyeSize = headSize * 0.12;
    const eyeGeo = new THREE.BoxGeometry(eyeSize, eyeSize * 0.6, eyeSize * 0.3);
    const leftEye = new THREE.Mesh(eyeGeo, eyeMat);
    leftEye.position.set(-headSize * 0.2, h - headSize * 0.45, headSize / 2 + 0.01);
    group.add(leftEye);
    const rightEye = new THREE.Mesh(eyeGeo, eyeMat);
    rightEye.position.set(headSize * 0.2, h - headSize * 0.45, headSize / 2 + 0.01);
    group.add(rightEye);

    const bodyH = h * 0.35;
    const bodyW = w * 0.7;
    const bodyGeo = new THREE.BoxGeometry(bodyW, bodyH, bodyW * 0.6);
    const body = new THREE.Mesh(bodyGeo, mat);
    body.position.y = h - headSize - bodyH / 2;
    body.castShadow = true;
    group.add(body);

    const armH = bodyH * 0.9;
    const armW = bodyW * 0.25;
    const armGeo = new THREE.BoxGeometry(armW, armH, armW);
    const shoulderY = h - headSize;

    const leftArmPivot = new THREE.Group();
    leftArmPivot.position.set(-(bodyW / 2 + armW / 2), shoulderY, 0);
    leftArmPivot.name = 'leftArm';
    const leftArmMesh = new THREE.Mesh(armGeo, mat);
    leftArmMesh.position.y = -armH / 2;
    leftArmMesh.castShadow = true;
    leftArmPivot.add(leftArmMesh);
    group.add(leftArmPivot);

    const rightArmPivot = new THREE.Group();
    rightArmPivot.position.set(bodyW / 2 + armW / 2, shoulderY, 0);
    rightArmPivot.name = 'rightArm';
    const rightArmMesh = new THREE.Mesh(armGeo, mat);
    rightArmMesh.position.y = -armH / 2;
    rightArmMesh.castShadow = true;
    rightArmPivot.add(rightArmMesh);
    group.add(rightArmPivot);

    const legH = h - headSize - bodyH;
    const legW = bodyW * 0.35;
    const legGeo = new THREE.BoxGeometry(legW, legH, legW);
    const legMat = new THREE.MeshLambertMaterial({ color: '#5a3a1a' });
    const hipY = h - headSize - bodyH;

    const leftLegPivot = new THREE.Group();
    leftLegPivot.position.set(-legW * 0.6, hipY, 0);
    leftLegPivot.name = 'leftLeg';
    const leftLegMesh = new THREE.Mesh(legGeo, legMat);
    leftLegMesh.position.y = -legH / 2;
    leftLegMesh.castShadow = true;
    leftLegPivot.add(leftLegMesh);
    group.add(leftLegPivot);

    const rightLegPivot = new THREE.Group();
    rightLegPivot.position.set(legW * 0.6, hipY, 0);
    rightLegPivot.name = 'rightLeg';
    const rightLegMesh = new THREE.Mesh(legGeo, legMat);
    rightLegMesh.position.y = -legH / 2;
    rightLegMesh.castShadow = true;
    rightLegPivot.add(rightLegMesh);
    group.add(rightLegPivot);

    group.castShadow = true;
    return group;
}

export function animateWalk(group: THREE.Group, time: number, isMoving: boolean, sprint = false): void {
    const leftArm = group.getObjectByName('leftArm');
    const rightArm = group.getObjectByName('rightArm');
    const leftLeg = group.getObjectByName('leftLeg');
    const rightLeg = group.getObjectByName('rightLeg');

    if (!isMoving) {
        if (leftArm) leftArm.rotation.x = 0;
        if (rightArm) rightArm.rotation.x = 0;
        if (leftLeg) leftLeg.rotation.x = 0;
        if (rightLeg) rightLeg.rotation.x = 0;
        return;
    }

    const freq = sprint ? 14 : 8;
    const amp = sprint ? 0.85 : 0.6;
    const swing = Math.sin(time * freq) * amp;
    if (leftArm) leftArm.rotation.x = swing;
    if (rightArm) rightArm.rotation.x = -swing;
    if (leftLeg) leftLeg.rotation.x = -swing;
    if (rightLeg) rightLeg.rotation.x = swing;
}
