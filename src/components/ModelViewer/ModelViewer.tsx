'use client'

import { useRef, useEffect, useCallback } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

interface ModelViewerProps {
  onReady?: () => void
}

export function ModelViewer({ onReady }: ModelViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  const setup = useCallback((container: HTMLElement) => {
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    })
    renderer.setSize(container.clientWidth, container.clientHeight)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.2
    container.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x12121a)
    scene.fog = new THREE.FogExp2(0x12121a, 0.035)

    const camera = new THREE.PerspectiveCamera(
      45,
      container.clientWidth / container.clientHeight,
      0.1,
      200,
    )
    camera.position.set(5, 3.5, 5)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.06
    controls.target.set(0, 0.5, 0)
    controls.minDistance = 1.5
    controls.maxDistance = 30
    controls.maxPolarAngle = Math.PI / 2 - 0.02
    controls.enablePan = true
    controls.panSpeed = 0.8
    controls.rotateSpeed = 0.7

    const ambient = new THREE.AmbientLight(0x3a3a5c, 0.8)
    scene.add(ambient)

    const hemi = new THREE.HemisphereLight(0x7799cc, 0x443322, 0.6)
    scene.add(hemi)

    const sun = new THREE.DirectionalLight(0xffeedd, 2.0)
    sun.position.set(6, 10, 6)
    sun.castShadow = true
    sun.shadow.mapSize.width = 4096
    sun.shadow.mapSize.height = 4096
    sun.shadow.camera.near = 0.5
    sun.shadow.camera.far = 40
    sun.shadow.camera.left = -10
    sun.shadow.camera.right = 10
    sun.shadow.camera.top = 10
    sun.shadow.camera.bottom = -10
    sun.shadow.bias = -0.0005
    sun.shadow.normalBias = 0.02
    scene.add(sun)

    const fill = new THREE.DirectionalLight(0x6688bb, 0.4)
    fill.position.set(-4, 5, -4)
    scene.add(fill)

    const rim = new THREE.DirectionalLight(0x8866aa, 0.3)
    rim.position.set(0, 3, -6)
    scene.add(rim)

    const groundGeo = new THREE.PlaneGeometry(60, 60)
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x1e1e2a,
      roughness: 0.92,
      metalness: 0.05,
    })
    const ground = new THREE.Mesh(groundGeo, groundMat)
    ground.rotation.x = -Math.PI / 2
    ground.receiveShadow = true
    scene.add(ground)

    const gridMain = new THREE.GridHelper(60, 60, 0x2a2a40, 0x1f1f30)
    gridMain.position.y = 0.002
    scene.add(gridMain)

    const gridSub = new THREE.GridHelper(20, 20, 0x3a3a55, 0x2a2a40)
    gridSub.position.y = 0.004
    scene.add(gridSub)

    const axesHelper = new THREE.AxesHelper(1.5)
    axesHelper.position.set(0, 0.006, 0)
    scene.add(axesHelper)

    const loader = new THREE.TextureLoader()
    const texPaths = [
      '/textures/tree-leefs-normal.png',
      '/textures/tree-leefs-light.png',
      '/textures/tree-leefs-dark.png',
    ]
    const textures = texPaths.map((p) => {
      const tex = loader.load(p)
      tex.colorSpace = THREE.SRGBColorSpace
      return tex
    })

    const leafMaterials = textures.map(
      (tex) =>
        new THREE.MeshStandardMaterial({
          map: tex,
          transparent: true,
          alphaTest: 0.5,
          side: THREE.DoubleSide,
          roughness: 0.8,
          metalness: 0.0,
          depthWrite: true,
        }),
    )

    const bush = new THREE.Group()

    const seededRandom = (seed: number) => {
      const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453
      return x - Math.floor(x)
    }

    const planeGeo = new THREE.PlaneGeometry(1, 1)
    const tempVec = new THREE.Vector3()
    const center = new THREE.Vector3(0, 0.6, 0)

    const puffs: {
      px: number
      py: number
      pz: number
      scale: number
      mat: number
    }[] = []

    for (let i = 0; i < 8; i++) {
      const theta = seededRandom(i) * Math.PI * 2
      const r = 0.55 + seededRandom(i + 10) * 0.25
      puffs.push({
        px: Math.cos(theta) * r,
        py: 0.35 + seededRandom(i + 20) * 0.2,
        pz: Math.sin(theta) * r,
        scale: 0.85 + seededRandom(i + 30) * 0.3,
        mat: i % 3,
      })
    }

    for (let i = 0; i < 7; i++) {
      const theta = seededRandom(i + 50) * Math.PI * 2
      const phi = seededRandom(i + 60) * Math.PI * 0.4
      const r = 0.35 + seededRandom(i + 70) * 0.3
      puffs.push({
        px: Math.cos(theta) * Math.sin(phi) * r,
        py: 0.7 + Math.cos(phi) * r * 0.6,
        pz: Math.sin(theta) * Math.sin(phi) * r,
        scale: 0.7 + seededRandom(i + 80) * 0.35,
        mat: Math.floor(seededRandom(i + 90) * 3),
      })
    }

    for (let i = 0; i < 5; i++) {
      const theta = seededRandom(i + 120) * Math.PI * 2
      const r = 0.15 + seededRandom(i + 130) * 0.2
      puffs.push({
        px: Math.cos(theta) * r,
        py: 1.0 + seededRandom(i + 140) * 0.3,
        pz: Math.sin(theta) * r,
        scale: 0.6 + seededRandom(i + 150) * 0.25,
        mat: i < 2 ? 1 : 0,
      })
    }

    for (let i = 0; i < 6; i++) {
      const theta = seededRandom(i + 200) * Math.PI * 2
      const r = 0.7 + seededRandom(i + 210) * 0.35
      puffs.push({
        px: Math.cos(theta) * r,
        py: 0.1 + seededRandom(i + 220) * 0.25,
        pz: Math.sin(theta) * r,
        scale: 0.75 + seededRandom(i + 230) * 0.3,
        mat: i < 3 ? 2 : 0,
      })
    }

    for (let idx = 0; idx < puffs.length; idx++) {
      const p = puffs[idx]
      const mesh = new THREE.Mesh(planeGeo, leafMaterials[p.mat])
      mesh.position.set(p.px, p.py, p.pz)

      tempVec.set(p.px - center.x, p.py - center.y, p.pz - center.z)
      if (tempVec.lengthSq() < 0.001) tempVec.set(0, 0, 1)
      tempVec.normalize()

      mesh.lookAt(p.px + tempVec.x * 2, p.py + tempVec.y * 2, p.pz + tempVec.z * 2)

      mesh.rotation.z += (seededRandom(idx + 300) - 0.5) * 0.4

      mesh.scale.setScalar(p.scale)
      mesh.castShadow = true
      mesh.receiveShadow = true
      bush.add(mesh)
    }

    scene.add(bush)

    const pmremGenerator = new THREE.PMREMGenerator(renderer)
    const envScene = new THREE.Scene()
    envScene.background = new THREE.Color(0x222233)

    const envLight1 = new THREE.PointLight(0x6688cc, 100, 0)
    envLight1.position.set(10, 10, 10)
    envScene.add(envLight1)

    const envLight2 = new THREE.PointLight(0xcc8866, 80, 0)
    envLight2.position.set(-10, 8, -10)
    envScene.add(envLight2)

    const envLight3 = new THREE.PointLight(0x8866cc, 60, 0)
    envLight3.position.set(0, -5, 10)
    envScene.add(envLight3)

    const envMap = pmremGenerator.fromScene(envScene, 0.04).texture
    scene.environment = envMap
    pmremGenerator.dispose()

    let frameId: number

    const animate = () => {
      frameId = requestAnimationFrame(animate)
      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    const onResize = () => {
      const w = container.clientWidth
      const h = container.clientHeight
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)
    }
    window.addEventListener('resize', onResize)

    onReady?.()

    return () => {
      cancelAnimationFrame(frameId)
      window.removeEventListener('resize', onResize)
      controls.dispose()
      renderer.dispose()
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement)
      }
    }
  }, [onReady])

  useEffect(() => {
    if (!containerRef.current) return
    return setup(containerRef.current)
  }, [setup])

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        outline: 'none',
      }}
    />
  )
}
