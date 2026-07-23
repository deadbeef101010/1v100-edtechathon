export type Nickname = Readonly<{ display: string; normalized: string }>;

const DEFAULT_DENYLIST = Object.freeze(["damn", "idiot", "stupid"]);

export function normalizeNickname(nickname: string): Nickname {
  const display = nickname.normalize("NFKC").trim().replace(/\s+/g, " ");
  return Object.freeze({ display, normalized: display.toLocaleLowerCase("en-US") });
}

export function nicknameIsAllowed(
  nickname: Nickname,
  denylist: readonly string[] = DEFAULT_DENYLIST,
): boolean {
  const words = new Set(nickname.normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  return !denylist.some((denied) => words.has(denied.normalize("NFKC").toLocaleLowerCase("en-US")));
}

export function suggestNickname(display: string, unavailable: ReadonlySet<string>): string {
  for (let suffix = 2; suffix < 1_000; suffix += 1) {
    const suggestion = `${display.slice(0, 21)} ${suffix}`;
    if (!unavailable.has(normalizeNickname(suggestion).normalized)) {
      return suggestion;
    }
  }
  return "Quiz Star";
}
