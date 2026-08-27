import {useColorScheme} from 'react-native';

export const lightColors = {
  background: '#FFF5F7',
  surface: '#FFFFFF',
  text: '#2B1F24',
  muted: '#8E6F78',
  border: '#F5DCE4',
  accent: '#FB7299',
  accentSoft: '#FFE3EC',
  success: '#16A34A',
  successSoft: '#E7F7EC',
  neutralSoft: '#F8EBEF',
  purple: '#7C3AED',
  purpleSoft: '#F0EAFE',
  orange: '#D97706',
  orangeSoft: '#FFF3DE',
  danger: '#DC2626',
  toast: '#2B1F24',
  toastText: '#FFFFFF',
  powerActive: '#FFD6E0',
  powerActiveBorder: '#FFB8C9',
};

export const darkColors = {
  background: '#1A1216',
  surface: '#251B20',
  text: '#F6F0F2',
  muted: '#A8929A',
  border: '#3A2931',
  accent: '#FF85A2',
  accentSoft: '#42232E',
  success: '#4ADE80',
  successSoft: '#183D2A',
  neutralSoft: '#2E2127',
  purple: '#B794F6',
  purpleSoft: '#35284D',
  orange: '#FBBF74',
  orangeSoft: '#45331F',
  danger: '#F87171',
  toast: '#F6F0F2',
  toastText: '#1A1216',
  powerActive: '#FFD6E0',
  powerActiveBorder: '#FFB8C9',
};

export type Colors = typeof lightColors;

export function useAppColors() {
  const dark = useColorScheme() === 'dark';
  const colors = dark ? darkColors : lightColors;
  return {colors, dark};
}
