'use client';

import { useEffect, useRef } from 'react';
import { GroundRenderer } from './GroundRenderer';

export default function EnvironmentPage() {
    const containerRef = useRef<HTMLDivElement>(null);
    const rendererRef = useRef<GroundRenderer | null>(null);

    useEffect(() => {
        if (!containerRef.current) return;

        const renderer = new GroundRenderer();
        renderer.init(containerRef.current);
        rendererRef.current = renderer;

        const animate = () => {
            renderer.render();
            requestAnimationFrame(animate);
        };
        animate();

        return () => {
            renderer.dispose();
        };
    }, []);

    return (
        <div style={{ width: '100vw', height: '100vh', margin: 0, padding: 0 }}>
            <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
        </div>
    );
}
