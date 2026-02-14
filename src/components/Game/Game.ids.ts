let nextId = 100;

export function generateEntityId(): string {
    return String(nextId++);
}
