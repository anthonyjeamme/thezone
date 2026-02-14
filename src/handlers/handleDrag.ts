type DragHandler = {
    onMove?: (event: DragEvent) => void
    onEnd?: (event: DragEvent) => void
}


type DragEvent = {
    button: number
    position: {
        x: number
        y: number
    }
    delta: {
        x: number
        y: number
    }
}

export function handleDrag<T extends HTMLElement>(
    callback: (event: DragEvent) => DragHandler | void | undefined | null
) {

    return {
        onPointerDown: (e: React.PointerEvent<T>) => {
            e.preventDefault()
            e.stopPropagation()

            const button = e.button
            const initialPosition = {
                x: e.clientX,
                y: e.clientY,
            }

            const handler = callback({
                button,
                position: initialPosition,
                delta: {
                    x: 0,
                    y: 0,
                }
            })

            if (!handler) return

            function handleMove(e: PointerEvent) {
                if (!handler) return
                const delta = {
                    x: e.clientX - initialPosition.x,
                    y: e.clientY - initialPosition.y,
                }

                handler.onMove?.({
                    button,
                    position: {
                        x: e.clientX,
                        y: e.clientY,
                    },
                    delta
                })
            }
            function handleEnd(e: PointerEvent) {
                if (!handler) return
                window.removeEventListener("pointermove", handleMove)
                window.removeEventListener("pointerup", handleEnd)
                window.removeEventListener("pointercancel", handleEnd)

                const delta = {
                    x: e.clientX - initialPosition.x,
                    y: e.clientY - initialPosition.y,
                }

                handler.onEnd?.({
                    button,
                    position: {
                        x: e.clientX,
                        y: e.clientY,
                    },
                    delta
                })
            }

            window.addEventListener("pointermove", handleMove)
            window.addEventListener("pointerup", handleEnd)
            window.addEventListener("pointercancel", handleEnd)

        }
    }
}