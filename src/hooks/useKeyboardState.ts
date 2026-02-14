import { useEffect, useRef } from "react";

export function useKeyboardState(keys: string[]) {
    const keysDown = useRef<Set<string>>(new Set());

    useEffect(() => {
        function handleKeyDown(e: KeyboardEvent) {
            if (keys.includes(e.key)) {
                keysDown.current.add(e.key);
            }
        }

        function handleKeyUp(e: KeyboardEvent) {
            keysDown.current.delete(e.key);
        }

        window.addEventListener("keydown", handleKeyDown);
        window.addEventListener("keyup", handleKeyUp);

        return () => {
            window.removeEventListener("keydown", handleKeyDown);
            window.removeEventListener("keyup", handleKeyUp);
        };
    }, [keys]);

    return {
        isDown: (key: string) => keysDown.current.has(key),
    };
}