export const legacyDiagramLayouts = ['strip', 'ledger', 'focus'] as const;
export const accountDiagramLayouts = ['timeline', 'spotlight', 'notebook-board', 'split-screen', 'terminal',
  'stack', 'orbit', 'rail', 'matrix', 'ribbon', 'flow', 'blueprint', 'flashcards', 'dashboard', 'storyboard'] as const;
export const diagramLayouts = [...legacyDiagramLayouts, ...accountDiagramLayouts] as const;
export const accountVisualThemes = ['paper', 'cobalt', 'mint', 'berry', 'phosphor', 'amber', 'lavender',
  'coral', 'ice', 'sand', 'forest', 'cyanotype', 'plum', 'slate', 'midnight'] as const;
export const visualThemes = ['aurora', 'sunset', 'ocean', 'violet', ...accountVisualThemes] as const;
export const conceptScenes = ['orbit', 'switchboard', 'grid', 'stage'] as const;
export const traceScenes = ['film', 'terminal', 'waterfall', 'split'] as const;
export const animatedScenes = [...conceptScenes, ...traceScenes] as const;
export type AnimatedScene = typeof animatedScenes[number];
export const illustrationKinds = ['steps', 'grid', 'tree', 'graph', 'stack', 'queue', 'window', 'search', 'sequence', 'decision'] as const;
export type IllustrationKind = typeof illustrationKinds[number];
export const sceneDirections = ['forward', 'reverse'] as const;
export const visualMotions = ['scan', 'pulse', 'slide', 'wipe', 'stamp'] as const;
export type AccountDiagramLayout = typeof accountDiagramLayouts[number];
export type VisualMotion = typeof visualMotions[number];
export type VisualTheme = typeof visualThemes[number];
export type VisualPalette = { background: string; surface: string; ink: string; muted: string; accent: string; selected: string; selectedInk: string; line: string };
export const accountPalettes: Record<typeof accountVisualThemes[number], VisualPalette> = {
  paper: { background: '#fff8eb', surface: '#ffffff', ink: '#29251f', muted: '#635b4f', accent: '#c24e00', selected: '#ffcf75', selectedInk: '#392500', line: '#c7bba7' },
  cobalt: { background: '#173cb1', surface: '#234cc8', ink: '#ffffff', muted: '#dce6ff', accent: '#ffe27b', selected: '#ffe27b', selectedInk: '#14234e', line: '#7194f1' },
  mint: { background: '#def5e9', surface: '#f7fff9', ink: '#123c30', muted: '#356854', accent: '#07694b', selected: '#147c58', selectedInk: '#ffffff', line: '#8ac5a8' },
  berry: { background: '#ffe5ef', surface: '#fff8fb', ink: '#681b3a', muted: '#92516b', accent: '#a90e50', selected: '#c21d64', selectedInk: '#ffffff', line: '#e4a4be' },
  phosphor: { background: '#07140c', surface: '#102319', ink: '#a7f4ad', muted: '#88b991', accent: '#bdff5e', selected: '#bdff5e', selectedInk: '#0c260d', line: '#37613f' },
  amber: { background: '#ffedbd', surface: '#fff9e9', ink: '#603500', muted: '#81632d', accent: '#9b4300', selected: '#ffad32', selectedInk: '#432700', line: '#dab770' },
  lavender: { background: '#efe9ff', surface: '#faf8ff', ink: '#34245d', muted: '#675388', accent: '#6740b4', selected: '#7951c9', selectedInk: '#ffffff', line: '#b9a6dd' },
  coral: { background: '#ffe4d7', surface: '#fff8f0', ink: '#702f22', muted: '#925b4b', accent: '#b43824', selected: '#ce4d35', selectedInk: '#ffffff', line: '#dfa18b' },
  ice: { background: '#e2f5ff', surface: '#f7fdff', ink: '#153c5b', muted: '#486d85', accent: '#0067a3', selected: '#087eb8', selectedInk: '#ffffff', line: '#93bed5' },
  sand: { background: '#eadbc5', surface: '#fff9ed', ink: '#483328', muted: '#715b4b', accent: '#864c28', selected: '#8d5b37', selectedInk: '#ffffff', line: '#b29a7c' },
  forest: { background: '#123d32', surface: '#1d5140', ink: '#f1ffe8', muted: '#bbd8b8', accent: '#d9f78d', selected: '#d9f78d', selectedInk: '#183b22', line: '#63947a' },
  cyanotype: { background: '#0a2960', surface: '#123873', ink: '#f0f8ff', muted: '#b7d5f5', accent: '#8ee8ff', selected: '#8ee8ff', selectedInk: '#0c3355', line: '#4c7cac' },
  plum: { background: '#4a174e', surface: '#63245f', ink: '#fff4e9', muted: '#eac5df', accent: '#ffd276', selected: '#ffd276', selectedInk: '#4a2343', line: '#a36e9d' },
  slate: { background: '#edf0f3', surface: '#ffffff', ink: '#253649', muted: '#536779', accent: '#304e6c', selected: '#365c7c', selectedInk: '#ffffff', line: '#9eb0be' },
  midnight: { background: '#111525', surface: '#20283c', ink: '#f1f4ff', muted: '#abb8d0', accent: '#85f6e4', selected: '#85f6e4', selectedInk: '#152e36', line: '#53627e' },
};

export function paletteForAccount(theme: VisualTheme): VisualPalette {
  if (theme in accountPalettes) return accountPalettes[theme as keyof typeof accountPalettes];
  return accountPalettes[({ aurora: 'midnight', sunset: 'plum', ocean: 'cyanotype', violet: 'lavender' } as const)[theme as 'aurora' | 'sunset' | 'ocean' | 'violet']];
}
