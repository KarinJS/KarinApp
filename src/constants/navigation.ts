import type {ComponentType} from 'react';
import {Home, Puzzle, Settings} from 'lucide-react-native';
import type {Tab} from '../types';

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
