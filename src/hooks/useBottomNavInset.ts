import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {BOTTOM_NAV_HEIGHT} from '../constants/navigation';

export function useBottomNavInset() {
  return BOTTOM_NAV_HEIGHT + useSafeAreaInsets().bottom;
}
