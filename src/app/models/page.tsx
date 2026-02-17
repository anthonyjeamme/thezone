'use client'

import { ModelViewer } from '@/components/ModelViewer/ModelViewer'
import styles from './page.module.scss'

export default function ModelsPage() {
  return (
    <div className={styles.page}>
      <div className={styles.viewport}>
        <ModelViewer />
      </div>

      <header className={styles.header}>
        <div className={styles.titleGroup}>
          <span className={styles.title}>Model Viewer</span>
          <span className={styles.badge}>Bush</span>
        </div>
        <div className={styles.controls}>
          <span className={styles.controlHint}>
            <span className={styles.key}>LMB</span> Orbit
          </span>
          <span className={styles.controlHint}>
            <span className={styles.key}>RMB</span> Pan
          </span>
          <span className={styles.controlHint}>
            <span className={styles.key}>Scroll</span> Zoom
          </span>
        </div>
      </header>

      <footer className={styles.footer}>
        <div className={styles.info}>
          <span className={styles.infoPill}>
            <span className={styles.infoLabel}>Object</span>
            <span className={styles.infoValue}>Bush (26 planes)</span>
          </span>
          <span className={styles.infoPill}>
            <span className={styles.infoLabel}>Tris</span>
            <span className={styles.infoValue}>52</span>
          </span>
          <span className={styles.infoPill}>
            <span className={styles.infoLabel}>Textures</span>
            <span className={styles.infoValue}>3</span>
          </span>
        </div>
        <div className={styles.axes}>
          <span className={styles.axisX}>X</span>
          <span className={styles.axisY}>Y</span>
          <span className={styles.axisZ}>Z</span>
        </div>
      </footer>
    </div>
  )
}
