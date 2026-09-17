import type {ComponentType} from 'react';
import {Home, Puzzle, Settings} from 'lucide-react-native';
import type {Tab} from '../types';

/** Glass bar (64dp), plus 8dp of space above and below; excludes system insets. */
export const BOTTOM_NAV_HEIGHT = 80;

type TabIconProps = {
  size?: number | string;
  color?: string;
};

type TabItem = {
  label: Tab;
  icon: ComponentType<TabIconProps>;
};

export const TABS: TabItem[] = [
  {label: '控制台', icon: Home},
  {label: '插件', icon: Puzzle},
  {label: '设置', icon: Settings},
];
