export const SKILL_CHECKED_AT = "2026-11-11";
/** Repository-wide GitHub stars, observed on the date above; not individual skill installs or ratings. */
export const SKILL_SOURCES = [
  {
    id: "anthropic",
    name: "Anthropic",
    repo: "anthropics/skills",
    commit: "2c5958ecac7cee2b583967a2c4981d0f4a75c579",
    stars: 191986,
    license: "항목별 라이선스",
  },
  {
    id: "scientific",
    name: "K-Dense · Scientific Skills",
    repo: "K-Dense-AI/scientific-agent-skills",
    commit: "2d2065fb4520fa3f3f2bcf61cff26ec8b7eba4b5",
    stars: 56714,
    license: "MIT",
  },
  {
    id: "orchestra",
    name: "Orchestra Research",
    repo: "Orchestra-Research/AI-Research-SKILLs",
    commit: "773a52944ba4747a18bd4ae9ade53fff041adcbc",
    stars: 14414,
    license: "MIT",
  },
  {
    id: "superpowers",
    name: "Superpowers",
    repo: "obra/superpowers",
    commit: "22f0b463e7a5e579904dd6211a520321035526f7",
    stars: 315548,
    license: "MIT",
  },
  {
    id: "openrig",
    name: "OpenRig",
    repo: "mvschwarz/openrig",
    commit: "5b6702add476d6ccc660d159531dda41ab2189de",
    stars: 8800,
    license: "Apache-2.0",
  },
  {
    id: "graft",
    name: "Graft → Trail-code",
    repo: "trailhq/Trail-Code",
    commit: "b22055dce3c3ff22722793ed0a5a3be4491a9140",
    stars: 11181,
    license: "MIT",
  },
] as const;
export type SkillSourceId = (typeof SKILL_SOURCES)[number]["id"];
export const skillSource = (id: SkillSourceId = "anthropic") =>
  SKILL_SOURCES.find((source) => source.id === id)!;
export const skillSourceUrl = (id?: SkillSourceId) =>
  `https://github.com/${skillSource(id).repo}`;
