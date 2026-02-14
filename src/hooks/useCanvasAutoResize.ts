import { useEffect } from "react";
import { useWindowResize } from "./useWindowResize";

export function useCanvasAutoResize(getCanvas: () => HTMLCanvasElement | null) {
    function resize() {
        const canvas = getCanvas();
        if (!canvas) return;
        const { width, height } = canvas.getBoundingClientRect();
        canvas.width = width;
        canvas.height = height;
    }


    useEffect(() => {
        resize()
    }, [])

    useWindowResize(resize);
}

