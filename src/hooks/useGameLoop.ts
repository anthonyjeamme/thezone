import { useEffect, useRef } from "react";

export function useGameLoop(callback: (dt: number) => void, autoStart = false) {
    const requestRef = useRef<number | null>(null);
    const callbackRef = useRef(callback);
    const lastTimeRef = useRef<number>(0);

    useEffect(() => {
        callbackRef.current = callback;
    }, [callback]);

    function loop(time: number) {
        const dt = (time - lastTimeRef.current) / 1000;
        lastTimeRef.current = time;
        callbackRef.current(dt);
        requestRef.current = requestAnimationFrame(loop);
    }

    function start() {
        if (requestRef.current === null) {
            lastTimeRef.current = performance.now();
            requestRef.current = requestAnimationFrame(loop);
        }
    }

    function stop() {
        if (requestRef.current !== null) {
            cancelAnimationFrame(requestRef.current);
            requestRef.current = null;
        }
    }

    useEffect(() => {
        if (autoStart) 
            start();
        return () => stop();
    }, []);

    return {
        start,
        stop
    };
}