const NS = "http://www.w3.org/2000/svg";
const PALETTES = [
  ["#8ed2e5", "#ee5d36", "#10243f"],
  ["#f1bd48", "#168f82", "#111c2b"],
  ["#ee5d36", "#f3efe4", "#10243f"],
  ["#168f82", "#8ed2e5", "#111c2b"],
];

function seedValue(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function rectangle(svg, x, y, width, height, fill) {
  const pixel = document.createElementNS(NS, "rect");
  pixel.setAttribute("x", x);
  pixel.setAttribute("y", y);
  pixel.setAttribute("width", width);
  pixel.setAttribute("height", height);
  pixel.setAttribute("fill", fill);
  svg.append(pixel);
}

export function createAvatar(nickname, sessionSalt) {
  const normalized = nickname.normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
  let state = seedValue(`${sessionSalt}:${normalized}`) || 1;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  const palette = PALETTES[Math.floor(random() * PALETTES.length)];
  const svg = document.createElementNS(NS, "svg");
  svg.classList.add("pixel-avatar");
  svg.setAttribute("viewBox", "0 0 48 48");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  rectangle(svg, 0, 0, 48, 48, palette[2]);
  rectangle(svg, 8, 8, 32, 32, palette[1]);
  for (let row = 0; row < 5; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      if (random() > 0.48) {
        rectangle(svg, 8 + column * 6, 9 + row * 6, 6, 6, palette[0]);
        rectangle(svg, 34 - column * 6, 9 + row * 6, 6, 6, palette[0]);
      }
    }
  }
  rectangle(svg, 14, 20, 6, 6, palette[2]);
  rectangle(svg, 28, 20, 6, 6, palette[2]);
  rectangle(svg, 18, 32, 12, 3, palette[2]);
  return svg;
}
