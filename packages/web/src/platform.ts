interface NavigatorWithPlatform extends Navigator {
  userAgentData?: { platform?: string };
}

const platformName = (): string => {
  const browserNavigator = navigator as NavigatorWithPlatform;
  return browserNavigator.userAgentData?.platform ?? navigator.platform ?? "";
};

export const isMacPlatform = /mac|iphone|ipad/i.test(platformName());

const MAC_MODIFIER_NAMES: Record<string, string> = { Ctrl: "Cmd", Alt: "Option" };

export const displayModifier = (name: string): string => (isMacPlatform ? MAC_MODIFIER_NAMES[name] ?? name : name);

export const displayBinding = (binding: string): string => binding.split("+").map(displayModifier).join("+");

export const displayShortcuts = (shortcuts: string): string => shortcuts.replace(/\b(Ctrl|Alt)\b/g, (name) => displayModifier(name));
