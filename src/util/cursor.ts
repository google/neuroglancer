export function createToolCursor() {
  const cursor = document.createElement("div");
  cursor.style.position = "fixed";
  cursor.style.pointerEvents = "none";
  cursor.style.border = "1px solid white";
  cursor.style.borderRadius = "50%";
  cursor.style.transform = "translate(-50%, -50%)";
  cursor.style.zIndex = "1000";
  document.body.appendChild(cursor);
  return cursor;
}

export function updateCursorPosition(
  cursor: HTMLDivElement,
  event: MouseEvent,
  radiusInPixels: number,
) {
  cursor.style.left = `${event.clientX}px`;
  cursor.style.top = `${event.clientY}px`;
  cursor.style.width = `${radiusInPixels * 2}px`;
  cursor.style.height = `${radiusInPixels * 2}px`;
}
