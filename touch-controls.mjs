// IDs follow the touch button table in the engine's SDL input code.
const controls = ["up", "down", "left", "right", "jump", "spin", "fire", "menu"];

export function createTouchControls(screen) {
  const device = matchMedia("(pointer: coarse)");
  const groups = [...screen.querySelectorAll(".touch-controls")];
  const pressed = new Map();
  const events = [];
  let active = false;

  function release(id) {
    const button = pressed.get(id);
    if (!button) return;
    pressed.delete(id);
    if ([...pressed.values()].includes(button)) return;
    button.classList.remove("pressed");
    events.push(-(controls.indexOf(button.dataset.control) + 1));
  }

  function releaseAll() {
    for (const id of pressed.keys()) release(id);
  }

  function update() {
    const show = active && device.matches;
    screen.classList.toggle("touch-enabled", show);
    for (const group of groups) group.hidden = !show;
    if (!show) releaseAll();
  }

  for (const button of screen.querySelectorAll("[data-control]")) {
    const input = controls.indexOf(button.dataset.control) + 1;
    button.addEventListener("pointerdown", event => {
      if (!active || !device.matches || event.button !== 0 || pressed.has(event.pointerId)) return;
      event.preventDefault();
      const alreadyPressed = [...pressed.values()].includes(button);
      button.setPointerCapture(event.pointerId);
      pressed.set(event.pointerId, button);
      if (alreadyPressed) return;
      button.classList.add("pressed");
      events.push(input);
    });
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
      button.addEventListener(type, event => release(event.pointerId));
    }
    button.addEventListener("contextmenu", event => event.preventDefault());
    button.addEventListener("click", event => {
      if (active && device.matches && event.detail === 0) events.push(input, -input);
    });
  }
  device.addEventListener("change", update);
  window.addEventListener("blur", releaseAll);
  window.addEventListener("pagehide", releaseAll);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) releaseAll();
  });

  return {
    setActive(enabled) {
      active = enabled;
      update();
    },
    nextButton() {
      return events.shift() || 0;
    },
  };
}
