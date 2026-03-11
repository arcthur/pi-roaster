import type { TurnEnvelope } from "@brewva/brewva-runtime/channels";

export const DEFAULT_TELEGRAM_SKILL_NAME = "telegram";

export interface TelegramChannelSkillPolicyState {
  skillName: string;
  hasSkill: boolean;
  missingSkillNames: string[];
}

function normalizeSkillName(value: string | undefined, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

function normalizeAvailableSkillNames(
  availableSkillNames: Iterable<string> | undefined,
): Set<string> | null {
  if (!availableSkillNames) return null;
  const normalized = new Set<string>();
  for (const entry of availableSkillNames) {
    if (typeof entry !== "string") continue;
    const skillName = entry.trim();
    if (skillName.length > 0) {
      normalized.add(skillName);
    }
  }
  return normalized;
}

export function resolveTelegramChannelSkillPolicyState(
  input: {
    skillName?: string;
    availableSkillNames?: Iterable<string>;
  } = {},
): TelegramChannelSkillPolicyState {
  const skillName = normalizeSkillName(input.skillName, DEFAULT_TELEGRAM_SKILL_NAME);
  const availableSkillNames = normalizeAvailableSkillNames(input.availableSkillNames);
  const hasSkill = availableSkillNames ? availableSkillNames.has(skillName) : true;

  return {
    skillName,
    hasSkill,
    missingSkillNames: hasSkill ? [] : [skillName],
  };
}

export function buildChannelSkillPolicyBlock(
  turn: TurnEnvelope,
  state: TelegramChannelSkillPolicyState = resolveTelegramChannelSkillPolicyState(),
): string {
  if (turn.channel !== "telegram") {
    return "";
  }

  const lines = [
    "[Brewva Channel Skill Policy]",
    "Channel: telegram",
    `Primary channel skill: ${state.skillName}`,
  ];

  if (state.hasSkill) {
    lines.push(`Before composing a reply, call tool 'skill_load' with name='${state.skillName}'.`);
  } else {
    lines.push(
      `Telegram skill '${state.skillName}' is unavailable in the current skill registry; do not call it.`,
      "Fallback to plain-text response policy for this turn.",
    );
  }

  lines.push("Use the loaded skill to decide both message strategy and interactive payload shape.");
  return lines.join("\n");
}
